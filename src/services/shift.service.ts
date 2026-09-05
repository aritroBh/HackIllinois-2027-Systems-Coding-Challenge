import { Types } from 'mongoose';
import { Shift, IShift, ShiftCategory } from '../models/shift.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
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
    if (filters.location) query.location = new RegExp(filters.location, 'i');

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const [rawShifts, total] = await Promise.all([
      Shift.find(query).sort({ startTime: 1 }).skip(offset).limit(limit),
      Shift.countDocuments(query),
    ]);

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

    return { shifts: filtered, total };
  }

  /**
   * Retrieves a single shift by ID with enriched surge calculations and roster.
   */
  public static async getShiftById(id: string): Promise<Record<string, unknown>> {
    const shift = await Shift.findById(id);
    if (!shift) {
      throw ApiError.notFound('Shift not found.', ErrorCode.SHIFT_NOT_FOUND);
    }

    const [confirmedRegs, waitlistedRegs] = await Promise.all([
      Registration.find({ shiftId: new Types.ObjectId(id), status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] } })
        .populate('volunteerId', 'name email certifications karmaPoints prestigeTier')
        .sort({ confirmedAt: 1 }),
      Registration.find({ shiftId: new Types.ObjectId(id), status: RegistrationStatus.WAITLISTED })
        .populate('volunteerId', 'name email certifications karmaPoints prestigeTier')
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
   */
  public static async deleteShift(id: string): Promise<{ success: boolean }> {
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
