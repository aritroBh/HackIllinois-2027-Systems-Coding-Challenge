/**
 * Shift CRUD HTTP surface.
 *
 * `DELETE` is a soft delete — it flips `isActive` rather than removing the document, so
 * historical registrations keep a valid reference and past shifts stay auditable.
 *
 * List responses are enriched with a computed surge multiplier per shift. That figure is
 * derived at read time from the current clock and fill level, so the same shift can
 * report different karma on two successive calls; it is an estimate shown to volunteers,
 * not the amount banked at check-out.
 */
import { Request, Response, NextFunction } from 'express';
import { ShiftService } from '../services/shift.service';
import { Shift } from '../models/shift.model';
import { Registration } from '../models/registration.model';
import { PresenceAudit } from '../models/presenceAudit.model';
import { presenceStore } from '../presence/store';
import { resolveVenueCoordinates } from '../common/utils/geo';
import { toLocal } from '../content/loader';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

/**
 * Controller providing shift scheduling, CRUD operations, roster inspection with presence auditing, and emergency broadcasts.
 */
export class ShiftController {
  /**
   * The lead's roster for one shift. Alongside each registration it reports how fresh that
   * volunteer's presence fix is and how far away they are — both as buckets, never as a
   * coordinate, because the lead needs "are they here yet?", not a position.
   *
   * Auditing: one document per view (plan §A4). The buckets name individual people, so the
   * view is a disclosure even though no number in it is exact.
   */
  public static async getRoster(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The route already requires a lead session. Checking again here is deliberate: this
      // handler discloses where named people are, and a future refactor that remounts it
      // should fail closed rather than quietly open.
      const role = req.account?.role;
      if (req.account?.source !== 'session' || !(role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN')) {
        throw new ApiError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'The roster is for shift leads.');
      }

      const shiftId = req.params.id as string;
      const shift = await Shift.findById(shiftId).lean();
      if (!shift) throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);

      const regs = await Registration.find({ shiftId })
        .populate('volunteerId', 'name kind role faction certifications karmaPoints avatarHash')
        .sort({ createdAt: 1 })
        .lean();

      const venue = shift.location ? resolveVenueCoordinates(shift.location) : null;
      const venueLocal = venue ? toLocal(venue.latitude, venue.longitude) : null;
      const now = Date.now();

      const ageBucket = (ms: number | null): string => {
        if (ms === null) return 'none';
        if (ms < 60_000) return 'now';
        if (ms < 5 * 60_000) return 'recent';
        return 'stale';
      };
      // 75 m is the geofence, 300 m is the interest radius: "at the venue", "nearby", "away".
      const distanceBucket = (m: number | null): string => {
        if (m === null) return 'unknown';
        if (m <= 75) return 'at venue';
        if (m <= 300) return 'nearby';
        return 'away';
      };

      const roster = regs
        .filter((r) => r.volunteerId)
        .map((r) => {
          const vol = r.volunteerId as unknown as { _id: unknown; name: string; kind: string; role: string; faction?: string | null; certifications?: string[]; karmaPoints?: number; avatarHash?: string | null };
          const entry = presenceStore.get(String(vol._id));
          const ageMs = entry ? now - entry.t : null;
          const distanceM = entry && venueLocal
            ? Math.hypot(entry.x - venueLocal.x, entry.z - venueLocal.z) * presenceStore.cfg.metersPerUnit
            : null;
          return {
            registrationId: String(r._id),
            volunteerId: String(vol._id),
            name: vol.name,
            kind: vol.kind,
            role: vol.role,
            faction: vol.faction ?? null,
            certifications: vol.certifications ?? [],
            karmaPoints: vol.karmaPoints ?? 0,
            avatarHash: vol.avatarHash ?? null,
            status: r.status,
            checkInTime: r.checkInTime ?? null,
            presence: { age: ageBucket(ageMs), distance: distanceBucket(distanceM), publishing: !!entry },
          };
        });

