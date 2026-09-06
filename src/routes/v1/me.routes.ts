/**
 * `/api/v1/me` — the signed-in account. M1 ships the account card; M5 adds shifts, quests,
 * inventory, stickers and presence preferences.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAccount } from '../../middleware/identity';
import { Volunteer } from '../../models/volunteer.model';
import { Registration } from '../../models/registration.model';
import { PowerUpInventory } from '../../models/powerup.model';
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

/**
 * The shifts this account holds, newest first, with just enough of each shift to render
 * the "next shift" card: title, venue, window, and the registration's own status.
 */
meRouter.get('/shifts', requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await Registration.find({ volunteerId: req.account!.id })
      .populate('shiftId', 'title description category location startTime endTime capacity filledSlots baseKarma')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const now = Date.now();
    const shifts = rows
      .filter((r) => r.shiftId)
      .map((r) => {
        const s = r.shiftId as unknown as { _id: unknown; title: string; location: string; startTime: Date; endTime: Date; category: string; baseKarma: number };
        return {
          registrationId: String(r._id),
          status: r.status,
          shiftId: String(s._id),
          title: s.title,
          location: s.location,
          category: s.category,
          baseKarma: s.baseKarma,
          startTime: s.startTime,
          endTime: s.endTime,
          startsInMs: new Date(s.startTime).getTime() - now,
          active: new Date(s.startTime).getTime() <= now && now <= new Date(s.endTime).getTime(),
        };
      });
    // The one the UI actually needs: the soonest shift that has not finished.
    const upcoming = shifts
      .filter((s) => new Date(s.endTime).getTime() > now && s.status !== 'CANCELLED')
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { shifts, next: upcoming[0] ?? null } });
  } catch (error) {
    next(error);
  }
});

/** Power-ups this account is holding. */
meRouter.get('/inventory', requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await PowerUpInventory.find({ volunteerId: req.account!.id }).lean();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: items.map((i) => ({ id: String(i._id), itemType: i.itemType, quantity: i.quantity, acquiredAt: i.createdAt })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The offline card (plan §C10). This is the ONLY response under /api that a service worker
 * may cache, so it holds nothing that would hurt if it were read from a shared device:
 * a short id, a display name, a faction and a sticker count. No email, no shift, no token.
 */
meRouter.get('/card', requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await Volunteer.findById(req.account!.id).select('name kind role faction karmaPoints badges prestigeTier').lean();
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.status(200).json({
      success: true,
      data: {
        shortId: String(account._id).slice(-6).toUpperCase(),
        displayName: account.name,
        kind: account.kind,
        role: account.role,
        faction: account.faction ?? 'NEUTRAL',
        karma: account.karmaPoints ?? 0,
        badges: (account.badges ?? []).length,
        tier: account.prestigeTier,
      },
    });
  } catch (error) {
    next(error);
  }
});
