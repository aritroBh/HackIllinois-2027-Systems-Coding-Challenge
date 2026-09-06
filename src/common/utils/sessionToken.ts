/**
 * Session token — the value inside the HttpOnly session cookie.
 *
 * `v1.<base64url(json payload)>.<hmac-sha256 hex>` signed with `SESSION_SECRET`. The
 * payload is `{ sub, sv, kind, exp }`: account id, the account's `sessionVersion` at mint
 * time, its kind, and an absolute expiry (ms). Stateless on purpose — no session
 * collection to lose on the in-memory demo database, and no per-request read on the hot
 * path. Revocation is `sessionVersion`: bumping it on the account makes every token minted
 * before the bump fail, and the identity middleware compares against a 60 s cache of
 * versions so a lost phone is logged out within a minute without a database read per
 * request.
 *
 * The same `timingSafeEqual` discipline as `crypto.ts`: the signature is verified before
 * anything in the payload is trusted, in constant time with respect to content.
 *
 * The CSRF nonce is derived here too: `HMAC(secret, 'csrf:' + sub + ':' + sv)`, base64url,
 * 32 chars. It is deterministic per (account, session version) so it can be recomputed on
 * every request and compared against the `X-CSRF-Token` header / WebSocket subprotocol
 * without storing it; rotating the session version rotates the nonce.
 */
import crypto from 'crypto';
import { env } from '../../config/env';

export const SESSION_TOKEN_VERSION = 'v1';
export const SESSION_TTL_MS = 48 * 60 * 60 * 1000;

export interface SessionPayload {
  sub: string;
  sv: number;
  kind: 'VOLUNTEER' | 'HACKER';
  exp: number;
}

export type SessionVerification =
  | { valid: true; payload: SessionPayload }
  | { valid: false; reason: 'MALFORMED' | 'INVALID_SIGNATURE' | 'EXPIRED' };

function sign(input: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

export function mintSessionToken(
  payload: Omit<SessionPayload, 'exp'> & { exp?: number },
  nowMs: number = Date.now(),
  secret: string = env.SESSION_SECRET
): string {
  const full: SessionPayload = { ...payload, exp: payload.exp ?? nowMs + SESSION_TTL_MS };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  const unsigned = `${SESSION_TOKEN_VERSION}.${body}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  nowMs: number = Date.now(),
  secret: string = env.SESSION_SECRET
): SessionVerification {
  if (!token) return { valid: false, reason: 'MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_TOKEN_VERSION) return { valid: false, reason: 'MALFORMED' };
  const [version, body, signature] = parts;
  const expected = sign(`${version}.${body}`, secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'INVALID_SIGNATURE' };
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { valid: false, reason: 'MALFORMED' };
  }
  if (
    typeof payload !== 'object' ||
    typeof payload.sub !== 'string' ||
    typeof payload.sv !== 'number' ||
    typeof payload.exp !== 'number' ||
    (payload.kind !== 'VOLUNTEER' && payload.kind !== 'HACKER')
  ) {
    return { valid: false, reason: 'MALFORMED' };
  }
  if (payload.exp <= nowMs) return { valid: false, reason: 'EXPIRED' };
  return { valid: true, payload };
}

/** Deterministic per (account, session version); rotates with the session version. */
export function csrfNonceFor(sub: string, sv: number, secret: string = env.SESSION_SECRET): string {
  return crypto.createHmac('sha256', secret).update(`csrf:${sub}:${sv}`).digest('base64url').slice(0, 32);
}

export function csrfNonceMatches(presented: string | undefined, sub: string, sv: number): boolean {
  if (!presented) return false;
  const expected = csrfNonceFor(sub, sv);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Cookie names. Production uses the `__Host-` prefix (browser enforces Secure + Path=/ +
 * no Domain); development drops the prefix and `Secure` so `npm run demo` and a LAN phone
 * work over plain http. `isProduction` is a parameter so tests can cover both branches.
 */
export function cookieNames(isProduction: boolean = env.NODE_ENV === 'production'): { session: string; csrf: string } {
  return isProduction ? { session: '__Host-nexus', csrf: '__Host-nexus_csrf' } : { session: 'nexus', csrf: 'nexus_csrf' };
}

export interface CookieOptionsShape {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export function sessionCookieOptions(isProduction: boolean = env.NODE_ENV === 'production'): CookieOptionsShape {
  return { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS };
}

export function csrfCookieOptions(isProduction: boolean = env.NODE_ENV === 'production'): CookieOptionsShape {
  // JS-readable on purpose: the client echoes it back in X-CSRF-Token (double submit).
  return { httpOnly: false, secure: isProduction, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS };
}

/** Minimal cookie header parser — enough for our two cookies, no dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    // First occurrence wins: browsers order cookies most-specific-path first, so a broader
    // duplicate planted by cookie tossing must not shadow the real one.
    if (out[key] !== undefined) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}
