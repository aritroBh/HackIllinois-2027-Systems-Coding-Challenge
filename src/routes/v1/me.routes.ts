/**
 * `/api/v1/me` — the signed-in account. M1 ships the account card; M5 adds shifts, quests,
 * inventory, stickers and presence preferences.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAccount, requireSession } from '../../middleware/identity';
import { Volunteer } from '../../models/volunteer.model';
import { Registration, RegistrationStatus } from '../../models/registration.model';
import { PowerUpInventory } from '../../models/powerup.model';
import { SOSTicket, SOSTicketStatus } from '../../models/sosTicket.model';
import { QuestService } from '../../services/quest.service';
import { StickerService } from '../../services/sticker.service';
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
    const profile = AuthService.toPublicAccount(account);
    // The email goes only to a caller who proved they are this account.
    //
    // In `legacy` mode an identity can be *claimed* rather than proved — `?volunteerId=<id>`
    // is believed — and the leaderboard hands out account ids anonymously. So "/me" for a
    // legacy caller is "somebody else's profile", and returning the email made this route an
    // address book keyed by a public id. Everything else here is game-facing and already
    // readable from the leaderboard, so the rest of the shape is unchanged.
    if (req.account!.source !== 'session') profile.email = null;
    // `no-store`, like every sibling route on this router.
    //
    // This one was the exception, and it is the route that carries the email. Express sends
    // an ETag and no cache directives, which makes the response *heuristically* cacheable:
    // on a shared laptop the next account's `GET /me` could be answered from disk with the
    // previous account's profile, without touching the network and therefore past the
    // handover's generation counter and every server-side guard. That is the same defect the
    // `/me/card` header just fixed; it was on two routes, not one.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { account: profile, source: req.account!.source } });
  } catch (error) {
    next(error);
  }
});

/**
 * The privacy toggle. Opting out is symmetric: the account stops publishing AND stops
 * receiving other players' positions (the session's interest computation returns nothing
 * for a client with no published position of its own).
 */
/*
 * `requireSession`: this writes to the account and evicts it from the presence store.
 *
 * On `requireAccount` alone, a legacy `?volunteerId=` was enough to set somebody else's
 * `presenceOptIn` to false, remove them from the store and drop their SSE session — a
 * one-request way to take any named person off the map, with no session and (because a
 * claimed identity is not a session) no CSRF check either.
 */
meRouter.patch('/presence', requireSession, requireAccount, validate(patchPresencePrefSchema), async (req: Request, res: Response, next: NextFunction) => {
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
/*
 * `requireSession`, for the same reason `/sos` has it.
 *
 * A shift is where a named person will be and when — venue, building, start and end. In the
 * shipped legacy posture an "account" can be a `?volunteerId=` in the query string and
 * account ids are public, so `GET /me/shifts?volunteerId=<anyone>` was a schedule and a
 * location history for a caller with no cookie. The earlier reasoning that only `/sos`
 * carried a position was too narrow: a rota is a position with a timetable attached.
 */
meRouter.get('/shifts', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
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
    // The one the UI actually needs: the soonest shift this volunteer can still turn up to.
    //
    // "Has not finished" is not the same as "is still theirs to work". A shift checked out of
    // at 11:30 keeps an `endTime` of 14:00, so it stayed at the head of this list and the Me
    // tab offered it as next — and the token button refuses a COMPLETED registration, so the
    // volunteer could not mint a token for the shift they were actually about to work until
    // the finished one's clock ran out. WAITLISTED does the same thing from the other end:
    // a place in a queue is not an assignment, and showing it as next hides the confirmed
    // shift behind it.
    //
    // `SWAP_PENDING` is in the set because it is schedule-occupying (see
    // `registration.model.ts`), and it is never written today — swaps rewrite the
    // registration in place. Whoever wires it up must change `CheckInService.generateToken`
    // and `verifyAndCheckIn` at the same time: both accept only CONFIRMED and CHECKED_IN, so
    // a shift offered as next here would refuse to mint a token at the desk. Checking in has
    // to cancel the pending swap as well, or the trade could hand the shift away underneath
    // an attendance row. Flagged by a reviewer as a live P1; it is unreachable until that
    // status is written, and is recorded here rather than fixed speculatively.
    const workable = new Set([RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN, RegistrationStatus.SWAP_PENDING]);
    const upcoming = shifts
      .filter((s) => new Date(s.endTime).getTime() > now && workable.has(s.status as RegistrationStatus))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { shifts, next: upcoming[0] ?? null } });
  } catch (error) {
    next(error);
  }
});

/** Power-ups this account is holding. */
/*
 * `requireSession`, like `/shifts` and `/sos` above.
 *
 * This is a self-read, and in `legacy` a "self" is `?volunteerId=<public id>` while the
 * leaderboard hands those ids to anonymous callers — so on `requireAccount` alone it answers
 * "what is in *that named person's* bag / quest log / sticker book" to anyone who asks, with
 * no session and no audit row. Two earlier rounds put this guard on the two siblings that
 * carry a location; these three carry the rest of the account's game state and were missed
 * because they read as harmless. The rule is about who is asking, not about which field.
 */
