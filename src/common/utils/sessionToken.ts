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

/**
 * The format tag, checked before anything else is parsed. Bumping it invalidates every token
 * of the old shape at once without needing a `SESSION_SECRET` rotation — which is the point of
 * having it, since rotating the secret would also break the CSRF nonces of live sessions.
 */
export const SESSION_TOKEN_VERSION = 'v1';

/**
 * Forty-eight hours, chosen against the event rather than as a round number: the shipped pack
 * runs Friday 17:00 to Sunday 15:00, forty-six hours, so somebody who signs in as they arrive
 * is still signed in when they leave. A session expiring at 4 a.m. on the Saturday is a queue
 * at the help desk; one that outlives the event by two hours costs nothing, because revocation
 * is `sessionVersion` and does not wait for expiry.
 */
export const SESSION_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Everything a request needs to know about the caller without reading the database.
 *
 * Short names because this is base64'd into a cookie on every request. `sv` is the account's
 * `sessionVersion` at mint time and is the revocation lever; `kind` is here so the SSE hub and
 * the rate limiter can make a volunteer/hacker decision on a hot path. `role` is deliberately
 * **not** here — it changes more often than a session lives, and a stale ADMIN claim in a
 * cookie is exactly the thing that must not be believable.
 */
export interface SessionPayload {
  sub: string;
  sv: number;
  kind: 'VOLUNTEER' | 'HACKER';
  exp: number;
}

/**
 * A discriminated union rather than a nullable payload, so a caller cannot read `payload`
 * without having narrowed on `valid` first. The three reasons are distinguished for the logs;
 * every one of them is a 401 to the client, because telling somebody *why* their cookie failed
 * is telling an attacker which half of a forgery to fix.
 */
export type SessionVerification =
  | { valid: true; payload: SessionPayload }
  | { valid: false; reason: 'MALFORMED' | 'INVALID_SIGNATURE' | 'EXPIRED' };

/** Raw HMAC-SHA256 hex. Mint and verify share it, so there is one signer to audit. */
function sign(input: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

/**
 * Mint a token. The signature covers the version tag as well as the body, so a token cannot be
 * re-labelled as a different format.
 *
 * `exp` may be supplied, which is how tests mint an already-expired session; ordinary callers
 * omit it and get `now + SESSION_TTL_MS`. `nowMs` and `secret` are parameters for the same
 * reason and for a key rotation that has not been built.
 */
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

/**
 * Verify a cookie's token. Two orderings in here are load-bearing.
 *
 * **The signature is checked before the payload is parsed.** Everything after that point is
 * data this server signed, so the JSON parse is not parsing attacker input. Reversed, a
 * forged token would get its payload read — and any error message shaped by its contents — for
 * free.
 *
 * **Expiry is checked after the shape.** A token that is both malformed and expired reports
 * `MALFORMED`, which is the more useful of the two in a log.
 *
 * The field-by-field shape check is not paranoia about our own signature: it is what catches a
 * token from an *older format* signed with the *same secret*. That is the realistic way a
 * payload we signed can still fail to be a `SessionPayload`, and treating one as valid would
 * put `undefined` into an account id comparison.
 */
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

/**
 * The double-submit check. Constant-time, and length-guarded first because
 * `timingSafeEqual` throws rather than returning false on a length mismatch — an unguarded
 * call would turn a short header into a 500 instead of a rejection.
 */
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

/**
 * The literal types are the contract: `sameSite` and `path` are pinned so neither cookie can
 * be given different framing by accident, and both builders below return this same shape so
 * the session cookie and its CSRF partner cannot drift apart in scope or lifetime — a CSRF
 * cookie that outlives or under-lives its session is a logged-in user who cannot mutate
 * anything.
 */
export interface CookieOptionsShape {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

/**
 * `httpOnly` is what keeps the token out of reach of any script on the page, which is the
 * whole reason the session is a cookie rather than a header the client stores.
 *
 * `sameSite: 'lax'` rather than `'strict'`, and the cross-site protection is therefore not
 * this attribute: it is the CSRF nonce, which every mutation must echo and which no other
 * origin can read. Lax stops a cross-site POST carrying the cookie while still letting a
 * top-level navigation back from an identity provider land on a signed-in page.
 *
 * `maxAge` matches `SESSION_TTL_MS`, so the browser forgets the cookie at about the moment the
 * token inside it stops verifying — a stale cookie sent to a 401 is a worse experience than no
 * cookie sent to a login screen.
 */
export function sessionCookieOptions(isProduction: boolean = env.NODE_ENV === 'production'): CookieOptionsShape {
  return { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS };
}

/** Script-readable counterpart to `sessionCookieOptions`: the client echoes it as `X-CSRF-Token`. */
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
