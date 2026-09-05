import { Types, ClientSession } from 'mongoose';
import crypto from 'crypto';
import { Shift, IShift } from '../models/shift.model';
import { Volunteer } from '../models/volunteer.model';
import { Registration, IRegistration, RegistrationStatus } from '../models/registration.model';
import { IdempotencyRecord, IdempotencyStatus } from '../models/idempotency.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';

const REST_BUFFER_MS = 30 * 60 * 1000; // Mandatory 30-minute rest buffer
const MAX_DAILY_HOURS_MS = 8 * 60 * 60 * 1000; // 8 hours max / calendar day

export interface IReserveShiftParams {
  shiftId: string;
  volunteerId: string;
  idempotencyKey?: string;
  allowWaitlist?: boolean;
}

export interface IReserveResult {
  registration: IRegistration;
  status: RegistrationStatus;
  waitlistPosition?: number | null;
  cached?: boolean;
}

export class RegistrationService {
  /**
   * High-concurrency atomic shift reservation engine.
   * Guarantees zero overbooking via atomic conditional updates ($expr), enforces rest buffers,
   * checks skill prerequisites, and overflows into an ordered FIFO waitlist if capacity is full.
   */
  public static async reserveShift(params: IReserveShiftParams): Promise<IReserveResult> {
    const { shiftId, volunteerId, allowWaitlist = true } = params;
    const idempotencyKey = params.idempotencyKey || `idem_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const requestHash = crypto.createHash('sha256').update(`RESERVE:${shiftId}:${volunteerId}`).digest('hex');

    // 1. Check Idempotency Store
    const existingIdem = await IdempotencyRecord.findOne({ key: idempotencyKey });
    if (existingIdem) {
      if (existingIdem.requestHash !== requestHash) {
        throw ApiError.conflict('Idempotency key re-used with different payload.', ErrorCode.IDEMPOTENCY_CONFLICT);
      }
      if (existingIdem.status === IdempotencyStatus.COMMITTED && existingIdem.responseBody) {
        return {
          ...(existingIdem.responseBody as IReserveResult),
          cached: true,
        };
      }
      if (existingIdem.status === IdempotencyStatus.PENDING) {
        throw ApiError.conflict('Identical reservation request currently in flight.', ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS);
      }
    }

    // Mark idempotency key as PENDING
    await IdempotencyRecord.findOneAndUpdate(
      { key: idempotencyKey },
      {
        $setOnInsert: {
          key: idempotencyKey,
          userId: volunteerId,
          endpoint: '/api/v1/registrations',
          requestHash,
          status: IdempotencyStatus.PENDING,
        },
      },
      { upsert: true }
    );

    try {
      // 2. Fetch and validate Shift & Volunteer
      const [shift, volunteer] = await Promise.all([
        Shift.findById(shiftId),
        Volunteer.findById(volunteerId),
      ]);

      if (!shift || !shift.isActive) {
        throw ApiError.notFound('Shift not found or is no longer active.', ErrorCode.SHIFT_NOT_FOUND);
      }
      if (!volunteer) {
        throw ApiError.notFound('Volunteer not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      }

      // 3. Invariant I2: Check if user already holds an active registration for this shift
      const existingActiveReg = await Registration.findOne({
        shiftId: new Types.ObjectId(shiftId),
        volunteerId: new Types.ObjectId(volunteerId),
        status: {
          $in: [
            RegistrationStatus.CONFIRMED,
            RegistrationStatus.WAITLISTED,
            RegistrationStatus.CHECKED_IN,
            RegistrationStatus.SWAP_PENDING,
          ],
        },
      });

      if (existingActiveReg) {
        throw ApiError.conflict(
          `Volunteer is already registered for this shift with status: ${existingActiveReg.status}.`,
          ErrorCode.ALREADY_REGISTERED
        );
      }

      // 4. Validate Skill Prerequisites
      if (shift.requiredSkills && shift.requiredSkills.length > 0) {
        const hasAllSkills = shift.requiredSkills.every((skill) =>
          volunteer.certifications.includes(skill)
        );
        if (!hasAllSkills) {
          throw ApiError.conflict(
            `Volunteer lacks required skill certifications: ${shift.requiredSkills.join(', ')}`,
            ErrorCode.MISSING_SKILL_CERTIFICATION,
            { requiredSkills: shift.requiredSkills, volunteerCertifications: volunteer.certifications }
          );
        }
      }

      // 5. Invariant I3: Schedule Interval Collision & 30-Minute Rest Buffer Check
      await this.assertNoScheduleConflicts(volunteerId, shift.startTime, shift.endTime);

      // 6. Concurrency-Safe Atomic Conditional Slot Claim
      // Evaluates `$expr: { $lt: ['$filledSlots', '$capacity'] }` directly on the storage engine
      const updatedShift = await Shift.findOneAndUpdate(
        {
          _id: new Types.ObjectId(shiftId),
          $expr: { $lt: ['$filledSlots', '$capacity'] },
        },
        {
          $inc: { filledSlots: 1, version: 1 },
        },
        { new: true }
      );

      let targetStatus: RegistrationStatus;
      let assignedWaitlistPos: number | null = null;

      if (updatedShift) {
        // Direct confirmed slot successfully claimed!
        targetStatus = RegistrationStatus.CONFIRMED;
      } else {
        // Capacity full -> Overflow to FIFO waitlist if permitted
        if (!allowWaitlist) {
          throw ApiError.conflict('Shift capacity is full and waitlist not requested.', ErrorCode.SHIFT_FULL);
        }

        targetStatus = RegistrationStatus.WAITLISTED;

        // Atomically increment waitlist count on shift
        const shiftWithWaitlist = await Shift.findByIdAndUpdate(
          shiftId,
          { $inc: { waitlistCount: 1, version: 1 } },
          { new: true }
        );

        assignedWaitlistPos = shiftWithWaitlist ? shiftWithWaitlist.waitlistCount : 1;
      }

      // 7. Persist Registration Record
      const registration = await Registration.create({
        shiftId: new Types.ObjectId(shiftId),
        volunteerId: new Types.ObjectId(volunteerId),
        status: targetStatus,
        waitlistPosition: assignedWaitlistPos,
        idempotencyKey,
        confirmedAt: targetStatus === RegistrationStatus.CONFIRMED ? new Date() : undefined,
      });

      const responsePayload: IReserveResult = {
        registration,
        status: targetStatus,
        waitlistPosition: assignedWaitlistPos,
        cached: false,
      };

      // 8. Commit Idempotency Record
      await IdempotencyRecord.updateOne(
        { key: idempotencyKey },
        {
          $set: {
            status: IdempotencyStatus.COMMITTED,
            responseStatusCode: 201,
            responseBody: responsePayload,
          },
        }
      );

      // 9. Emit Real-Time SSE Notification
      eventHub.broadcast({
        type: targetStatus === RegistrationStatus.CONFIRMED ? 'SLOT_RESERVED' : 'WAITLIST_JOINED',
        data: {
          shiftId,
          volunteerId,
          volunteerName: volunteer.name,
          status: targetStatus,
          waitlistPosition: assignedWaitlistPos,
          filledSlots: updatedShift ? updatedShift.filledSlots : shift.filledSlots,
          capacity: shift.capacity,
        },
      });

      return responsePayload;
    } catch (error) {
      // Mark idempotency key as FAILED on error
      await IdempotencyRecord.updateOne(
        { key: idempotencyKey },
        { $set: { status: IdempotencyStatus.FAILED } }
      );
      throw error;
    }
  }

  /**
   * Autonomous FIFO Waitlist Cascade Engine.
   * Cancels an existing registration and, if confirmed, automatically promotes
   * the head of the waitlist without manual organizer intervention.
   */
  public static async cancelRegistration(registrationId: string): Promise<{
    cancelled: IRegistration;
    promoted?: IRegistration | null;
  }> {
    const registration = await Registration.findById(registrationId);
    if (!registration) {
      throw ApiError.notFound('Registration not found.', ErrorCode.REGISTRATION_NOT_FOUND);
    }
    if (registration.status === RegistrationStatus.CANCELLED) {
      throw ApiError.badRequest('Registration is already cancelled.');
    }

    const shiftId = registration.shiftId.toString();
    const wasConfirmed =
      registration.status === RegistrationStatus.CONFIRMED ||
      registration.status === RegistrationStatus.CHECKED_IN;
    const oldWaitlistPos = registration.waitlistPosition;

    // 1. Mark target registration as CANCELLED
    registration.status = RegistrationStatus.CANCELLED;
    registration.cancelledAt = new Date();
    registration.waitlistPosition = null;
    await registration.save();

    let promotedRegistration: IRegistration | null = null;

    if (wasConfirmed) {
      // 2. Decrement filledSlots
      await Shift.findByIdAndUpdate(shiftId, {
        $inc: { filledSlots: -1, version: 1 },
      });

      // 3. FIFO Cascade: Find next eligible waitlist candidate
      const waitlistedCandidates = await Registration.find({
        shiftId: new Types.ObjectId(shiftId),
        status: RegistrationStatus.WAITLISTED,
      }).sort({ waitlistPosition: 1, createdAt: 1 });

      const shiftDoc = await Shift.findById(shiftId);

      for (const candidate of waitlistedCandidates) {
        if (!shiftDoc) break;

        // Verify candidate has no schedule conflicts
        let hasConflict = false;
        try {
          await this.assertNoScheduleConflicts(
            candidate.volunteerId.toString(),
            shiftDoc.startTime,
            shiftDoc.endTime,
            shiftId
          );
        } catch {
          hasConflict = true;
        }

        if (hasConflict) {
          // Skip candidate with conflict, mark as cancelled due to conflict, decrement waitlist
          candidate.status = RegistrationStatus.CANCELLED;
          candidate.cancelledAt = new Date();
          candidate.waitlistPosition = null;
          await candidate.save();
          await Shift.findByIdAndUpdate(shiftId, { $inc: { waitlistCount: -1 } });
          continue;
        }

        // Atomically promote candidate
        candidate.status = RegistrationStatus.CONFIRMED;
        candidate.confirmedAt = new Date();
        candidate.waitlistPosition = null;
        await candidate.save();

        promotedRegistration = candidate;

        // Increment filledSlots back and decrement waitlistCount
        await Shift.findByIdAndUpdate(shiftId, {
          $inc: { filledSlots: 1, waitlistCount: -1, version: 1 },
        });

        // Re-index remaining waitlist positions monotonically
        await this.reindexWaitlist(shiftId);
        break;
      }
    } else if (oldWaitlistPos !== null && oldWaitlistPos !== undefined) {
      // Cancelled record was waitlisted -> decrement waitlist count and reindex
      await Shift.findByIdAndUpdate(shiftId, {
        $inc: { waitlistCount: -1, version: 1 },
      });
      await this.reindexWaitlist(shiftId);
    }

    // 4. Emit SSE Broadcast
    eventHub.broadcast({
      type: 'REGISTRATION_CANCELLED',
      data: {
        registrationId,
        shiftId,
        wasConfirmed,
        promotedVolunteerId: promotedRegistration ? promotedRegistration.volunteerId : null,
      },
    });

    if (promotedRegistration) {
      const promotedVolunteer = await Volunteer.findById(promotedRegistration.volunteerId);
      eventHub.broadcast({
        type: 'WAITLIST_PROMOTED',
        data: {
          shiftId,
          volunteerId: promotedRegistration.volunteerId,
          volunteerName: promotedVolunteer ? promotedVolunteer.name : 'Volunteer',
          registrationId: promotedRegistration._id,
        },
      });
    }

    return {
      cancelled: registration,
      promoted: promotedRegistration,
    };
  }

  /**
   * Re-indexes waitlist positions to maintain contiguity Invariant I4.
   */
  private static async reindexWaitlist(shiftId: string): Promise<void> {
    const remaining = await Registration.find({
      shiftId: new Types.ObjectId(shiftId),
      status: RegistrationStatus.WAITLISTED,
    }).sort({ waitlistPosition: 1, createdAt: 1 });

    for (let i = 0; i < remaining.length; i++) {
      const targetPos = i + 1;
      if (remaining[i].waitlistPosition !== targetPos) {
        remaining[i].waitlistPosition = targetPos;
        await remaining[i].save();
      }
    }
  }

  /**
   * Asserts no schedule collision, enforces 30-minute rest buffer,
   * and enforces 8-hour max daily fatigue limit.
   */
  public static async assertNoScheduleConflicts(
    volunteerId: string,
    newStart: Date,
    newEnd: Date,
    excludeShiftId?: string,
    session?: ClientSession
  ): Promise<void> {
    const bufferedStart = new Date(newStart.getTime() - REST_BUFFER_MS);
    const bufferedEnd = new Date(newEnd.getTime() + REST_BUFFER_MS);

    // 1. Fetch user's active registrations
    const query: Record<string, unknown> = {
      volunteerId: new Types.ObjectId(volunteerId),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN, RegistrationStatus.SWAP_PENDING] },
    };

    if (excludeShiftId) {
      query.shiftId = { $ne: new Types.ObjectId(excludeShiftId) };
    }

    const activeRegs = await Registration.find(query)
      .populate('shiftId')
      .session(session || null);

    for (const reg of activeRegs) {
      const activeShift = reg.shiftId as unknown as IShift;
      if (!activeShift || !activeShift.startTime || !activeShift.endTime) continue;

      const shiftStart = new Date(activeShift.startTime);
      const shiftEnd = new Date(activeShift.endTime);

      // Collision condition with 30-minute buffer:
      // (shiftStart < newEnd + buffer) && (newStart - buffer < shiftEnd)
      const hasCollision = shiftStart < bufferedEnd && bufferedStart < shiftEnd;

      if (hasCollision) {
        const isDirectOverlap = newStart < shiftEnd && shiftStart < newEnd;
        const message = isDirectOverlap
          ? `Direct schedule conflict: Overlaps with confirmed shift "${activeShift.title}" (${shiftStart.toLocaleTimeString()} - ${shiftEnd.toLocaleTimeString()}).`
          : `Rest buffer conflict: Needs at least 30-minute rest buffer between shifts. Conflict with "${activeShift.title}" (${shiftStart.toLocaleTimeString()} - ${shiftEnd.toLocaleTimeString()}).`;

        throw ApiError.conflict(
          message,
          isDirectOverlap ? ErrorCode.SCHEDULE_CONFLICT : ErrorCode.SCHEDULE_BUFFER_CONFLICT,
          {
            conflictingShiftId: activeShift._id,
            conflictingShiftTitle: activeShift.title,
            requiredBufferMinutes: 30,
          }
        );
      }
    }

    // 2. Enforce Daily Fatigue Threshold (Max 8 hours / calendar day)
    const dayStart = new Date(newStart);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(newStart);
    dayEnd.setUTCHours(23, 59, 59, 999);

    let totalDurationMs = newEnd.getTime() - newStart.getTime();

    for (const reg of activeRegs) {
      const activeShift = reg.shiftId as unknown as IShift;
      if (!activeShift || !activeShift.startTime || !activeShift.endTime) continue;

      const sStart = new Date(activeShift.startTime);
      const sEnd = new Date(activeShift.endTime);

      if (sStart >= dayStart && sStart <= dayEnd) {
        totalDurationMs += sEnd.getTime() - sStart.getTime();
      }
    }

    if (totalDurationMs > MAX_DAILY_HOURS_MS) {
      const hours = (totalDurationMs / (1000 * 3600)).toFixed(1);
      throw ApiError.conflict(
        `Daily fatigue limit exceeded: Adding this shift brings total daily volunteer time to ${hours} hours (Max: 8.0 hours).`,
        ErrorCode.DAILY_FATIGUE_EXCEEDED,
        { totalHoursRequested: hours, maxDailyHoursAllowed: 8.0 }
      );
    }
  }

  /**
   * Lists registration records with filters.
   */
  public static async listRegistrations(filters: {
    shiftId?: string;
    volunteerId?: string;
    status?: RegistrationStatus;
  }): Promise<IRegistration[]> {
    const query: Record<string, unknown> = {};
    if (filters.shiftId) query.shiftId = new Types.ObjectId(filters.shiftId);
    if (filters.volunteerId) query.volunteerId = new Types.ObjectId(filters.volunteerId);
    if (filters.status) query.status = filters.status;

    return Registration.find(query)
      .populate('shiftId', 'title location startTime endTime category')
      .populate('volunteerId', 'name email role certifications karmaPoints prestigeTier')
      .sort({ createdAt: -1 });
  }
}
