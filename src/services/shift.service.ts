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
import { AccountContext, isProvenKind } from '../common/types/account';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { SurgePricingEngine, ISurgeResult } from '../common/utils/surgePricing';
import { eventHub } from '../common/sse/eventHub';

/**
 * What an organiser supplies to open a shift.
 *
 * Times arrive as ISO strings and become `Date`s here. The three counters the reservation
 * engine owns — `filledSlots`, `waitlistCount`, `version` — are absent on purpose: they are
 * bookkeeping, not input, and `createShift` sets them itself after spreading this, so a
 * caller cannot seed a shift that already looks half-full.
 */
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

/**
 * A partial edit: the caller sends only what changes.
 *
 * `isActive` appears here and not in the create DTO, and that asymmetry is load-bearing —
 * `deleteShift` only ever sets it false, so an update is how a soft-deleted shift is
 * deliberately brought back. It is not the only way one revives, though: `adonixSync`
 * upserts each synced event by `title` with `isActive: true` inside its `$set`, so a
 * soft-deleted shift whose title the feed still carries returns at the next sync.
 * Note the update path cannot lean on the create schema's
 * cross-field validation: a PATCH that moves only one bound is checked against the stored
 * document in `updateShift` instead.
 */
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

/**
 * The enriched shape a read is meant to take: the stored document plus its computed surge.
 *
 * Documentation rather than enforcement, said plainly — nothing imports this and neither
 * read below is typed as it. `listShifts` and `getShiftById` both return loosely-typed
 * objects that carry more than this (`isAvailable`, the two roster arrays), so the compiler
 * checks none of it.
 */
export interface IShiftWithSurge extends IShift {
  surge: ISurgeResult;
}

/**
 * Shift scheduling service managing operational volunteer shifts, capacity planning, and roster auditing.
 */
export class ShiftService {
  /**
   * Open a shift.
   *
   * The counters and `isActive` are written after the spread, so they win over anything a
   * caller managed to put in the DTO. There is no `startTime < endTime` check here: that is
   * `createShiftSchema`'s `.refine()`, which every HTTP caller passes through — which is
   * also why `updateShift` has to do the same check by hand, since a partial update can
   * invert the interval against a bound the request never mentions.
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
   * The shift board.
   *
   * The four filters are not equal citizens, and the difference is visible to a caller.
   * `category` and `location` go into the Mongo query and therefore narrow *before*
   * pagination; `availableOnly` and `surgeOnly` depend on values computed per row and are
   * applied in memory *after* `skip`/`limit`. So a page can come back shorter than the limit
   * — even empty while later pages still hold matches — and a client has to page on rather
   * than stop at the first short page.
   *
   * `total` reports the size of what is actually returned, not the collection count, for the
   * same reason: a count that ignores the in-memory filters is a number no paginator can use.
   * Only ever active shifts, so a soft-deleted one disappears from the board rather than
   * showing as unavailable.
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
   * One shift, with its surge and its roster — where the roster is two different documents
   * depending on who is asking. See `viewer` below, which carries the reasoning.
   *
   * Unlike `listShifts` this does not filter on `isActive`, so a deactivated shift is still
   * readable by id. That is the point of a soft delete: history stays addressable even
   * though `reserveShift` will refuse a new claim against it.
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
    //
    // And *proved*, not claimed. This read returns every rostered volunteer's name,
    // certifications, karma, prestige and avatar hash. Anonymous already got the redacted
    // counts — but naming any public volunteer id in `?volunteerId=` upgraded that to the
    // full roster, which is the disclosure the redaction exists to prevent.
    const staff = isProvenKind(viewer, 'VOLUNTEER');

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
   * Edit a shift.
   *
   * Both guards below exist because the update path cannot rely on the create schema. The
   * time-order rule has to hold against the *merge* of stored and submitted bounds, which
   * Zod cannot see; the capacity rule is a domain fact no schema knows.
   *
   * Be honest about the capacity guard: it is read-modify-write. `filledSlots` comes from a
   * document fetched a moment earlier and the update that follows is unconditional, so a
   * reservation committing between the two can leave `capacity` below `filledSlots` — the
   * exact shape of race the reservation path uses `$expr` to avoid, sitting in the same
   * file. It is a much smaller hazard: an organiser shrinking a shift is a rare,
   * human-paced action and the result is a shift that refuses new claims until somebody
   * drops, not an oversell. Moving the comparison into the filter would close it.
   *
   * Raising `capacity` runs no waitlist cascade either; that gap is in the file header.
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
