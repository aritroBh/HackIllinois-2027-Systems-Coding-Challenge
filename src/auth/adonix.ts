/**
 * Adonix (HackIllinois SSO) adapter — verify an Adonix token and map it to an account.
 *
 * Two verification paths, chosen by configuration:
 *
 *  - `ADONIX_JWT_SECRET` set → the token is an HS256 JWT; verify the signature locally and
 *    read `id`/`userId`, `email`, `roles`, `exp` from the payload. No network on the hot path.
 *  - otherwise → treat the token as opaque and exchange it: `GET ${ADONIX_URL}/user/` and
 *    `GET ${ADONIX_URL}/auth/roles/` with the token in `Authorization`, each bounded by a
 *    4 s timeout. Adonix down → this exchange fails and answers `503` telling the caller to use
 *    a badge claim code, which keeps working. It does **not** report itself as a disabled
 *    provider: `adonixEnabled()` reads `env.ADONIX_ENABLED` and never probes upstream, so
 *    `providers()` goes on offering the button. An earlier version of this comment said
 *    otherwise.
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

/** The verified Adonix claims a login carries in: who, how to reach them, and what they may be. */
export interface AdonixIdentity {
  /** Adonix user id — the `identities.subject` for provider `adonix`. */
  subject: string;
  email?: string;
  name?: string;
  roles: string[];
}

/** A local account class, derived from an upstream role set. Always a coherent pair — see the model's kind/role invariant. */
export interface MappedRole {
  kind: AccountKind;
  role: VolunteerRole;
}

/**
 * Closed mapping; anything else throws (fail closed). Highest privilege wins.
 *
 * The order of the tests is the privilege ladder, so somebody holding both STAFF and
 * VOLUNTEER upstream gets ORGANIZER rather than whichever the array happened to list first.
 *
 * Worth knowing: `AuthService.adonixLogin` calls this and **discards the result**. It is
 * invoked for its throw — an unmapped role set is a 403 rather than a silent hacker account —
 * but a new Adonix account is always created as HACKER regardless of what upstream says. Staff
 * are made by organisers issuing claim codes and link Adonix afterwards, so an upstream role
 * claim can never mint staff on this deployment. If that changes, this is the function whose
 * return value starts mattering.
 */
export function mapAdonixRoles(roles: string[]): MappedRole {
  const upper = roles.map((r) => String(r).toUpperCase());
  if (upper.includes('ADMIN')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.ADMIN };
  if (upper.includes('STAFF')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.ORGANIZER };
  if (upper.includes('VOLUNTEER')) return { kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER };
  if (upper.includes('ATTENDEE') || upper.includes('USER')) return { kind: AccountKind.HACKER, role: VolunteerRole.HACKER };
  throw ApiError.forbidden(`Adonix roles [${roles.join(', ')}] have no mapping on this deployment.`);
}

/**
 * Whether to offer the button. Off by default: a deployment that has not been told about
 * Adonix should not advertise a login that will fail, and the two badge adapters need nothing.
 */
export function adonixEnabled(): boolean {
  return env.ADONIX_ENABLED;
}

/**
 * Where the browser goes to start an Adonix sign-in.
 *
 * The redirect target is built from `PUBLIC_URL`, which is this deployment's own origin, and
 * `ADONIX_URL` comes from the environment and never from a content pack — a pack is public and
 * fork-editable, and letting it name this host would make the server an SSRF proxy. The
 * `/auth/login/github` path is Adonix's own upstream identity provider, not ours; nothing here
 * talks to GitHub.
 */
export function adonixStartUrl(): string {
  const redirect = `${env.PUBLIC_URL}/dashboard/auth/adonix`;
  return `${env.ADONIX_URL}/auth/login/github?redirect=${encodeURIComponent(redirect)}`;
}

/** Node's base64url decoder is lenient — it ignores what it cannot decode rather than throwing — so every caller below re-validates what came out. */
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

/**
 * One bounded call to Adonix, with the two failure kinds kept apart.
 *
 * A non-2xx answer means Adonix looked at the token and said no, so it becomes a 401 the user
 * can act on. Anything else — DNS, connection refused, the 4-second abort — means we never
 * got an answer, so it becomes a 503 that names the badge-code fallback. Collapsing the two
 * would tell someone their credential is bad when the truth is that an upstream service is
 * down, and at an event that is the difference between "try your badge" and a queue at the
 * help desk.
 *
 * The timer is cleared in `finally` rather than after the await, so an early throw does not
 * leave a pending abort attached to a request that has already failed.
 */
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

/**
 * First non-empty string among the named keys. Adonix has spelled the user id `userId`, `id`
 * and `sub` across its own versions, and a claim that is present but empty is the same as
 * absent — a subject of `''` would otherwise become a real `identities.subject` that every
 * future token with the same defect matches.
 */
function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Turn an Adonix token into an identity, by whichever of the two paths this deployment is
 * configured for.
 *
 * The length bounds are re-checked here even though `adonixSchema` already applies them,
 * because this is also reachable from internal callers that never pass through Zod, and the
 * work downstream — an HMAC, or an outbound HTTP request with the token in a header — should
 * not be done for something that cannot be a token.
 *
 * Neither path trusts the token before verifying it. The local path checks the signature and
 * the expiry before reading a single claim; the remote path never reads the token at all and
 * asks Adonix what it means. A missing subject is refused rather than defaulted, because an
 * identity with no subject would link to whatever else has none.
 *
 * The two paths do not return the same fidelity of roles. The local path reads whatever
 * `roles` claim the JWT carries; the remote path makes a second call to `/auth/roles/`,
 * because Adonix's user document does not include them. That is two round trips per login and
 * is why the JWT secret path exists at all.
 */
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
