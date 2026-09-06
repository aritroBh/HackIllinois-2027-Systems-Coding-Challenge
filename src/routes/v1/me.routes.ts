/**
 * `/api/v1/me` — the signed-in account. M1 ships the account card; M5 adds shifts, quests,
 * inventory, stickers and presence preferences.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAccount } from '../../middleware/identity';
import { Volunteer } from '../../models/volunteer.model';
import { AuthService } from '../../services/auth.service';
import { presenceService } from '../../presence/service';
import { presenceStore } from '../../presence/store';
import { dropSseSession } from '../../presence/sseTransport';
import { patchPresencePrefSchema } from '../../schemas/presence.schema';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../common/errors/apiError';
import { ErrorCode } from '../../common/errors/errorCodes';

export const meRouter = Router();

meRouter.get('/', requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await Volunteer.findById(req.account!.id);
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), source: req.account!.source } });
  } catch (error) {
    next(error);
  }
});

/**
 * The privacy toggle. Opting out is symmetric: the account stops publishing AND stops
 * receiving other players' positions (the session's interest computation returns nothing
 * for a client with no published position of its own).
 */
meRouter.patch('/presence', requireAccount, validate(patchPresencePrefSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.account!.id;
    const optIn = req.body.optIn === true;
    const account = await Volunteer.findByIdAndUpdate(id, { $set: { presenceOptIn: optIn } }, { new: true });
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    presenceService.invalidate(id);
    if (!optIn) {
      presenceStore.remove(id);
      dropSseSession(id);
    }
    res.status(200).json({ success: true, data: { presenceOptIn: optIn } });
  } catch (error) {
    next(error);
  }
});
