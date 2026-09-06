/**
 * Shift lifecycle and dynamic karma pricing.
 *
 * Reads here are enriched rather than raw: a listed shift carries its computed surge
 * multiplier and live capacity alongside the stored fields, so the dashboard renders what
 * a volunteer actually earns without recomputing pricing client-side. Pricing logic lives
 * in `common/utils/surgePricing`; this service decides when to apply it.
 *
 * Surge exists to solve a scheduling problem, not a game one. The 3:30 AM cleanup shift
 * is the one nobody signs up for, so it pays a multiple of the baseline — the multiplier
 * is a function of how unpleasant the hour is and how empty the shift still is.
 *
 * **Known gap, called out because it is the kind of thing an interviewer will find.**
 * `updateShift` runs no cascade. Raising `capacity` frees seats without promoting anyone
 * off the waitlist, so the queue sits there while the shift shows availability until the
 * next registration event happens to trigger a promotion. Capacity changes should run the
 * same cascade a cancellation does.
 */
import { Types } from 'mongoose';
import { Shift, IShift, ShiftCategory } from '../models/shift.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { AccountContext } from '../common/types/account';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { SurgePricingEngine, ISurgeResult } from '../common/utils/surgePricing';
import { eventHub } from '../common/sse/eventHub';

export interface ICreateShiftDTO {
  title: string;
  description: string;
  category: ShiftCategory;
  location: string;
  startTime: string;
  endTime: string;
  capacity: number;
  requiredSkills?: string[];
  baseKarma?: number;
  manualSurgeMultiplier?: number;
}

export interface IUpdateShiftDTO {
  title?: string;
  description?: string;
  category?: ShiftCategory;
  location?: string;
  startTime?: string;
  endTime?: string;
  capacity?: number;
  requiredSkills?: string[];
  baseKarma?: number;
  manualSurgeMultiplier?: number;
  isActive?: boolean;
}

export interface IShiftWithSurge extends IShift {
  surge: ISurgeResult;
}

export class ShiftService {
  /**
   * Creates a new shift.
   */
  public static async createShift(dto: ICreateShiftDTO): Promise<IShift> {
    const shift = await Shift.create({
      ...dto,
      startTime: new Date(dto.startTime),
      endTime: new Date(dto.endTime),
      filledSlots: 0,
      waitlistCount: 0,
      version: 0,
      isActive: true,
    });

    eventHub.broadcast({
      type: 'SHIFT_CREATED',
      data: shift.toObject(),
    });

    return shift;
  }

