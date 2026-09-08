/**
 * Opt-in organiser authentication for mutating routes.
 *
 * The default is open, which is a deliberate demo posture rather than an oversight: the
 * dashboard and the test suite both drive mutations with no credentials, and requiring a
 * secret by default would mean the project does not run on clone. `REQUIRE_AUTH=true`
 * with a strong `ORGANIZER_SECRET` is the documented production setting.
 *
 * The comparison is constant-time **with respect to content**, which is the property that
 * matters. A naive `===` on a secret leaks its prefix through timing: an attacker measures
 * how long the mismatch takes and recovers the value one byte at a time. `timingSafeEqual`
 * removes that signal.
 *
 * It is not constant-time with respect to *length*. `timingSafeEqual` throws on unequal
 * buffer lengths, so the length is compared first and short-circuits — a wrong-length
 * secret is rejected without the constant-time path running at all. That leaks the
 * secret's length and nothing else, an acceptable trade for a value that should be
 * high-entropy anyway.
 *
 * Two distinct failures, deliberately: a missing header is 401 (you did not authenticate),
 * a wrong secret is 403 (you did, and you are not an organiser).
 *
 * Scope note: this authenticates the *caller as an organiser*. It does not establish which
 * volunteer a request speaks for. That question belongs to `middleware/identity.ts`, and the
 * answer depends on the mode: in `AUTH_MODE=required` the session cookie decides and a body
 * `volunteerId` naming somebody else is a 403, while in `legacy` the body field is still taken
 * at its word. This file predates that middleware and was the only gate for a while, which is
 * why it reads as though nothing else establishes identity. `docs/IDENTITY.md` covers the two
 * modes; the claimed-identity failures that came out of the legacy one are logged in
 * `docs/REVIEWS.md`.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { ApiError } from '../common/errors/apiError';

/**
 * Constant-time check of a presented organiser secret, independent of `REQUIRE_AUTH`.
 * Used by the claim-code bootstrap route, which must work before any session exists but
 * must never accept a wrong secret just because the legacy flag is off.
 *
 * Returns a boolean rather than throwing because its one caller, `organizerOrSecret` in
 * `auth.routes.ts`, has a third answer to give: no header at all is a 401, a wrong header is
 * a 403, and only the second of those is this function's `false`.
 */
export function organizerSecretMatches(presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(env.ORGANIZER_SECRET, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Opt-in organiser authentication for mutating routes.
 *
 * When `REQUIRE_AUTH=true`, callers must present the organiser secret in the
 * `X-Organizer-Secret` header. When false — the default, and always in tests — the middleware
 * passes through, so the open-demo API contract is preserved. Deployments handling real
 * attendance data should set `REQUIRE_AUTH=true` with a strong `ORGANIZER_SECRET`.
 *
 * The window in which this function actually refuses anybody is narrower than that reads, and
 * it is worth knowing before trusting it. Its only mount is `legacyMutationAuth` in `app.ts`,
 * which skips it on reads and in `AUTH_MODE=required`; and in `config/env.ts` a bare
 * `REQUIRE_AUTH=true` *resolves `AUTH_MODE` to `required`* as a deprecated alias. So setting
 * that one variable turns the gate off at the mount at the same moment it turns the body on.
 * The configuration where the header is genuinely demanded is both together and explicit —
 * `AUTH_MODE=legacy REQUIRE_AUTH=true` — which is the pre-M1 posture this is kept for.
 * Everywhere else the real gates are the session, role and kind checks in `identity.ts`.
 *
 * (This docblock previously sat two functions up, above `organizerSecretMatches`, where the
 * behaviour it described was not the behaviour of the function it was attached to.)
 */
export function requireOrganizerAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!env.REQUIRE_AUTH) {
    next();
    return;
  }
  const presented = req.headers['x-organizer-secret'];
  if (typeof presented !== 'string' || presented.length === 0) {
    next(ApiError.unauthorized('Organizer authentication required.'));
    return;
  }
  // Constant-time comparison to avoid secret-prefix oracles.
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(env.ORGANIZER_SECRET, 'utf8');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    next(ApiError.forbidden('Invalid organizer credentials.'));
    return;
  }
  next();
}