meRouter.get('/inventory', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
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
/*
 * `requireSession` for the same reason as its three siblings above. The card is the offline
 * trainer card — display name, short id, faction, karma, badges, prestige — keyed on an
 * account id, so on `requireAccount` alone it is a lookup table from a public id to a named
 * person's standing. The service worker's copy is written from an authenticated response and
 * purged on handover, so nothing offline depends on this being open.
 */
meRouter.get('/card', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await Volunteer.findById(req.account!.id).select('name kind role faction karmaPoints badges prestigeTier').lean();
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    // `no-store`, and the offline copy lives only in the service worker.
    //
    // `private, max-age=86400` was aimed at the offline card, and it put the response in the
    // browser's own HTTP cache for a day, keyed on the URL. `private` means "not a shared
    // proxy"; it does not partition by cookie, and nothing sends `Vary: Cookie`. So on a
    // shared laptop the next account's `GET /me/card` was answered from disk with the
    // previous account's card, without touching the network — past every guard, including the
    // handover's own generation counter, because it arrives inside the *new* user's request.
    // The service worker keeps its own copy for the offline card and `clearDeviceState`
    // purges that one on the way out; this header was buying a second, unpurgeable copy.
    res.setHeader('Cache-Control', 'no-store');
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

/**
 * The caller's own live SOS ticket, or null.
 *
 * `sos.routes.ts` has said since M5 that "a hacker's own ticket reaches them over the `me`
 * channel / GET /me", and it did not: no route carried it, and the hacker SOS view had
 * nothing to reconcile against. The consequences were not cosmetic. A hacker whose ticket was
 * resolved or cancelled while their tab was closed came back to a remembered ticket stuck at
 * DISPATCHED — a state with no Cancel (only OPEN may cancel) and no Clear (only a settled
 * ticket may be cleared) — and no further SSE would ever arrive for a ticket that had already
 * finished. No button, no escape, and no way to raise another call from that device.
 *
 * Full detail deliberately: this is the caller's own ticket, and the redaction on
 * `/sos/tickets` exists to keep one hacker from reading another's.
 *
 * **`requireSession`, not `requireAccount`** — the distinction the rest of this file draws
 * for a far smaller disclosure, and which this route missed when it was written. In the
 * shipped `AUTH_MODE=legacy` posture an "account" can be a `?volunteerId=` in the query
 * string, and account ids are public: the unauthenticated leaderboard hands them out. Gated
 * on `requireAccount`, `GET /me/sos?volunteerId=<anyone>` returned that person's live
 * `tableLocation` and `category` — where they are sitting right now and whether they called
 * for medical help — to a caller with no cookie and no audit row. Even `null` versus a
 * ticket is an oracle for whether somebody is in trouble.
 *
 * `GET /me` already nulls the email for a claimed identity and `listBeacons` already
 * withholds a cooldown from one; a live distress call is not the place to be looser than
 * either.
 */
meRouter.get('/sos', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ticket = await SOSTicket.findOne({
      createdById: req.account!.id,
      status: { $in: [SOSTicketStatus.OPEN, SOSTicketStatus.DISPATCHED, SOSTicketStatus.ACKNOWLEDGED, SOSTicketStatus.ON_SCENE] },
    })
      .sort({ createdAt: -1 })
      .lean();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: ticket
        ? {
            id: String(ticket._id),
            hackerName: ticket.hackerName,
            status: ticket.status,
            category: ticket.category,
            tableLocation: ticket.tableLocation,
            urgency: ticket.urgency,
            createdAt: ticket.createdAt,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

/** Quest progress for the current windows, and the sticker book. */
/*
 * `requireSession`, like `/shifts` and `/sos` above.
 *
 * This is a self-read, and in `legacy` a "self" is `?volunteerId=<public id>` while the
 * leaderboard hands those ids to anonymous callers — so on `requireAccount` alone it answers
 * "what is in *that named person's* bag / quest log / sticker book" to anyone who asks, with
 * no session and no audit row. Two earlier rounds put this guard on the two siblings that
 * carry a location; these three carry the rest of the account's game state and were missed
 * because they read as harmless. The rule is about who is asking, not about which field.
 */
meRouter.get('/quests', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const quests = await QuestService.forAccount(req.account!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: quests });
  } catch (error) {
    next(error);
  }
});

/*
 * `requireSession`, like `/shifts` and `/sos` above.
 *
 * This is a self-read, and in `legacy` a "self" is `?volunteerId=<public id>` while the
 * leaderboard hands those ids to anonymous callers — so on `requireAccount` alone it answers
 * "what is in *that named person's* bag / quest log / sticker book" to anyone who asks, with
 * no session and no audit row. Two earlier rounds put this guard on the two siblings that
 * carry a location; these three carry the rest of the account's game state and were missed
 * because they read as harmless. The rule is about who is asking, not about which field.
 */
meRouter.get('/stickers', requireSession, requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const owned = await StickerService.forAccount(req.account!.id);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: owned });
  } catch (error) {
    next(error);
  }
});