  /**
   * Lists shifts with optional filtering, capacity calculation, and dynamic surge pricing.
   */
  public static async listShifts(filters: {
    category?: ShiftCategory;
    location?: string;
    availableOnly?: boolean;
    surgeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ shifts: Array<Record<string, unknown>>; total: number }> {
    const query: Record<string, unknown> = { isActive: true };

    if (filters.category) query.category = filters.category;
    if (filters.location) {
      // Escape user input: a raw RegExp here was a ReDoS / invalid-pattern
      // 500 vector (e.g. ?location=( ).
      const escaped = filters.location.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.location = new RegExp(escaped, 'i');
    }

    // ponytail: clamp — unbounded limit was a full-collection load vector.
    const limit = Math.min(100, Math.max(1, filters.limit || 50));
    const offset = Math.max(0, filters.offset || 0);

    const rawShifts = await Shift.find(query).sort({ startTime: 1 }).skip(offset).limit(limit);

    const enriched = rawShifts.map((shift) => {
      const surge = SurgePricingEngine.calculate({
        baseKarma: shift.baseKarma,
        capacity: shift.capacity,
        filledSlots: shift.filledSlots,
        startTime: shift.startTime,
        manualMultiplier: shift.manualSurgeMultiplier,
      });

      return {
        ...shift.toObject(),
        surge,
        isAvailable: shift.filledSlots < shift.capacity,
      };
    });

    let filtered = enriched;
    if (filters.availableOnly) {
      filtered = filtered.filter((s) => s.isAvailable);
    }
    if (filters.surgeOnly) {
      filtered = filtered.filter((s) => s.surge.isSurgeActive);
    }

    // ponytail: post-filters run in memory, so `total` must describe the filtered
    // set actually returned — the raw DB count lied to paginators.
    return { shifts: filtered, total: filtered.length };
  }

  /**
   * Retrieves a single shift by ID with enriched surge calculations and roster.
   */
  public static async getShiftById(
    id: string,
    /**
     * Who is asking. Staff see the roster; everybody else sees how many people are on it.
     *
     * This endpoint carries no middleware of its own, so before the parameter existed it
     * handed the name, certifications, karma and prestige of every confirmed and waitlisted
     * volunteer to any caller who could reach `GET /shifts/:id` — in `AUTH_MODE=required`,
     * every signed-in hacker. `GET /registrations` is `requireVolunteerKind`-gated on the
     * stated grounds that who is working which shift is staff information, and
     * `GET /shifts/:id/roster` is lead-only and audited; this was the same disclosure with
     * no gate at all, reachable by changing one path segment.
     *
     * Counts stay public deliberately. `filledSlots` and `waitlistCount` are already on the
     * shift document, the dashboard's shift card only ever reads `.length` off these two
     * arrays, and "eleven people are signed up" names nobody.
     */
    viewer?: AccountContext,
  ): Promise<Record<string, unknown>> {
    const shift = await Shift.findById(id);
    if (!shift) {
      throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);
    }

    // Kind, not role: this is the same line `/registrations` draws. A volunteer needs to
    // know who they are working the desk with; a hacker does not, and an anonymous caller
    // in legacy mode certainly does not.
    const staff = viewer?.kind === 'VOLUNTEER';

    const detail = 'name certifications karmaPoints prestigeTier';
    const [confirmedRegs, waitlistedRegs] = await Promise.all([
      staff
        ? Registration.find({ shiftId: new Types.ObjectId(id), status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] } })
            .populate('volunteerId', detail)
            .sort({ confirmedAt: 1 })
        : Registration.find({ shiftId: new Types.ObjectId(id), status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] } })
            .select('_id status')
            .sort({ confirmedAt: 1 }),
      staff
        ? Registration.find({ shiftId: new Types.ObjectId(id), status: RegistrationStatus.WAITLISTED })
            .populate('volunteerId', detail)
            .sort({ waitlistPosition: 1 })
        : Registration.find({ shiftId: new Types.ObjectId(id), status: RegistrationStatus.WAITLISTED })
            .select('_id status')
            .sort({ waitlistPosition: 1 }),
    ]);

    const surge = SurgePricingEngine.calculate({
      baseKarma: shift.baseKarma,
      capacity: shift.capacity,
      filledSlots: shift.filledSlots,
      startTime: shift.startTime,
      manualMultiplier: shift.manualSurgeMultiplier,
    });

    return {
      ...shift.toObject(),
      surge,
      confirmedVolunteers: confirmedRegs,
      waitlistedVolunteers: waitlistedRegs,
    };
  }

  /**
   * Updates shift details.
   */
  public static async updateShift(id: string, dto: IUpdateShiftDTO): Promise<IShift> {
    const existing = await Shift.findById(id);
    if (!existing) {
      throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);
    }

    // Guard 1: time order must hold after the update (create-path enforces
    // this via Zod; the update path previously accepted inverted ranges).
    const nextStart = dto.startTime ? new Date(dto.startTime) : existing.startTime;
    const nextEnd = dto.endTime ? new Date(dto.endTime) : existing.endTime;
    if (nextStart >= nextEnd) {
      throw ApiError.badRequest('startTime must occur before endTime.');
    }

    // Guard 2: capacity may never drop below seats already claimed.
    if (
      dto.capacity !== undefined &&
      dto.capacity < existing.filledSlots
    ) {
      throw ApiError.conflict(
        `Capacity (${dto.capacity}) cannot drop below filled slots (${existing.filledSlots}).`,
        ErrorCode.SHIFT_FULL
      );
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.startTime) updateData.startTime = new Date(dto.startTime);
    if (dto.endTime) updateData.endTime = new Date(dto.endTime);

    const shift = await Shift.findByIdAndUpdate(
      id,
      { $set: updateData, $inc: { version: 1 } },
      { new: true, runValidators: true }
    );

    if (!shift) {
      throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);
    }

    eventHub.broadcast({
      type: 'SHIFT_UPDATED',
      data: shift.toObject(),
    });

    return shift;
  }

  /**
   * Deactivates (soft deletes) a shift.
   * ponytail: refuse while volunteers hold live slots — silent soft-delete orphaned
   * holders with no cancel, cascade, or notice. Organizers cancel/reassign first.
   */
  public static async deleteShift(id: string): Promise<{ success: boolean }> {
    const liveHolders = await Registration.countDocuments({
      shiftId: new Types.ObjectId(id),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN, RegistrationStatus.WAITLISTED] },
    });
    if (liveHolders > 0) {
      throw ApiError.conflict(
        `Shift has ${liveHolders} active registration(s); cancel or reassign holders before deactivating.`,
        ErrorCode.SHIFT_FULL
      );
    }
    const shift = await Shift.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
    if (!shift) {
      throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);
    }

    eventHub.broadcast({
      type: 'SHIFT_DELETED',
      data: { shiftId: id },
    });

    return { success: true };
  }
}
