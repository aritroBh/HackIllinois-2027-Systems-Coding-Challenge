/**
 * Attendance — QR token verification, geofenced check-in, and karma-paying checkout.
 *
 * Three independent gates stand between a scan and a recorded attendance, and they defeat
 * three different attacks:
 *
 *  1. **The HMAC signature** proves the token was minted by this server and has not been
 *     edited. Covered in `common/utils/crypto`.
 *  2. **The time slice** defeats a screenshotted token: it is only valid for its own
 *     30-second window plus one slice of tolerance.
 *  3. **The geofence** defeats a token relayed to someone elsewhere: the scan must occur
 *     within 75 m of the venue, by Haversine distance against resolved coordinates.
 *
 * Coordinates are **unconditionally required** here, in every environment. There is no
 * flag to switch this off — `REQUIRE_GEOFENCE` governs gym battles only. Venue resolution
 * fails closed: a free-text location that matches no known venue is rejected rather than
 * defaulting to a permissive answer.
 *
 * Replay is checked at three points, and the order decides what a caller actually sees:
 *
 *  1. **The in-process nonce cache, first.** `verifyToken` runs before anything touches
 *     the database, so re-scanning a token this process has already consumed is rejected
 *     as `REPLAY_ATTACK_DETECTED` (409). This is the common case — a double scan at the
 *     desk gets a 409, not a 200 — and `tests/checkin.test.ts` pins it.
 *  2. **The already-checked-in short circuit.** Reached only when the cache does *not*
 *     hold the nonce: after a restart, or on another replica. There the existing check-in
 *     is returned unchanged rather than re-created. It awards nothing and writes nothing.
 *  3. **The unique index on `CheckIn.nonce`**, which stores the token's signed payload and
 *     is unique per token. This is the durable guarantee — it holds across restarts and
 *     replicas, where the in-process cache does not — and it is what catches a cold-cache
 *     replay for a volunteer who is not yet checked in.
 *
 * The cache is an optimisation that makes the common rejection cheap and gives it a clear
 * error; the index is what makes the guarantee true across processes.
 *
 * Checkout scales karma by time served, but be precise about the shape: the factor is
 * `min(1, minutesServed / 60)`, so it ramps linearly across the first hour and is flat
 * after that. Ten minutes pays a sixth; a full hour pays the whole award.
 *
 * That is an anti-farming measure, not a true pro-rata payout, and the difference is
 * visible on long shifts: an hour of a four-hour shift pays the same as all four. It
 * replaced a flat 0.5x floor that minted half a shift's karma for a sixty-second
 * check-in/check-out. Scaling against each shift's own scheduled duration would be the
 * more honest rule; it is listed as an open gap rather than changed quietly, because it
 * moves the karma economy for every existing record.
 *
 * **Known gap:** there is no shift time-window check, so a valid token can be redeemed
 * well outside the shift it belongs to. The token binds *who* and *which shift*, not
 * *when* relative to that shift.
 */
import { Types } from 'mongoose';
import { CheckIn, ICheckIn } from '../models/checkin.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Shift } from '../models/shift.model';
import { Volunteer, computePrestigeTier } from '../models/volunteer.model';
import { DynamicQrTokenEngine, IVerificationResult } from '../common/utils/crypto';
import { SurgePricingEngine } from '../common/utils/surgePricing';
import { GeoEngine, resolveVenue } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { sameId } from '../common/utils/id';


export class CheckInService {
  /**
   * Generates a dynamic 30-second HMAC QR token for a volunteer's shift.
   */
  public static async generateToken(volunteerId: string, shiftId: string): Promise<{
    token: string;
    expiresInSeconds: number;
    timeSlice: number;
  }> {
    const reg = await Registration.findOne({
      shiftId: new Types.ObjectId(shiftId),
      volunteerId: new Types.ObjectId(volunteerId),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
    });

    if (!reg) {
      throw ApiError.badRequest('Volunteer does not hold a confirmed spot for this shift.');
    }

    const now = Date.now();
    const token = DynamicQrTokenEngine.generateToken(volunteerId, shiftId, now);

    return {
      token,
      expiresInSeconds: 30 - (Math.floor(now / 1000) % 30),
      timeSlice: Math.floor(now / 1000 / 30),
    };
  }

