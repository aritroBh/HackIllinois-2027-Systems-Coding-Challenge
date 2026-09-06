/**
 * Adonix (HackIllinois SSO) adapter — verify an Adonix token and map it to an account.
 *
 * Two verification paths, chosen by configuration:
 *
 *  - `ADONIX_JWT_SECRET` set → the token is an HS256 JWT; verify the signature locally and
 *    read `id`/`userId`, `email`, `roles`, `exp` from the payload. No network on the hot path.
 *  - otherwise → treat the token as opaque and exchange it: `GET ${ADONIX_URL}/user/` and
 *    `GET ${ADONIX_URL}/auth/roles/` with the token in `Authorization`, each bounded by a
 *    4 s timeout. Adonix down → the provider reports itself disabled and claim codes carry
 *    the event.
 *
 * `ADONIX_URL` comes from the environment only — never from a content pack — so a fork
 * cannot turn this server into an SSRF proxy by editing JSON.
 *
 * Role mapping is a closed table. An unknown Adonix role does not degrade to "hacker"; it
 * fails closed, because a mapping mistake here would either hand a hacker staff powers or
 * strip an organiser of theirs, and both are worse than a login error someone can report.
 */
import crypto from 'crypto';
import { env } from '../config/env';
import { ApiError } from '../common/errors/apiError';
import { AccountKind, VolunteerRole } from '../models/volunteer.model';

export interface AdonixIdentity {
  /** Adonix user id — the `identities.subject` for provider `adonix`. */
  subject: string;
  email?: string;
  name?: string;
  roles: string[];
}

export interface MappedRole {
  kind: AccountKind;
  role: VolunteerRole;
}

/** Closed mapping; anything else throws (fail closed). Highest privilege wins. */
export function mapAdonixRoles(roles: string[]): MappedRole {
  const upper = roles.map((r) => String(r).toUpperCase());
  if (upper.includes('ADMIN')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.ADMIN };
  if (upper.includes('STAFF')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.ORGANIZER };
  if (upper.includes('VOLUNTEER')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER };
  if (upper.includes('ATTENDEE') || upper.includes('USER')) return { kind: AccountKind.HACKER, role: VolunteerRole.HACKER };
  throw ApiError.forbidden(`Adonix roles [${roles.join(', ')}] have no mapping on this deployment.`);
}

export function adonixEnabled(): boolean {
  return env.ADONIX_ENABLED;
}

export function adonixStartUrl(): string {
  const redirect = `${env.PUBLIC_URL}/dashboard/auth/adonix`;
  return `${env.ADONIX_URL}/auth/login/github?redirect=${encodeURIComponent(redirect)}`;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** HS256 verification with a constant-time signature compare; no JWT dependency. */
export function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw ApiError.unauthorized('Malformed Adonix token.');
  const [h, p, s] = parts;
  let header: { alg?: string };
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8')) as { alg?: string };
  } catch {
    throw ApiError.unauthorized('Malformed Adonix token.');
  }
  if (header.alg !== 'HS256') throw ApiError.unauthorized('Unsupported Adonix token algorithm.');
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const presented = b64urlDecode(s);
  if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) {
    throw ApiError.unauthorized('Invalid Adonix token signature.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(p).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw ApiError.unauthorized('Malformed Adonix token.');
  }
  // A token that never expires is not a credential. `exp` must be a number, and in the future.
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw ApiError.unauthorized('Adonix token has no expiry.');
  if (payload.exp * 1000 <= Date.now()) throw ApiError.unauthorized('Adonix token expired.');
  return payload;
}

async function fetchJson(url: string, token: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { Authorization: token, Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw ApiError.unauthorized(`Adonix rejected the token (${res.status}).`);
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(503, 'PROVIDER_DISABLED' as never, 'Adonix is unreachable; use a badge claim code instead.');
  } finally {
    clearTimeout(timer);
  }
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export async function verifyAdonixToken(token: string): Promise<AdonixIdentity> {
  if (!adonixEnabled()) throw new ApiError(403, 'PROVIDER_DISABLED' as never, 'Adonix login is not enabled on this deployment.');
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) throw ApiError.unauthorized('Malformed Adonix token.');

  if (env.ADONIX_JWT_SECRET) {
    const payload = verifyHs256Jwt(token, env.ADONIX_JWT_SECRET);
    const subject = pickString(payload, 'id', 'userId', 'sub');
    if (!subject) throw ApiError.unauthorized('Adonix token carries no user id.');
    const roles = Array.isArray(payload.roles) ? (payload.roles as unknown[]).map(String) : [];
    return { subject, email: pickString(payload, 'email'), name: pickString(payload, 'name', 'displayName'), roles };
  }

  const user = await fetchJson(`${env.ADONIX_URL}/user/`, token);
  const subject = pickString(user, 'userId', 'id', 'sub');
  if (!subject) throw ApiError.unauthorized('Adonix returned no user id.');
  const rolesDoc = await fetchJson(`${env.ADONIX_URL}/auth/roles/`, token);
  const roles = Array.isArray(rolesDoc.roles) ? (rolesDoc.roles as unknown[]).map(String) : [];
  return { subject, email: pickString(user, 'email'), name: pickString(user, 'name', 'displayName'), roles };
}
