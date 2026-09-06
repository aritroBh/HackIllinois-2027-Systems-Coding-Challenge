/**
 * Volunteer HTTP surface — create, list, fetch.
 *
 * `createVolunteer` destructures an explicit field list instead of spreading `req.body`,
 * which is the mass-assignment guard: `role`, `karmaPoints`, `prestigeTier` and `badges`
 * are server-owned and cannot be set at signup.
 *
 * Every response goes through `projectionFor`: contact details (email, phone) are visible to
 * lead+ only, and identities/sessionVersion are never returned to anyone. Reads are open in
 * `legacy` mode (the demo dashboard) and session-gated in `required` mode. Pagination on the
 * list is still open (plan M5).
 */
import { Request, Response, NextFunction } from 'express';
import { isLeadOrAbove } from '../common/types/account';
import { Volunteer, AccountKind, VolunteerRole } from '../models/volunteer.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

/**
 * Contact details and session metadata are visible to a signed-in lead+ only. Everyone else
 * (including the open legacy demo) gets the game-facing profile: name, role, kind, faction,
 * karma, badges.
 *
 * `source === 'session'` is the load-bearing half. In `legacy` mode `attachIdentity` believes
 * a `volunteerId` in the body or query, so a caller who named any lead's id — and the ids are
 * handed out by the public leaderboard — read every volunteer's email and phone number from
 * this route without holding a credential of any kind. `createVolunteer` below already makes
 * exactly this distinction for the desk's `kind` choice; the projection simply never got it.
 */
function projectionFor(req: Request): string {
  const role = req.account?.role;
  const lead =
    req.account?.source === 'session' &&
    (role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN');
  return lead ? '-identities -sessionVersion -__v' : '-email -phone -identities -sessionVersion -__v';
}

export class VolunteerController {
  public static async createVolunteer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // ponytail: picklist — `role` is never taken from the client (forced VOLUNTEER).
      const { name, email, phone, certifications } = req.body;
      // The desk may create a hacker account; everyone else gets a volunteer whatever they
      // send. `kind` and `role` move together — the model enforces that invariant too.
      const role = req.account?.role;
      const deskCanChoose = req.account?.source === 'session' && (role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN');
      const asHacker = deskCanChoose && req.body.kind === 'HACKER';
      const created = await Volunteer.create({
        name, email, phone, certifications,
        ...(asHacker ? { kind: AccountKind.HACKER, role: VolunteerRole.HACKER } : {}),
      });
      // Same projection as list/get: the created document must not echo identities or
      // sessionVersion either.
      const volunteer = await Volunteer.findById(created._id).select(projectionFor(req));
      res.status(201).json({ success: true, data: volunteer });
    } catch (error) {
      next(error);
    }
  }

  public static async listVolunteers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Volunteers only, unless the caller asks for everybody.
      //
      // This is the staff directory: it backs the roster pickers, the assignment dropdowns and
      // the war room's headcount. A thousand hacker accounts in it makes every one of those
      // unusable and makes the headcount wrong. `kind` is the axis for this — never `role` —
      // because the model's invariant ties them and `kind` is the one that means "is this
      // person staff".
      // `?kind=ALL` is lead-gated.
      //
      // The projection already strips contact details for a non-lead, so the exposure was
      // names and factions rather than anything sensitive — but a thousand hacker accounts
      // enumerable by any signed-in volunteer is a roster of the attendees, and nothing below
      // a lead has a reason to ask for it. A caller who asks anyway gets the default rather
      // than an error, because refusing a widening parameter is a worse experience than
      // quietly giving the answer they were entitled to.
      //
      // A *proved* lead, not a claimed one. `isLeadOrAbove` reads the role off
      // `req.account`, and in `AUTH_MODE=legacy` that context can come from a `volunteerId`
      // the caller put in the query string — so `?kind=ALL&volunteerId=<any lead's id>`
      // enumerated every attendee account, and account ids are public. `projectionFor`
      // already draws this distinction correctly; this line did not. The `source` check is
      // what makes the two agree.
      const asked = String(_req.query.kind ?? '').toUpperCase() === 'ALL';
      const includeHackers = asked && _req.account?.source === 'session' && isLeadOrAbove(_req.account);
      const filter = includeHackers ? {} : { kind: AccountKind.VOLUNTEER };
      const volunteers = await Volunteer.find(filter).select(projectionFor(_req)).sort({ createdAt: -1 });
      res.status(200).json({ success: true, data: volunteers });
    } catch (error) {
      next(error);
    }
  }

  public static async getVolunteerById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteer = await Volunteer.findById(req.params.id).select(projectionFor(req));
      if (!volunteer) {
        throw ApiError.notFound('Volunteer not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      }
      res.status(200).json({ success: true, data: volunteer });
    } catch (error) {
      next(error);
    }
  }
}