      await PresenceAudit.create({ readerId: req.account!.id, reason: 'roster', shiftId, subjectCount: roster.length, at: new Date(now) });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        success: true,
        data: {
          shift: { id: String(shift._id), title: shift.title, location: shift.location, startTime: shift.startTime, endTime: shift.endTime, capacity: shift.capacity, filledSlots: shift.filledSlots },
          counts: {
            confirmed: roster.filter((r) => r.status === 'CONFIRMED').length,
            checkedIn: roster.filter((r) => r.status === 'CHECKED_IN').length,
            waitlisted: roster.filter((r) => r.status === 'WAITLISTED').length,
            completed: roster.filter((r) => r.status === 'COMPLETED').length,
          },
          roster,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Creates a shift from an already-validated body. 201.
   *
   * Nothing is read off the session here — the route's role gate is the entire access
   * decision — and the whole body is handed to the service, which is safe only because
   * `validate` has already replaced `req.body` with the parsed result and stripped every
   * unknown key. The bounds in that schema are not cosmetic: capacity at most 500, base karma
   * 10–2000, manual surge multiplier 1.0–5.0. Creating a shift is creating the karma it will
   * pay, so an uncapped capacity or base is a farmable reward rather than a large shift.
   */
  public static async createShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.createShift(req.body);
      res.status(201).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The shift board. Two properties of the response will mislead a client that assumes
   * otherwise.
   *
   * `total` is not the size of the result set. `availableOnly` and `surgeOnly` are applied in
   * memory *after* the page has been fetched, so `total` counts what survived filtering on
   * this page and cannot drive a pager across the whole collection.
   *
   * The surge figure attached to each shift is computed at read time from the clock and the
   * current fill level, so two calls a minute apart can report different karma for the same
   * shift. It is an estimate shown to volunteers, not the amount banked at check-out.
   *
   * The `parseInt` calls are belt and braces rather than the defence: `listShiftsQuerySchema`
   * has already coerced both to bounded integers with defaults, so neither can arrive as
   * `NaN`. One quirk falls out of the ternaries — an `offset` of 0 is falsy and so reaches the
   * service as `undefined`, which it reads back as 0. Same answer, different route.
   */
  public static async listShifts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { category, location, availableOnly, surgeOnly, limit, offset } = req.query;
      const result = await ShiftService.listShifts({
        category: category as any,
        location: location as string,
        availableOnly: availableOnly === 'true',
        surgeOnly: surgeOnly === 'true',
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.status(200).json({ success: true, data: result.shifts, total: result.total });
    } catch (error) {
      next(error);
    }
  }

  /**
   * One shift, with its surge figure and — for a proved staff caller only — the name,
   * certifications, karma and prestige of everyone rostered on it.
   *
   * `req.account` is forwarded rather than checked, and that forwarding *is* the access
   * decision: this route carries no role middleware of its own, so `isProvenKind(viewer,
   * 'VOLUNTEER')` inside the service is the only thing standing between a caller and the
   * roster. Anonymous callers, hackers and legacy-claimed identities get ids and statuses
   * instead of people.
   *
   * The whole `AccountContext` goes across for that reason. Reduce it to an id and a role and
   * the `source` goes with it, which turns a claimed identity back into a staff read — the
   * exact failure this endpoint has already had once.
   */
  public static async getShiftById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.getShiftById(req.params.id as string, req.account);
      res.status(200).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Patches a shift. 200 with the updated document.
   *
   * The two guards a PATCH needs and a schema cannot give it are in the service. Time order
   * is re-checked against the stored bounds, because Zod can only compare two fields that
   * were both submitted and a single-bound patch can invert an interval on its own. And
   * capacity may not drop below `filledSlots`, which would otherwise oversell a shift by
   * shrinking it.
   *
   * Known gap, owned by the service's own docblock: raising `capacity` runs no waitlist
   * cascade, so the seats it frees sit unfilled and the queue sits behind them until some
   * later registration event happens to trigger a promotion.
   */
  public static async updateShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.updateShift(req.params.id as string, req.body);
      res.status(200).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Deactivates a shift. Soft: `isActive` is flipped and the document stays, so historical
   * registrations keep a valid reference and a finished shift is still auditable.
   *
   * It is not unconditional, which the word "delete" hides. The service counts CONFIRMED,
   * CHECKED_IN and WAITLISTED registrations first and answers 409 if it finds any, because a
   * silent soft-delete strands their holders with no cancellation, no cascade and no notice —
   * the organiser has to cancel or reassign them first. Only the empty case reaches the flip.
   */
  public static async deleteShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ShiftService.deleteShift(req.params.id as string);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
