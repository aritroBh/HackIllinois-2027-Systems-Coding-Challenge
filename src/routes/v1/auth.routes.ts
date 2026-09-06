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
import { requireAccount, requireRole } from '../../middleware/identity';
import { requireOrganizerAuth } from '../../middleware/requireAuth';
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
}
authRouter.post('/logout', AuthController.logout);

/**
 * Organiser gate that accepts either an ORGANIZER/ADMIN session or the organiser secret
 * header (the bootstrap path before any session exists).
 */
function organizerOrSecret(req: Request, res: Response, next: NextFunction): void {
  if (req.account && (req.account.role === 'ORGANIZER' || req.account.role === 'ADMIN')) {
    next();
    return;
  }
  if (typeof req.headers['x-organizer-secret'] === 'string') {
    // requireOrganizerAuth passes through when REQUIRE_AUTH is off; in that (legacy) case
    // the demo is open anyway, which matches the rest of the legacy contract.
    requireOrganizerAuth(req, res, next);
    return;
  }
  requireRole('ORGANIZER')(req, res, next);
}

authRouter.post('/claim-codes', organizerOrSecret, validate(issueClaimCodeSchema), AuthController.issueClaimCode);
authRouter.post('/claim-codes/bulk', organizerOrSecret, validate(issueClaimCodesBulkSchema), AuthController.issueClaimCodesBulk);
authRouter.post('/revoke/:id', requireAccount, requireRole('SHIFT_LEAD'), validate(revokeSchema), AuthController.revoke);
authRouter.patch('/accounts/:id/role', requireAccount, requireRole('ORGANIZER'), validate(setRoleSchema), AuthController.setRole);
