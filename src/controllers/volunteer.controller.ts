/**
 * Volunteer HTTP surface — create, list, fetch.
 *
 * `createVolunteer` destructures an explicit field list instead of spreading `req.body`,
 * which is the mass-assignment guard: `role`, `karmaPoints`, `prestigeTier` and `badges`
 * are server-owned and cannot be set at signup.
 *
 * `listVolunteers` currently returns full documents with no projection and no pagination,
 * including email and phone. It is also exempt from the mutation auth guard because it is
 * a GET, so it is readable in every posture — add a projection and a limit before this
 * carries real attendee data.
 */
import { Request, Response, NextFunction } from 'express';
import { Volunteer } from '../models/volunteer.model';
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
      const volunteer = await Volunteer.create({ name, email, phone, certifications });
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
