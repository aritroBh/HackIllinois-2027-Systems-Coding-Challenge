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
import { Volunteer, AccountKind, VolunteerRole } from '../models/volunteer.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

/**
 * Contact details and session metadata are visible to lead+ only. Everyone else (including
 * the open legacy demo) gets the game-facing profile: name, role, kind, faction, karma, badges.
 */
function projectionFor(req: Request): string {
  const role = req.account?.role;
  const lead = role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN';
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
      const volunteers = await Volunteer.find().select(projectionFor(_req)).sort({ createdAt: -1 });
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
