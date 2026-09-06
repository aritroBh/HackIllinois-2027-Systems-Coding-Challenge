/**
 * Identity routes — `/api/v1/auth`.
 *
 * Anonymous: `GET /providers`, `POST /claim`, `POST /magic-link`, `POST /magic`,
 * `POST /adonix`, and `POST /dev-login` — which is **not registered at all** in production
 * (no handler to probe). The credential exchanges sit behind `authExchangeLimiter`
 * (30/min/IP) on top of the global limiter.
 *
 * Organiser/lead: claim-code issuance, revocation and role changes. Issuance also accepts
 * the organiser secret header so a fresh deployment can print the first badge codes before
 * anyone has a session.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { AuthController } from '../../controllers/auth.controller';
import { validate } from '../../middleware/validate';
import { requireRole, requireSession } from '../../middleware/identity';
import { organizerSecretMatches } from '../../middleware/requireAuth';
import { ApiError } from '../../common/errors/apiError';
import { authExchangeLimiter } from '../../middleware/rateLimiter';
import { env } from '../../config/env';
import {
  issueClaimCodeSchema,
  issueClaimCodesBulkSchema,
  claimSchema,
  magicLinkSchema,
  magicRedeemSchema,
  adonixSchema,
  devLoginSchema,
  revokeSchema,
  setRoleSchema,
} from '../../schemas/auth.schema';

export const authRouter = Router();

authRouter.get('/providers', AuthController.providers);
authRouter.post('/claim', authExchangeLimiter, validate(claimSchema), AuthController.claim);
authRouter.post('/magic-link', authExchangeLimiter, validate(magicLinkSchema), AuthController.magicLink);
authRouter.post('/magic', authExchangeLimiter, validate(magicRedeemSchema), AuthController.magic);
authRouter.post('/adonix', authExchangeLimiter, validate(adonixSchema), AuthController.adonix);
if (env.NODE_ENV !== 'production') {
  authRouter.post('/dev-login', authExchangeLimiter, validate(devLoginSchema), AuthController.devLogin);
  // The demo's account picker: id/name/role/kind of the seeded accounts, highest rank first.
  authRouter.get('/dev-accounts', AuthController.devAccounts);
}
authRouter.post('/logout', AuthController.logout);

/**
 * Organiser gate that accepts either an ORGANIZER/ADMIN session or the organiser secret
 * header (the bootstrap path before any session exists).
 */
function organizerOrSecret(req: Request, _res: Response, next: NextFunction): void {
  // A *proved* organiser, not a claimed one.
  //
  // The refusal at the bottom of this function already says why: minting a claim code is
  // minting a real session for another account. But in `legacy` mode `attachIdentity`
  // believes a `volunteerId` in the body or query, so an anonymous caller who named an
  // organiser's id — public, from `GET /volunteers` or the leaderboard — satisfied this
  // branch, minted a code against an ADMIN account, and redeemed it. The guard was written
  // to stop exactly that and tested only against the anonymous case.
  if (
    req.account?.source === 'session' &&
    (req.account.role === 'ORGANIZER' || req.account.role === 'ADMIN')
  ) {
    next();
    return;
  }
  if (typeof req.headers['x-organizer-secret'] === 'string') {
    // Checked regardless of AUTH_MODE/REQUIRE_AUTH: this is the bootstrap path before any
    // session exists, so the secret itself is the whole gate.
    if (organizerSecretMatches(req.headers['x-organizer-secret'])) {
      next();
      return;
    }
    next(ApiError.forbidden('Invalid organizer credentials.'));
    return;
  }
  // Anything that reaches here has no secret and no proved session, so it is refused —
  // including a legacy-claimed identity, however senior the account it names.
  //
  // This used to fall through to `requireRole('ORGANIZER')`, which reads the role off
  // `req.account` without asking how that account was established. In `legacy` mode that is
  // a `volunteerId` the caller wrote themselves, so the check it delegated to was the one
  // thing it could not delegate to.
  next(
    req.account
      ? ApiError.forbidden('Minting claim codes needs a signed-in organiser session, not a claimed identity.')
      : ApiError.unauthorized('Organizer session or X-Organizer-Secret required.')
  );
}

// `authExchangeLimiter` (30/min/IP) on both, like every other route that takes a credential.
// These two accept `X-Organizer-Secret`, so an attacker guessing it was bounded only by the
// 600/min anonymous bucket — twenty times the budget the other credential routes allow, for
// the secret that mints claim codes.
authRouter.post('/claim-codes', authExchangeLimiter, organizerOrSecret, validate(issueClaimCodeSchema), AuthController.issueClaimCode);
authRouter.post('/claim-codes/bulk', authExchangeLimiter, organizerOrSecret, validate(issueClaimCodesBulkSchema), AuthController.issueClaimCodesBulk);
// `requireSession`, not `requireAccount`: both of these hand out or take away the ability to
// sign in as somebody, and in `legacy` mode `requireAccount` is satisfied by a `volunteerId`
// the caller simply asserted. Naming a lead's public id was enough to revoke an organiser, and
// naming an organiser's was enough to grant a role.
authRouter.post('/revoke/:id', requireSession, requireRole('SHIFT_LEAD'), validate(revokeSchema), AuthController.revoke);
authRouter.patch('/accounts/:id/role', requireSession, requireRole('ORGANIZER'), validate(setRoleSchema), AuthController.setRole);
