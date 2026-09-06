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
import { Volunteer } from '../models/volunteer.model';
import { DynamicQrTokenEngine, IVerificationResult } from '../common/utils/crypto';
import { SurgePricingEngine } from '../common/utils/surgePricing';
import { GeoEngine, resolveVenue } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { sameId } from '../common/utils/id';
import { KarmaService, KarmaSource } from './karma.service';
import { domainEvents } from '../common/events/domainEvents';


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
    // Verified but not yet spent. Everything between here and the check-in write can still
    // refuse the scan — the registration status, the missing coordinates, an unresolvable
    // venue, the geofence — and a refusal that also burns the token turns a volunteer
    // standing slightly too far away into a volunteer who now has to mint a new one and
    // whose next honest scan reports a replay attack. The nonce is spent below, once the
    // check-in is actually going to happen.
    const verification = DynamicQrTokenEngine.verifyToken(token, 1, Date.now(), undefined, false);

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

    // The token proves who minted it, not that the holder still holds a seat. A volunteer
    // who cancelled after their token was issued must not check in on it.
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

    // Every refusal is behind us, so spend the token now. Losing this race means another
    // scan of the same token got here first — the same answer the cache gave before, just
    // moved to the point where it is true.
    if (verification.nonce && !DynamicQrTokenEngine.consumeNonce(verification.nonce)) {
      throw ApiError.conflict(
        'Token replay attack detected: This QR token has already been scanned.',
        ErrorCode.REPLAY_ATTACK_DETECTED
      );
    }

    // Replay reaching this far means the nonce cache missed (a restart, another replica).
    // Return the existing record unchanged: it writes nothing and awards nothing, which is
    // the honest answer to "check this person in again".
    if (reg.status === RegistrationStatus.CHECKED_IN) {
      const existingCheckIn = await CheckIn.findOne({ registrationId: reg._id });
      if (existingCheckIn) {
        return { checkIn: existingCheckIn, verification, geofenceStatus };
      }
    }

    const nonce = token.split('.')[0];

    // Create the CheckIn record. Two unique indexes can reject this, and they mean different
    // things, so the catch below has to tell them apart.
    //
    // `nonce` is the cross-process replay shield: a token scanned twice, on another replica or
    // after a restart, slips past the in-memory cache and lands here. That is an attack (or a
    // very persistent scanner) and is reported as one.
    //
    // `registrationId` is the once-per-registration guarantee. Every token carries its own
    // nonce by design, so ten freshly minted tokens for one person are ten distinct writes
    // that the nonce index is happy to accept; only this index stops them becoming ten
    // attendances and, later, ten payouts. Losing that race is not an attack — it is two
    // scanners at one desk — so the loser is handed the row that won.
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
      const duplicate =
        typeof error === 'object' && error !== null && 'code' in error &&
        (error as { code: unknown }).code === 11000;
      if (duplicate) {
        // Which index rejected it decides what this means.
        const message = String((error as { message?: unknown }).message ?? '');
        if (/registrationId/.test(message)) {
          // Two scanners at one desk. Somebody else's write won a race that was never a
          // conflict of intent, so hand back the attendance that exists rather than
          // accusing an honest volunteer of a replay attack.
          const settled = await CheckIn.findOne({ registrationId: reg._id });
          if (settled) return { checkIn: settled, verification, geofenceStatus };
        }
        throw ApiError.conflict(
          'Token replay attack detected: This QR token has already been scanned.',
          ErrorCode.REPLAY_ATTACK_DETECTED
        );
      }
      throw error;
    }

    // Compare-and-set on the status this transition is leaving, not a read-modify-save.
    //
    // `reg` was read at the top of this method, several awaits ago. A cancellation that
    // commits in that window has already released the seat and, if anybody was waiting,
    // handed it to them — and `reg.save()` would then write CHECKED_IN straight back over
    // it from the stale in-memory copy, silently undoing a committed cancellation and
    // putting two people in one seat. The cancel path twenty lines away is careful to CAS
    // for exactly this reason; this one was not.
    const claimed = await Registration.findOneAndUpdate(
      { _id: reg._id, status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] } },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: new Date() } },
      { new: true }
    );
    if (!claimed) {
      throw ApiError.conflict(
        'This registration was cancelled or completed while the token was being scanned.',
        ErrorCode.SCHEDULE_CONFLICT
      );
    }

    const vol = await Volunteer.findById(volunteerId);

    domainEvents.emit('checkin.completed', { accountId: String(volunteerId), shiftId: String(shiftId), at: new Date() });

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
   * Concludes a shift check-out, calculates hours, and applies the dynamic karma multiplier.
   *
   * Three guards, each closing a different way to be paid twice. The owner check stops a
   * volunteer closing someone else's shift and taking their karma. The CAS on
   * `checkOutTime` means two concurrent check-outs produce one payment and one replay.
   * Hours are credited with `$inc` rather than a read-modify-write, so a payout racing
   * another payout on the same account cannot lose one of them.
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

    // A fourth guard: the registration must still be the one this check-in belongs to.
    //
    // Checked here, before the check-in row is closed, because the write at the end of this
    // method used to set `COMPLETED` unconditionally. A volunteer who checked in and then
    // cancelled had their seat handed to the waitlist by the cascade — and this method then
    // moved their CANCELLED row forward to COMPLETED, which occupies a seat. One seat, two
    // occupants, and karma paid to somebody who had cancelled. `filledSlots` still read 1,
    // so nothing downstream noticed.
    //
    // Refusing is the right answer rather than paying anyway: cancelling is the volunteer
    // saying they are not working this shift, and it already gave the seat to somebody else.
    const registration = await Registration.findById(existing.registrationId).select('status');
    if (!registration) {
      throw ApiError.notFound('Registration for this check-in no longer exists.', ErrorCode.REGISTRATION_NOT_FOUND);
    }
    if (registration.status !== RegistrationStatus.CHECKED_IN) {
      throw ApiError.conflict(
        `This check-in cannot be closed: the registration is ${registration.status}, not CHECKED_IN.`,
        ErrorCode.SCHEDULE_CONFLICT
      );
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

    // Floored at one minute so a sub-minute shift still records something a human can read
    // in the history, rather than a zero that looks like a missing field.
    const durationMinutes = Math.max(1, Math.round((now.getTime() - checkIn.checkInTime.getTime()) / (1000 * 60)));
    checkIn.durationMinutes = durationMinutes;

    // Surge is recomputed against the check-*in* moment, not now, so a volunteer is paid the
    // rate that was advertised when they turned up rather than the rate the shift has
    // decayed to by the time they leave.
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
    let earnedKarma = Math.max(1, Math.round(surge.karmaAward * timeFactor));
    checkIn.karmaAwarded = earnedKarma;
    await checkIn.save();

    // Conditional on the state being left, not merely on the row's id. The guard above makes
    // the common case correct; this makes the transition itself impossible to get wrong, so
    // a cancellation that lands in the window between the two cannot be overwritten.
    await Registration.findOneAndUpdate(
      { _id: checkIn.registrationId, status: RegistrationStatus.CHECKED_IN },
      {
        $set: {
          status: RegistrationStatus.COMPLETED,
          checkOutTime: now,
          earnedKarma,
        },
      }
    );

    // The graveyard badge is judged in UTC rather than the host's local zone, so the same
    // check-in earns it (or does not) whatever region the server happens to run in.
    const earnedBadges: string[] = [];
    const utcHour = checkIn.checkInTime.getUTCHours();
    if (utcHour >= 2 && utcHour <= 5) earnedBadges.push('MIDNIGHT_KRAKEN');
    if (surge.surgeMultiplier >= 3.0) earnedBadges.push('SIEBEL_GUARDIAN');
    // Hours and badges are this service's own bookkeeping; karma is not. Routing the payout
    // through KarmaService is what keeps the daily cap and the ledger honest, and it
    // recomputes the prestige tier from the balance it just wrote.
    await Volunteer.updateOne(
      { _id: checkIn.volunteerId },
      {
        $inc: { hoursServed: Math.round(hours * 100) / 100 },
        ...(earnedBadges.length > 0 ? { $addToSet: { badges: { $each: earnedBadges } } } : {}),
      }
    );
    const payout = earnedKarma > 0
      ? await KarmaService.awardKarma(checkIn.volunteerId, earnedKarma, KarmaSource.CHECKOUT, { shiftId: String(checkIn.shiftId), hours })
      : { awarded: 0 };
    earnedKarma = payout.awarded;
    const volunteer = await Volunteer.findById(checkIn.volunteerId);

    domainEvents.emit('checkout.completed', { accountId: String(checkIn.volunteerId), shiftId: String(checkIn.shiftId), hoursServed: hours, at: new Date() });

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
