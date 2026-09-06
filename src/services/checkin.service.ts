/**
 * Attendance — QR token verification, geofenced check-in, and karma-paying checkout.
 *
 * Five gates stand between a scan and a recorded attendance, added by five different rounds,
 * each defeating a different attack. The first three defeat forgery, sharing and relaying:
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
 * **The shift has to be happening.** A ±30 minute grace either side of the shift, so a token
 * for tomorrow cannot be redeemed today. This was a known gap for a long time and the
 * comment that described it as one outlived the fix; if you are reading this looking for the
 * missing check, it is at the top of `verifyAndCheckIn`.
 *
 * **The desk is not the volunteer.** `/verify` needs lead-or-above, because `/token` and
 * `/verify` gated identically meant the person being checked in could mint their own token
 * and scan it. Note this bites only in `AUTH_MODE=required`: in `legacy` every role gate
 * passes an anonymous caller by design, which is the open-demo contract.
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


/**
 * How far either side of a shift a check-in is still accepted.
 *
 * Wide on purpose — see the reasoning at the check in `verifyAndCheckIn`.
 *
 * It matches `REST_BUFFER_MS`, and an earlier version of this comment claimed that therefore
 * nobody can be inside two shifts' windows at once. That is false, and the arithmetic is the
 * other way round: the rest-buffer check permits a gap of *exactly* thirty minutes, so shifts
 * at 10:00–12:00 and 12:30–14:30 are both legal and their check-in windows meet at 12:00–12:30.
 * A volunteer can hold an open check-in on both. That is tolerable — they are adjacent shifts
 * in the same building and somebody who arrives early for the second while the first is
 * ending is doing nothing wrong — but it is a consequence to know about rather than a
 * property to rely on.
 */