  /**
   * Verifies an incoming dynamic QR code and marks attendance with optional geofence verification.
   */
  public static async verifyAndCheckIn(
    token: string,
    scannerId = 'DESK_SCANNER_MAIN',
    userCoordinates?: { latitude: number; longitude: number }
  ): Promise<{
    checkIn: ICheckIn;
    verification: IVerificationResult;
    geofenceStatus?: { distanceMeters: number; maxAllowedMeters: number; passed: boolean };
  }> {
    const verification = DynamicQrTokenEngine.verifyToken(token);

    if (!verification.valid) {
      if (verification.reason === 'EXPIRED') {
        throw ApiError.badRequest('QR token has expired (>30s old). Refresh your token.', { code: ErrorCode.TOKEN_EXPIRED });
      }
      if (verification.reason === 'REPLAY_ATTACK') {
        throw ApiError.conflict('Token replay attack detected: This QR token has already been scanned.', ErrorCode.REPLAY_ATTACK_DETECTED);
      }
      throw ApiError.badRequest(`Invalid QR token: ${verification.reason}`, { code: ErrorCode.MALFORMED_TOKEN });
    }

    const { volunteerId, shiftId } = verification;

    // Verify registration exists
    const reg = await Registration.findOne({
      shiftId: new Types.ObjectId(shiftId!),
      volunteerId: new Types.ObjectId(volunteerId!),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
    });

    if (!reg) {
      throw ApiError.notFound('Confirmed registration for this shift not found.', ErrorCode.REGISTRATION_NOT_FOUND);
    }

    const shift = await Shift.findById(shiftId);
    if (!shift) {
      throw ApiError.notFound('Shift not found.');
    }

    // Fail-closed: GPS coordinates are mandatory. Omitting them previously skipped
    // the 75m geofence entirely (remote fake check-in). The open-demo dashboard
    // sends Siebel coordinates; scanners must too.
    if (!userCoordinates) {
      throw ApiError.badRequest('GPS coordinates are required for geofenced check-in.', {
        code: ErrorCode.MISSING_REQUIRED_FIELD,
      });
    }

    let geofenceStatus: { distanceMeters: number; maxAllowedMeters: number; passed: boolean } | undefined;
    {
      // resolveVenue handles free-text locations ("Siebel Center Atrium");
      // the old exact-match lookup silently anchored them all to Siebel HQ.
      const venue = resolveVenue(shift.location);
      if (!venue.matched) {
        throw ApiError.badRequest(`Shift location "${shift.location}" maps to no known venue; check-in refused.`, {
          code: ErrorCode.MISSING_REQUIRED_FIELD,
        });
      }
      const geoCheck = GeoEngine.isWithinGeofence(userCoordinates, venue.coordinates, 75);
      geofenceStatus = {
        distanceMeters: geoCheck.distanceMeters,
        maxAllowedMeters: geoCheck.maxRadiusMeters,
        passed: geoCheck.allowed,
      };
      if (!geoCheck.allowed) {
        throw ApiError.forbidden(
          `Geofence Check-In Denied: You are ${geoCheck.distanceMeters}m away from ${shift.location} (Max allowed: 75m). Move closer to the check-in terminal.`
        );
      }
    }

    // Check if already checked in
    if (reg.status === RegistrationStatus.CHECKED_IN) {
      const existingCheckIn = await CheckIn.findOne({ registrationId: reg._id });
      if (existingCheckIn) {
        return { checkIn: existingCheckIn, verification, geofenceStatus };
      }
    }

    const nonce = token.split('.')[0];

    // Create CheckIn record. `nonce` is unique-indexed, so a cross-process or
    // post-restart replay that slips past the in-memory cache still fails here
    // and is reported as the replay attack it is (instead of a confusing
    // duplicate-key error).
    let checkIn;
    try {
      checkIn = await CheckIn.create({
        registrationId: reg._id,
        shiftId: new Types.ObjectId(shiftId),
        volunteerId: new Types.ObjectId(volunteerId),
        checkInTime: new Date(),
        nonce,
        verifiedBy: scannerId,
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 11000
      ) {
        throw ApiError.conflict(
          'Token replay attack detected: This QR token has already been scanned.',
          ErrorCode.REPLAY_ATTACK_DETECTED
        );
      }
      throw error;
    }

    // Update registration status
    reg.status = RegistrationStatus.CHECKED_IN;
    reg.checkInTime = new Date();
    await reg.save();

    const vol = await Volunteer.findById(volunteerId);

    eventHub.broadcast({
      type: 'VOLUNTEER_CHECKED_IN',
      data: {
        volunteerId,
        volunteerName: vol ? vol.name : 'Volunteer',
        shiftId,
        shiftTitle: shift.title,
        checkInTime: checkIn.checkInTime,
        geofenceVerified: Boolean(userCoordinates),
      },
    });

    return { checkIn, verification, geofenceStatus };
  }

  /**
   * Concludes a shift check-out, calculates hours, and applies dynamic karma multiplier.
   * ponytail: owner-bound + CAS — only the checked-in volunteer checks out, concurrent
   * check-outs can't double-pay, karma/hours credit via $inc (no read-modify-write loss).
   */
  public static async checkOut(checkInId: string, callerVolunteerId?: string): Promise<ICheckIn> {
    const existing = await CheckIn.findById(checkInId);
    if (!existing) {
      throw ApiError.notFound('CheckIn record not found.');
    }
    if (!callerVolunteerId) {
      throw ApiError.badRequest('volunteerId (checked-in volunteer) is required to check out.');
    }
    if (!sameId(existing.volunteerId, callerVolunteerId)) {
      throw ApiError.forbidden('Only the checked-in volunteer may check out this shift.');
    }
    if (existing.checkOutTime) {
      return existing; // idempotent replay
    }

    const now = new Date();

    // CAS the open check-in closed; a concurrent check-out wins, the loser re-reads it as done.
    const checkIn = await CheckIn.findOneAndUpdate(
      { _id: checkInId, checkOutTime: { $exists: false } },
      { $set: { checkOutTime: now } },
      { new: true }
    );
    if (!checkIn || checkIn.checkOutTime?.getTime() !== now.getTime()) {
      const settled = await CheckIn.findById(checkInId);
      if (settled?.checkOutTime) return settled;
      throw ApiError.conflict('Check-out raced a concurrent request; retry to observe the settled record.');
    }

    // Calculate duration in minutes
    const durationMinutes = Math.max(1, Math.round((now.getTime() - checkIn.checkInTime.getTime()) / (1000 * 60)));
    checkIn.durationMinutes = durationMinutes;

    // Compute earned karma with surge multiplier
    const shift = await Shift.findById(checkIn.shiftId);
    const baseKarma = shift ? shift.baseKarma : 100;

    const surge = SurgePricingEngine.calculate({
      baseKarma,
      capacity: shift ? shift.capacity : 1,
      filledSlots: shift ? shift.filledSlots : 1,
      startTime: shift ? shift.startTime : now,
      currentTime: checkIn.checkInTime,
      manualMultiplier: shift ? shift.manualSurgeMultiplier : 1.0,
    });

    const hours = durationMinutes / 60;
    // Pro-rata payout: a full hour (or more) earns the full surge award, scaled
    // down linearly below that. The old floor of 0.5x minted half a shift's
    // karma for a 60-second "presence" (instant check-in/out farming).
    const timeFactor = Math.min(1, durationMinutes / 60);
    const earnedKarma = Math.max(1, Math.round(surge.karmaAward * timeFactor));
    checkIn.karmaAwarded = earnedKarma;
    await checkIn.save();

    // Update registration
    await Registration.findByIdAndUpdate(checkIn.registrationId, {
      $set: {
        status: RegistrationStatus.COMPLETED,
        checkOutTime: now,
        earnedKarma,
      },
    });

    // Update volunteer profile atomically ($inc — concurrent payouts can't lost-update).
    // ponytail: UTC hour for the graveyard badge so deploy timezone can't misfire it.
    const earnedBadges: string[] = [];
    const utcHour = checkIn.checkInTime.getUTCHours();
    if (utcHour >= 2 && utcHour <= 5) earnedBadges.push('MIDNIGHT_KRAKEN');
    if (surge.surgeMultiplier >= 3.0) earnedBadges.push('SIEBEL_GUARDIAN');
    const volunteer = await Volunteer.findOneAndUpdate(
      { _id: checkIn.volunteerId },
      {
        $inc: { karmaPoints: earnedKarma, hoursServed: Math.round(hours * 100) / 100 },
        ...(earnedBadges.length > 0 ? { $addToSet: { badges: { $each: earnedBadges } } } : {}),
      },
      { new: true }
    );
    if (volunteer) {
      const tier = computePrestigeTier(volunteer.karmaPoints);
      if (tier !== volunteer.prestigeTier) {
        await Volunteer.updateOne({ _id: volunteer._id }, { $set: { prestigeTier: tier } });
      }
    }

    eventHub.broadcast({
      type: 'VOLUNTEER_CHECKED_OUT',
      data: {
        volunteerId: checkIn.volunteerId,
        karmaAwarded: earnedKarma,
        hoursServed: hours,
        totalKarma: volunteer ? volunteer.karmaPoints : 0,
        prestigeTier: volunteer ? volunteer.prestigeTier : 'NEOPHYTE_PLANKTON',
      },
    });

    return checkIn;
  }
}
