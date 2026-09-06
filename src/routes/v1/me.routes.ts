/**
 * `/api/v1/me` — the signed-in account. M1 ships the account card; M5 adds shifts, quests,
 * inventory, stickers and presence preferences.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAccount } from '../../middleware/identity';
import { Volunteer } from '../../models/volunteer.model';
import { AuthService } from '../../services/auth.service';
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