const CHECK_IN_GRACE_MS = 30 * 60 * 1000;

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
    userCoordinates?: { latitude: number; longitude: number },
    /**
     * The account that presented the scan, when there is a session behind it.
     *
     * `scannerId` is a free string the client chooses, and it was the whole of the audit
     * trail: a scan could claim to come from `DESK_SCANNER_MAIN` whoever sent it. Recording
     * the session separately means the label stays useful for telling one desk from another
     * while the answer to "who did this" comes from the cookie.
     */
    verifiedByAccountId?: string
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

    // Already checked in? Say so — but only to a caller who got this far.
    //
    // This answer is idempotent: it writes nothing and awards nothing, and it is the truth
    // about a volunteer who is already at their shift. It used to sit below the shift window
    // as well, which meant a *successful* check-in became un-returnable the moment the window
    // closed: a desk retrying after a restart at 18:35, for a shift that ended at 18:00, was
    // told "this shift is over" rather than being handed the attendance it had already
    // recorded. A retry after success has to be answerable for as long as the record exists,
    // so it sits above the window.
    //
    // It does **not** sit above the coordinate requirement or the geofence, and the first
    // version of this reorder did. Returning a 200 and an attendance row is a disclosure —
    // it says "this person is checked in right now" — and putting it above those two gates
    // meant the disclosure could be had with no coordinates at all, from anywhere, at any
    // hour. The retry this exists for is a desk standing at the venue with a GPS fix; it has
    // no need to skip the two gates that establish that, and only the window stands between
    // it and the answer.
    //
    // Residual, recorded rather than fixed here: a caller who supplies the venue's published
    // coordinates satisfies the geofence, because a geofence cannot tell a spoofed fix from a
    // real one. In `AUTH_MODE=required` that caller must already hold `SHIFT_LEAD` to reach
    // `/verify` at all, and a lead can read the roster anyway. In `legacy` it is inside the
    // documented open-demo contract for actions. Closing it properly means binding the scan
    // to the scanner, not reordering gates.
    if (reg.status === RegistrationStatus.CHECKED_IN) {
      const existingCheckIn = await CheckIn.findOne({ registrationId: reg._id });
      if (existingCheckIn) {
        return { checkIn: existingCheckIn, verification, geofenceStatus };
      }
    }

    // *When*, not only who and which shift.
    //
    // The token binds a volunteer to a shift and to a thirty-second slice of clock, and the
    // geofence binds the scan to a place — but nothing tied any of it to the shift actually
    // happening. A volunteer confirmed for tomorrow could mint a token today, stand at the
    // venue, check in, and check out an hour later for the full surge award, having worked
    // nothing. Karma for a shift that has not happened is the same defect as karma for a
    // shift somebody else worked; it was simply easier to reach.
    //
    // The grace either side is deliberately wide. Volunteers turn up early, desks run late,
    // and a shift that overruns is the normal case at three in the morning — refusing
    // somebody who is standing in front of you because the clock says 16:31 would make this
    // rule the reason attendance goes unrecorded.
    //
    // It sits *below* the idempotent short-circuit above, and that ordering is the whole
    // point of both. This gate exists to stop a check-in being *created* for a shift that is
    // not happening; it has no business refusing to hand back one that already exists. Above
    // the short-circuit it did exactly that, and a desk retrying after a restart at 18:35 for
    // a shift that ended at 18:00 was told the shift was over.
    const nowMs = Date.now();
    if (nowMs < shift.startTime.getTime() - CHECK_IN_GRACE_MS) {
      throw ApiError.badRequest(
        `This shift has not started yet: "${shift.title}" begins ${shift.startTime.toISOString()}. Check-in opens ${CHECK_IN_GRACE_MS / 60000} minutes before.`,
        { code: ErrorCode.SCHEDULE_CONFLICT }
      );
    }
    if (nowMs > shift.endTime.getTime() + CHECK_IN_GRACE_MS) {
      throw ApiError.badRequest(
        `This shift is over: "${shift.title}" ended ${shift.endTime.toISOString()}. Ask a lead to record attendance by hand.`,
        { code: ErrorCode.SCHEDULE_CONFLICT }
      );
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
    // Claim the registration FIRST, then spend the token, then write the attendance row.
    //
    // The order used to be spend → write → claim, and both of the other two orders lose
    // something. Writing the attendance row before claiming meant a cancellation landing in
    // the window — two database round trips wide — left a `CheckIn` whose registration was
    // CANCELLED: an attendance record for somebody who is not on the shift, counted by every
    // roster and report, and undeletable by retry because the `registrationId` index rejects
    // the replacement. And spending the token before either meant a refusal after the spend,
    // which is exactly the "a refused scan must not burn the token" property the split
    // verify/consume was introduced to get.
    //
    // Claiming first makes the failure modes the survivable ones. A lost CAS refuses with the
    // token intact and nothing written. A crash between the claim and the write leaves a
    // CHECKED_IN registration with no attendance row, and the early short-circuit above
    // repairs that on the next scan rather than being stuck behind a unique index.
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


    // The token is spent once the registration is ours. The `registrationId` index below is
    // the durable single-use guarantee; this is the cheap in-process one, and it now sits
    // after every refusal rather than before two of them.
    if (verification.nonce && !DynamicQrTokenEngine.consumeNonce(verification.nonce)) {
      throw ApiError.conflict(
        'Token replay attack detected: This QR token has already been scanned.',
        ErrorCode.REPLAY_ATTACK_DETECTED
      );
    }

    let checkIn;
    try {
      checkIn = await CheckIn.create({
        registrationId: reg._id,
        shiftId: new Types.ObjectId(shiftId),
        volunteerId: new Types.ObjectId(volunteerId),
        checkInTime: new Date(),
        nonce,
        verifiedBy: scannerId,
        verifiedByAccountId: verifiedByAccountId ? new Types.ObjectId(verifiedByAccountId) : null,
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
          if (settled) {
            // Repair the torn state before returning, rather than only reporting it.
            //
            // The attendance row and the registration's status are two writes, and a process
            // that dies between them leaves a `CheckIn` with a registration still CONFIRMED.
            // Every retry then landed here, found the row, and returned early — skipping the
            // status transition for a second time. The registration stayed CONFIRMED for
            // ever, and check-out refuses anything that is not CHECKED_IN, so the volunteer
            // could never be paid and no amount of rescanning would help.
            //
            // A retry is the natural moment to finish what was started.
            //
            // `CONFIRMED` alone is no longer the right condition, and was left over from when
            // the claim ran *after* this create. It runs before it now, so by the time a
            // duplicate-key lands our own thread has already moved the row to CHECKED_IN with
            // its own `checkInTime` — the loser of two simultaneous scans would leave the
            // registration stamped with its clock and the attendance row stamped with the
            // winner's. Accepting either state converges both on the row that actually won,
            // and still repairs a genuinely torn CONFIRMED row left by an older write.
            await Registration.findOneAndUpdate(
              { _id: reg._id, status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] } },
              { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: settled.checkInTime } }
            );
            return { checkIn: settled, verification, geofenceStatus };
          }
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
    // in the history, rather than a zero that looks like a missing field — and ceilinged at
    // the shift itself, which it was not.
    //
    // Check-in is bounded by a ±30 minute window; check-out was bounded by nothing, so the
    // clock simply kept running. Somebody who checked in for a one-hour shift, left after
    // five minutes and tapped check-out three days later was credited seventy-two hours and
    // paid the full surge award, because `timeFactor` saturates at one hour. `hoursServed` is
    // the leaderboard tiebreak and the event-wide total, so that is not a cosmetic number.
    //
    // The clamp is the shift's own end plus the same grace the entry uses: you are paid for
    // the shift you worked, and forgetting to tap out costs you nothing but earns you nothing
    // either.
    // Clamped at both ends, because the first version of this clamp only capped the end.
    //
    // Check-in opens `CHECK_IN_GRACE_MS` *before* the shift starts, which is deliberate —
    // volunteers turn up early and a desk should be able to scan them. But the paid interval
    // then ran from whenever they scanned, so arriving thirty minutes early and leaving on
    // time was credited two and a half hours for a two-hour shift. Worse at the short end:
    // `timeFactor` saturates at one hour, so an early scan plus a five-minute appearance
    // reads as thirty-five minutes of work and pays 0.58 of the award instead of 0.08.
    //
    // The interval paid is the intersection of "when they were here" with "when the shift
    // was", plus the same grace at the far end: you are paid for the shift you worked.
    const shiftForClamp = await Shift.findById(checkIn.shiftId).select('startTime endTime');
    const latestPayable = shiftForClamp
      ? Math.min(now.getTime(), shiftForClamp.endTime.getTime() + CHECK_IN_GRACE_MS)
      : now.getTime();
    const earliestPayable = shiftForClamp
      ? Math.max(checkIn.checkInTime.getTime(), shiftForClamp.startTime.getTime())
      : checkIn.checkInTime.getTime();
    const workedMs = Math.max(0, latestPayable - earliestPayable);
    const durationMinutes = Math.max(1, Math.round(workedMs / (1000 * 60)));
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
    // What the shift *offers*. What is actually paid is decided by the daily cap below, and
    // the two rows written here are corrected to match it once it is known.
    const advertisedKarma = Math.max(1, Math.round(surge.karmaAward * timeFactor));
    let earnedKarma = advertisedKarma;
    checkIn.karmaAwarded = advertisedKarma;
    await checkIn.save();

    // Conditional on the state being left, not merely on the row's id. The guard above makes
    // the common case correct; this makes the transition itself impossible to get wrong, so
    // a cancellation that lands in the window between the two cannot be overwritten.
    //
    // **And the result decides whether anybody gets paid.** It used to be discarded, with the
    // hours `$inc` and `awardKarma` running unconditionally underneath it — so the CAS
    // protected the *registration* and nothing else. A cancellation committing between the
    // pre-check twenty lines up and this line transfers the seat to a waitlister, this update
    // matches nothing, and the volunteer who cancelled was still credited the hours and paid
    // the karma; the promoted volunteer is then paid for the same seat when they check out.
    // One seat, two payouts, and no row anywhere recording that it happened.
    //
    // Losing it rolls the `checkOutTime` CAS back rather than leaving the check-in closed:
    // a closed check-in reads as an idempotent replay to the guard at the top of this method,
    // so without the rollback a retry would return "already checked out" for a check-out that
    // never paid, and the state would be unrecoverable from the outside.
    const completed = await Registration.findOneAndUpdate(
      { _id: checkIn.registrationId, status: RegistrationStatus.CHECKED_IN },
      {
        $set: {
          status: RegistrationStatus.COMPLETED,
          checkOutTime: now,
          earnedKarma: advertisedKarma,
        },
      }
    );
    if (!completed) {
      await CheckIn.updateOne(
        { _id: checkIn._id, checkOutTime: now },
        { $unset: { checkOutTime: '', durationMinutes: '', karmaAwarded: '' } }
      );
      throw ApiError.conflict(
        'This registration changed while the check-out was in flight; nothing was paid. Retry to observe the settled state.',
        ErrorCode.SCHEDULE_CONFLICT
      );
    }

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
    const payout = advertisedKarma > 0
      ? await KarmaService.awardKarma(checkIn.volunteerId, advertisedKarma, KarmaSource.CHECKOUT, { shiftId: String(checkIn.shiftId), hours })
      : { awarded: 0 };
    earnedKarma = payout.awarded;

    // The daily cap may have held part of the award back, and the two rows written above
    // still carry the advertised figure. Correcting them is not cosmetic: `CheckIn.karmaAwarded`
    // and `Registration.earnedKarma` are what a disputed balance is reconstructed from, and a
    // volunteer past their CHECKOUT cap otherwise has two rows saying they were paid 150
    // against a ledger and a wire frame that both say 20. Every sibling path — SOS
    // resolution, quest settlement — was already corrected to report the granted figure
    // rather than the offered one; this one persists it as well as reporting it.
    if (earnedKarma !== advertisedKarma) {
      await Promise.all([
        CheckIn.updateOne({ _id: checkIn._id }, { $set: { karmaAwarded: earnedKarma } }),
        Registration.updateOne({ _id: checkIn.registrationId }, { $set: { earnedKarma } }),
      ]);
      checkIn.karmaAwarded = earnedKarma;
    }
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
