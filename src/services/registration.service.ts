/**
 * Shift reservation, waitlisting and cancellation — the core of the scheduling engine.
 *
 * This service owns the invariants the whole project is judged on, and each is enforced
 * by a specific mechanism rather than by careful ordering of reads and writes:
 *
 *  - **I1, never oversold.** The seat claim is a single conditional update whose filter
 *    contains `$expr: { $lt: ['$filledSlots', '$capacity'] }`. The comparison happens
 *    inside the storage engine while the document is latched, so concurrent workers racing
 *    for the last seats cannot all pass it. Reading capacity and then writing would give
 *    every worker the same stale count — the check and the write have to be the same
 *    operation. `tests/concurrency.test.ts` races 50 requests at a 2-seat shift and
 *    asserts 2 confirmed, 48 waitlisted, 0 oversold.
 *  - **I2, one active registration per volunteer per shift.** A partial unique index over
 *    the five index-active states — every status except CANCELLED, so a volunteer who
 *    dropped out may sign up again and one who already worked the shift may not. Enforced
 *    by the database, so it holds no matter which code path or which replica does the
 *    insert.
 *  - **I4, the waitlist is FIFO.** Positions are handed out from a counter, and a
 *    cancellation promotes the lowest outstanding position.
 *
 * **Idempotency.** Reservation accepts an `Idempotency-Key`. The record is claimed in a
 * single conditional round trip rather than read-then-write, so two retries of the same
 * request cannot both believe they are the first. The stored request hash is compared on
 * replay: the same key with different parameters is a conflict, not a silent replay of
 * the wrong thing. Hash inputs are lowercased so a differently-cased id is the same
 * request.
 *
 * **The reservation lock.** Fatigue and rest-buffer rules read a volunteer's existing
 * schedule and then act on it, which is a TOCTOU window: two simultaneous requests both
 * pass a check that neither would pass afterwards. A per-volunteer lock closes it. The
 * lock key is lowercased, because a key that varies by casing is two locks and therefore
 * no lock at all.
 *
 * `filledSlots` counts occupied seats, which is deliberately not the CONFIRMED row count
 * — see the note on the field in `shift.model.ts`.
 */
import { Types, ClientSession } from "mongoose";
import { randomUUID } from "crypto";
import crypto from "crypto";
import { Shift, IShift } from "../models/shift.model";
import { Volunteer } from "../models/volunteer.model";
import {
  Registration,
  IRegistration,
  RegistrationStatus,
} from "../models/registration.model";
import {
  IdempotencyRecord,
  IdempotencyStatus,
} from "../models/idempotency.model";
import {
  ReservationLock,
  volunteerLockKey,
} from "../models/reservationLock.model";
import { ApiError } from "../common/errors/apiError";
import { ErrorCode } from "../common/errors/errorCodes";
import { eventHub } from "../common/sse/eventHub";
import { sameId } from "../common/utils/id";
import { domainEvents } from '../common/events/domainEvents';

/**
 * The reservation mutex's own lifetime, and how long a contender waits for it.
 *
 * Thirty seconds is a crash backstop rather than an expected hold — a healthy reservation
 * holds this for a handful of milliseconds — and it is deliberately longer than the
 * document's TTL sweeper is prompt, which is why `acquireVolunteerLock` also steals an
 * expired lock explicitly instead of waiting for the sweeper.
 *
 * Six attempts sleeping 60 ms between them is roughly a third of a second of patience
 * before the caller is told to retry: long enough to absorb a double-tapped button or a
 * client's own retry, short enough that somebody genuinely queued behind another request
 * gets an answer rather than a hanging connection.
 */
const VOLUNTEER_LOCK_TTL_MS = 30000;
const VOLUNTEER_LOCK_RETRIES = 6;
const VOLUNTEER_LOCK_WAIT_MS = 60;
// A PENDING idempotency record older than this had its owner crash between
// claim and settle (healthy requests finish in milliseconds). It may be
// stolen rather than blocking the key for the full 24h document TTL.
const IDEMPOTENCY_STALE_MS = 2 * 60 * 1000;

/** Bounded wait between volunteer-lock retries. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for Mongo duplicate-key write failures, which concurrent first-writes produce. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === 11000
  );
}

const REST_BUFFER_MS = 30 * 60 * 1000; // Mandatory 30-minute rest buffer
const MAX_DAILY_HOURS_MS = 8 * 60 * 60 * 1000; // 8 hours max / calendar day

/**
 * Chicago wall-clock day window containing `date`, as UTC instants.
 * DST-safe: resolves the zone's real offset by iteration (offsets here are
 * whole minutes, so this converges immediately).
 */
function chicagoDayRange(date: Date): { dayStart: Date; dayEnd: Date } {
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayStr = dayFmt.format(date); // YYYY-MM-DD in Chicago
  const wallToUtc = (wall: string): Date => {
    let guess = new Date(`${wall}Z`);
    const partsFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      // `h23` pins midnight to "00" on runtimes whose ICU honours it. CI's does not: it
      // renders "24", and `T24:00:00` is *valid* ISO — midnight ending that date — so
      // `Date.parse` returns the next midnight instead of NaN, the NaN break below never
      // fires, and the iteration converges exactly one day early. Every booking was then
      // weighed against yesterday: today's pile-up passed, and yesterday's hours haunted
      // today's innocent bookings. Fold the rendering back to the midnight that was meant;
      // the iteration absorbs any residual skew either way.
      hourCycle: "h23",
    });
    for (let i = 0; i < 3; i++) {
      const parts = partsFmt.formatToParts(guess);
      const get = (t: string): string =>
        parts.find((p) => p.type === t)?.value ?? "";
      const asWall = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`.replace(
        "T24:",
        "T00:",
      );
      const diff = Date.parse(`${wall}Z`) - Date.parse(`${asWall}Z`);
      if (diff === 0 || Number.isNaN(diff)) break;
      guess = new Date(guess.getTime() + diff);
    }
    return guess;
  };
  const dayStart = wallToUtc(`${dayStr}T00:00:00`);
  const nextDay = new Date(`${dayStr}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextStr = nextDay.toISOString().slice(0, 10);
  const dayEnd = new Date(wallToUtc(`${nextStr}T00:00:00`).getTime() - 1);
  return { dayStart, dayEnd };
}

/**
 * One reservation request.
 *
 * `idempotencyKey` is the client's; when it is absent a unique one is minted per call, which
 * means an omitted key gives no replay protection at all rather than a weaker kind — two
 * retries without a key are two different requests as far as this service is concerned.
 *
 * `allowWaitlist` defaults to true and is part of the idempotency fingerprint, because it
 * changes the answer: the same key sent once willing to queue and once not is two different
 * requests, and replaying the first as the answer to the second would hand a queue place to
 * a caller who explicitly asked to be refused instead.
 */
export interface IReserveShiftParams {
  shiftId: string;
  volunteerId: string;
  idempotencyKey?: string;
  allowWaitlist?: boolean;
}

/**
 * The answer to a reservation, and the thing stored in the idempotency record so a replay
 * can be answered without re-executing.
 *
 * `waitlistPosition` is null on the confirmed path and 1-based on the queued one. `cached`
 * is the only field that differs between the original response and its replay: it is false
 * on the write that actually happened and true when this came back out of a COMMITTED
 * idempotency record, so a client can tell "you are booked" from "you were already booked".
 */
export interface IReserveResult {
  registration: IRegistration;
  status: RegistrationStatus;
  waitlistPosition?: number | null;
  cached?: boolean;
}

/**
 * Volunteer shift registration service managing atomic seat reservations, waitlist promotion cascades, and cancellations.
 */
export class RegistrationService {
  /**
   * Claim a seat, or a queue place when the seat is gone.
   *
   * The nine numbered steps below are in the order they are for a reason worth stating once.
   * The idempotency claim is first, so a retry is recognised before any work is repeated.
   * The per-volunteer lock is second, so every read-then-act check that follows — the I2
   * lookup, the skill test, the rest buffer, the fatigue cap — cannot interleave with
   * another reservation by the same person. The seat claim is last, because it is the only
   * step that is safe to lose.
   *
   * What the losing racer sees is the whole design. Fifty callers reach step 6 together and
   * each issues the same conditional update; the storage engine applies filter and increment
   * atomically on one document, so as many of them as there are free seats come back with a
   * shift and the rest come back `null`. A `null` is not an error — it is the answer "this
   * shift was full at the instant of your write" — and it falls straight through to a
   * waitlist place. Only a caller who passed `allowWaitlist: false` turns it into a 409
   * `SHIFT_FULL`. Nobody is ever told to retry because of contention on the seat itself.
   *
   * The two counters move on different paths and never both. A confirmed seat increments
   * `filledSlots`; a queue place increments `waitlistCount` and takes its position from the
   * post-increment value, so positions are handed out in the order the increments landed
   * rather than in the order the requests arrived. Whichever counter moved is compensated at
   * step 7 if the registration row then fails to write — including on the duplicate-key
   * error from the I2 index, which is the durable version of the step-3 courtesy check.
   */
  public static async reserveShift(
    params: IReserveShiftParams,
  ): Promise<IReserveResult> {
    const { shiftId, volunteerId, allowWaitlist = true } = params;
    const idempotencyKey =
      params.idempotencyKey ||
      `idem_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
    /**
     * This attempt's claim on the key, minted fresh every call.
     *
     * The key itself is the client's; this names the *server-side attempt* currently
     * allowed to settle it. Every write that finishes a record is conditional on it, so a
     * predecessor that stalled long enough to be stolen from can no longer overwrite the
     * record it lost.
     */
    const attemptToken = crypto.randomUUID();
    // Hash over normalised ids: the same logical reservation must produce the same
    // fingerprint regardless of how the caller cased its ObjectIds, or a retry would
    // look like a different request and bypass the idempotency record entirely.
    const requestHash = crypto
      .createHash("sha256")
      // `allowWaitlist` is part of the fingerprint because it changes the outcome: the same
      // key sent once with a queue place accepted and once without is two different
      // requests, and replaying the first as the answer to the second would hand back a
      // waitlist place to a caller who asked to be refused. The docblock above already
      // promised that same-key-different-parameters is a conflict; with only the two ids in
      // the hash, it was not.
      .update(`RESERVE:${shiftId.toLowerCase()}:${volunteerId.toLowerCase()}:${allowWaitlist ? 'q' : 'noq'}`)
      .digest("hex");

    // 1. Atomic idempotency claim in a SINGLE round-trip. The previous
    // findOne-then-upsert allowed two concurrent same-key requests to both
    // observe "no record" and both execute. Here exactly one caller wins the
    // insert; losers observe the winner's PENDING record and back off.
    const claim = await IdempotencyRecord.findOneAndUpdate(
      { key: idempotencyKey },
      {
        $setOnInsert: {
          key: idempotencyKey,
          userId: volunteerId,
          endpoint: "/api/v1/registrations",
          requestHash,
          ownerToken: attemptToken,
          status: IdempotencyStatus.PENDING,
        },
      },
      { upsert: true, new: true, includeResultMetadata: true },
    );
    const claimedDoc = claim.value;
    const wasInsert =
      claim.lastErrorObject !== undefined &&
      (claim.lastErrorObject as unknown as { updatedExisting?: boolean })
        .updatedExisting === false;

    if (claimedDoc && !wasInsert) {
      // Stale-owner takeover runs BEFORE the hash check: a dead owner's hash
      // is meaningless, and the key must not stay poisoned for 24h. The steal
      // overwrites the hash, so the check below only ever compares live owners.
      const pendingAgeMs =
        claimedDoc.status === IdempotencyStatus.PENDING
          ? Date.now() - new Date(claimedDoc.updatedAt).getTime()
          : 0;
      const isStalePending =
        claimedDoc.status === IdempotencyStatus.PENDING &&
        pendingAgeMs > IDEMPOTENCY_STALE_MS;

      if (isStalePending) {
        // Previous owner crashed between claim and settle (or died acquiring
        // the lock). Steal atomically — concurrent stealers race on the exact
        // updatedAt, so exactly one wins and proceeds.
        const stolen = await IdempotencyRecord.findOneAndUpdate(
          {
            key: idempotencyKey,
            status: IdempotencyStatus.PENDING,
            updatedAt: claimedDoc.updatedAt,
          },
          { $set: { userId: volunteerId, requestHash, ownerToken: attemptToken } },
          { new: true },
        );
        if (!stolen) {
          throw ApiError.conflict(
            "Identical reservation request currently in flight.",
            ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS,
          );
        }
        // Stolen: fall through and execute below.
      } else {
        if (claimedDoc.requestHash !== requestHash) {
          throw ApiError.conflict(
            "Idempotency key re-used with different payload.",
            ErrorCode.IDEMPOTENCY_CONFLICT,
          );
        }
        if (
          claimedDoc.status === IdempotencyStatus.COMMITTED &&
          claimedDoc.responseBody
        ) {
          return {
            ...(claimedDoc.responseBody as IReserveResult),
            cached: true,
          };
        }
        if (claimedDoc.status === IdempotencyStatus.PENDING) {
          throw ApiError.conflict(
            "Identical reservation request currently in flight.",
            ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS,
          );
        }
        // FAILED records fall through and re-execute below.
      }
    }

    // 1b. Serialize same-volunteer reservations. Validation (rest buffer,
    // fatigue) is read-then-act; without a lock, concurrent overlapping
    // bookings by one volunteer both pass before either writes. The lock is
    // per-volunteer so distinct volunteers stay fully parallel.
    let lockToken: string | null = null;
    try {
      lockToken = await this.acquireVolunteerLock(volunteerId);
    } catch (lockError) {
      // No request is in flight anymore, so release the key: without this,
      // the record would sit PENDING and block same-key retries for 24h.
      // Only if this attempt still holds the key. A stalled predecessor that has since been
      // stolen from must not mark the *stealer's* record FAILED — a same-key retry would
      // then see a failure for a reservation that is on its way to being committed.
      await IdempotencyRecord.updateOne(
        { key: idempotencyKey, status: IdempotencyStatus.PENDING, ownerToken: attemptToken },
        { $set: { status: IdempotencyStatus.FAILED } },
      );
      throw lockError;
    }

    try {
      // 2. Fetch and validate Shift & Volunteer
      const [shift, volunteer] = await Promise.all([
        Shift.findById(shiftId),
        Volunteer.findById(volunteerId),
      ]);

      if (!shift || !shift.isActive) {
        throw ApiError.notFound(
          "Shift not found or is no longer active.",
          ErrorCode.SHIFT_NOT_FOUND,
        );
      }
      if (!volunteer) {
        throw ApiError.notFound(
          "Volunteer not found.",
          ErrorCode.VOLUNTEER_NOT_FOUND,
        );
      }

      // 3. Invariant I2: does this volunteer already hold a row for this shift?
      //
      // The same five states as the partial unique index, COMPLETED included. This lookup is
      // a courtesy that produces a readable message; the index is the guarantee, and the two
      // must name the same set or the message says one thing while the write does another.
      //
      // COMPLETED is here because a shift you have already worked and been paid for is not a
      // shift you can sign up for again. Without it a volunteer could work the same shift
      // twice — a fresh QR token, a second check-out, a second payment — and consume a seat
      // each time.
      const existingActiveReg = await Registration.findOne({
        shiftId: new Types.ObjectId(shiftId),
        volunteerId: new Types.ObjectId(volunteerId),
        status: {
          $in: [
            RegistrationStatus.CONFIRMED,
            RegistrationStatus.WAITLISTED,
            RegistrationStatus.CHECKED_IN,
            RegistrationStatus.SWAP_PENDING,
            RegistrationStatus.COMPLETED,
          ],
        },
      });

      if (existingActiveReg) {
        throw ApiError.conflict(
          existingActiveReg.status === RegistrationStatus.COMPLETED
            ? 'Volunteer has already worked this shift.'
            : `Volunteer is already registered for this shift with status: ${existingActiveReg.status}.`,
          ErrorCode.ALREADY_REGISTERED,
        );
      }

      // 4. Validate Skill Prerequisites
      if (shift.requiredSkills && shift.requiredSkills.length > 0) {
        const hasAllSkills = shift.requiredSkills.every((skill) =>
          volunteer.certifications.includes(skill),
        );
        if (!hasAllSkills) {
          throw ApiError.conflict(
            `Volunteer lacks required skill certifications: ${shift.requiredSkills.join(", ")}`,
            ErrorCode.MISSING_SKILL_CERTIFICATION,
            {
              requiredSkills: shift.requiredSkills,
              volunteerCertifications: volunteer.certifications,
            },
          );
        }
      }

      // 5. Invariant I3: Schedule Interval Collision & 30-Minute Rest Buffer Check
      await this.assertNoScheduleConflicts(
        volunteerId,
        shift.startTime,
        shift.endTime,
      );

      // 6. Concurrency-Safe Atomic Conditional Slot Claim
      // Evaluates `$expr: { $lt: ['$filledSlots', '$capacity'] }` directly on the storage engine
      const updatedShift = await Shift.findOneAndUpdate(
        {
          _id: new Types.ObjectId(shiftId),
          $expr: { $lt: ["$filledSlots", "$capacity"] },
        },
        {
          $inc: { filledSlots: 1, version: 1 },
        },
        { new: true },
      );

      let targetStatus: RegistrationStatus;
      let assignedWaitlistPos: number | null = null;

      if (updatedShift) {
        // Direct confirmed slot successfully claimed!
        targetStatus = RegistrationStatus.CONFIRMED;
      } else {
        // Capacity full -> Overflow to FIFO waitlist if permitted
        if (!allowWaitlist) {
          throw ApiError.conflict(
            "Shift capacity is full and waitlist not requested.",
            ErrorCode.SHIFT_FULL,
          );
        }

        targetStatus = RegistrationStatus.WAITLISTED;

        // Atomically increment waitlist count on shift
        const shiftWithWaitlist = await Shift.findByIdAndUpdate(
          shiftId,
          { $inc: { waitlistCount: 1, version: 1 } },
          { new: true },
        );

        assignedWaitlistPos = shiftWithWaitlist
          ? shiftWithWaitlist.waitlistCount
          : 1;
      }

      // 7. Persist Registration Record (compensate the counter if the write fails —
      // otherwise a crash between $inc and create inflates waitlistCount forever).
      let registration: IRegistration;
      try {
        registration = await Registration.create({
          shiftId: new Types.ObjectId(shiftId),
          volunteerId: new Types.ObjectId(volunteerId),
          status: targetStatus,
          waitlistPosition: assignedWaitlistPos,
          idempotencyKey,
          confirmedAt:
            targetStatus === RegistrationStatus.CONFIRMED
              ? new Date()
              : undefined,
        });
      } catch (error) {
        if (targetStatus === RegistrationStatus.WAITLISTED) {
          await Shift.findByIdAndUpdate(shiftId, {
            $inc: { waitlistCount: -1, version: 1 },
          }).catch(() => undefined);
        } else {
          await Shift.findByIdAndUpdate(shiftId, {
            $inc: { filledSlots: -1, version: 1 },
          }).catch(() => undefined);
        }
        throw error;
      }

      const responsePayload: IReserveResult = {
        registration,
        status: targetStatus,
        waitlistPosition: assignedWaitlistPos,
        cached: false,
      };

      // 8. Commit Idempotency Record
      // Fenced, for the mirror-image reason. A predecessor that stalled past the steal
      // window and then finished would otherwise stamp its own response body over the
      // record the stealer now owns, and the stealer's client would replay somebody else's
      // reservation from its own key.
      await IdempotencyRecord.updateOne(
        { key: idempotencyKey, ownerToken: attemptToken },
        {
          $set: {
            status: IdempotencyStatus.COMMITTED,
            responseStatusCode: 201,
            responseBody: responsePayload,
          },
        },
      );

      // 9. Announce it, inward then outward. The domain bus feeds the reward rules and any
      // plugin hooks; the SSE hub feeds browsers. Both run after the write is committed.
      domainEvents.emit('registration.created', {
        accountId: String(volunteerId),
        shiftId: String(shiftId),
        waitlisted: targetStatus !== RegistrationStatus.CONFIRMED,
      });

      eventHub.broadcast({
        type:
          targetStatus === RegistrationStatus.CONFIRMED
            ? "SLOT_RESERVED"
            : "WAITLIST_JOINED",
        data: {
          shiftId,
          volunteerId,
          volunteerName: volunteer.name,
          status: targetStatus,
          waitlistPosition: assignedWaitlistPos,
          filledSlots: updatedShift
            ? updatedShift.filledSlots
            : shift.filledSlots,
          capacity: shift.capacity,
        },
      });

      return responsePayload;
    } catch (error) {
      // Mark this attempt's idempotency record FAILED — fenced, like its two siblings.
      //
      // The release on the lock-failure path at step 1b and the commit at step 8 are both
      // predicated on `ownerToken: attemptToken`, each with a comment explaining that an
      // unfenced write lets a stalled predecessor corrupt the record a later attempt now
      // owns. This write was the one that did not carry the fence, and it is the most
      // damaging place to omit it: a
      // predecessor that stalled past the steal window and then threw would mark the
      // *stealer's* record FAILED. The stealer's client, replaying its own key, would be told
      // its reservation failed when the row exists — and a client that believes that retries,
      // which is the double-booking this whole table exists to prevent.
      //
      // `status: PENDING` is the second half. The broadcast and the domain event at step 9 run
      // *after* the commit, so an exception there would otherwise let this line walk a record
      // that is already COMMITTED back to FAILED — the same corruption, from the same attempt
      // rather than a different one.
      await IdempotencyRecord.updateOne(
        { key: idempotencyKey, ownerToken: attemptToken, status: IdempotencyStatus.PENDING },
        { $set: { status: IdempotencyStatus.FAILED } },
      );
      throw error;
    } finally {
      await this.releaseVolunteerLock(volunteerId, lockToken);
    }
  }

  /**
   * Acquires the per-volunteer reservation mutex, waiting briefly for a
   * contender to finish so legitimate sequential retries still succeed.
   * Contended-then-released locks let the waiter observe the winner's write,
   * which is exactly what makes the conflict checks sound under concurrency.
   */
  private static async acquireVolunteerLock(
    volunteerId: string,
  ): Promise<string> {
    const key = volunteerLockKey(volunteerId);
    for (let attempt = 0; attempt < VOLUNTEER_LOCK_RETRIES; attempt++) {
      // A fresh token per attempt, so a steal and a first acquisition are told apart by the
      // value in the document rather than by which code path produced it.
      const token = randomUUID();
      const now = Date.now();
      try {
        await ReservationLock.create({
          key,
          token,
          acquiredAt: new Date(now),
          expiresAt: new Date(now + VOLUNTEER_LOCK_TTL_MS),
        });
        return token;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      await sleep(VOLUNTEER_LOCK_WAIT_MS);
      const existing = await ReservationLock.findOne({ key });
      if (!existing) continue;
      if (existing.expiresAt.getTime() <= Date.now()) {
        // Stale lock (TTL sweeper can lag ~60s): steal it atomically so two
        // stealers cannot both believe they hold it. The filter names the token we READ, not
        // just the expiry, so two stealers racing on an expiry that has not moved still
        // produce one winner.
        const stolen = await ReservationLock.findOneAndUpdate(
          { key, token: existing.token },
          {
            $set: {
              token,
              acquiredAt: new Date(),
              expiresAt: new Date(Date.now() + VOLUNTEER_LOCK_TTL_MS),
            },
          },
          { new: true },
        );
        if (stolen) return token;
      }
    }
    throw ApiError.conflict(
      "Volunteer has another reservation request in flight. Retry shortly.",
      ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS,
    );
  }

  /**
   * Release the lock, but only if we still hold it.
   *
   * An unconditional delete releases whoever holds the key, which is not always the caller.
   * A request slow enough for its lock to expire has the key stolen by a waiter; when the slow
   * one finishes, its `finally` deleted the waiter's lock, and two reservations for one
   * volunteer then ran at once — precisely what this lock exists to prevent, and invisible
   * because both of them succeed. Naming the token makes a release by a former holder a no-op.
   */
  private static async releaseVolunteerLock(
    volunteerId: string,
    token: string | null,
  ): Promise<void> {
    if (!token) return;
    try {
      await ReservationLock.deleteOne({ key: volunteerLockKey(volunteerId), token });
    } catch {
      // Lock release is best-effort; TTL expiry is the backstop.
    }
  }

  /**
   * Cancel a registration and, when it held a seat, hand that seat to the queue.
   *
   * The ordering here is the opposite of the obvious one and it is the point of the method.
   * The row is marked CANCELLED first, the seat is *held* across the whole cascade, and
   * `filledSlots` is only decremented at the very end if nobody took it. A promotion is
   * therefore a transfer rather than a release followed by a re-acquire, so the seat is
   * never briefly claimable by a concurrent `reserveShift`. The long comments inside name
   * each of the lost-update races that shape closes; they are worth reading before changing
   * the order of anything.
   *
   * Three different races run through this method and each has its own guard. Two callers
   * cancelling the *same* registration are separated by the CAS at step 1, whose filter
   * names the status that was read (and the queue position too, when the row had one) — the
   * loser matches nothing and gets a 409, because two cascades from one seat is an
   * oversell. Two callers cancelling
   * *different* confirmed rows on the same shift do run side by side and both read the same
   * head of queue; they are separated further down, where the promotion is itself conditional
   * on the candidate still being WAITLISTED, and the loser simply moves to the next
   * candidate. And a reservation racing the cascade is separated by the held seat.
   *
   * Ownership is proved rather than assumed, and COMPLETED is refused outright. Only
   * CONFIRMED and CHECKED_IN rows release a seat; a WAITLISTED row only shortens the queue.
   */
  public static async cancelRegistration(
    registrationId: string,
    callerVolunteerId?: string,
  ): Promise<{
    cancelled: IRegistration;
    promoted?: IRegistration | null;
  }> {
    const registration = await Registration.findById(registrationId);
    if (!registration) {
      throw ApiError.notFound(
        "Registration not found.",
        ErrorCode.REGISTRATION_NOT_FOUND,
      );
    }
    // Ownership is proved, not assumed. Cancelling frees a seat and promotes the head of the
    // waitlist, so without this anyone holding a registration id could drop a stranger's
    // shift and move themselves up the queue behind it.
    if (!callerVolunteerId) {
      throw ApiError.badRequest(
        "volunteerId (owning volunteer) is required to cancel a registration.",
      );
    }
    if (!sameId(registration.volunteerId, callerVolunteerId)) {
      throw ApiError.forbidden(
        "Only the volunteer who holds this registration may cancel it.",
      );
    }
    if (registration.status === RegistrationStatus.CANCELLED) {
      throw ApiError.badRequest("Registration is already cancelled.");
    }
    // COMPLETED is terminal and still occupies a seat.
    //
    // It fell through both branches below: `wasConfirmed` is false, so no seat was released,
    // and `waitlistPosition` is null, so no queue was touched — the row simply walked
    // backwards to CANCELLED while `filledSlots` went on counting it. The shift then had a
    // seat that no live row accounted for, which is the drift the reconciliation audit in
    // `scripts/benchmarks/loadtest.ts` looks for. A finished shift is not cancellable; the
    // volunteer already worked it.
    if (registration.status === RegistrationStatus.COMPLETED) {
      throw ApiError.badRequest(
        "This shift is already completed and cannot be cancelled.",
      );
    }

    const shiftId = registration.shiftId.toString();
    // The two states that occupy a seat and therefore counted toward `filledSlots`.
    //
    // A trap for whoever wires up SWAP_PENDING: `registration.model.ts` lists it among the
    // schedule-occupying states, but nothing in the codebase ever writes it to a
    // Registration today — swaps rewrite `volunteerId` in place — so it is unreachable
    // here. The moment something does write it, this predicate must account for it, or
    // cancelling such a row will take neither branch below and strand the seat: counted
    // against capacity, occupied by nobody, permanently.
    const wasConfirmed =
      registration.status === RegistrationStatus.CONFIRMED ||
      registration.status === RegistrationStatus.CHECKED_IN;
    const oldWaitlistPos = registration.waitlistPosition;

    // 1. CAS-claim the cancellation: concurrent cancels of the same record can't
    // both proceed to promote (double-promotion overbooks the shift).
    const claimed = await Registration.findOneAndUpdate(
      {
        _id: registration._id,
        status: registration.status,
        ...(oldWaitlistPos === null || oldWaitlistPos === undefined
          ? {}
          : { waitlistPosition: oldWaitlistPos }),
      },
      {
        $set: {
          status: RegistrationStatus.CANCELLED,
          cancelledAt: new Date(),
          waitlistPosition: null,
        },
      },
      { new: true },
    );
    if (!claimed) {
      throw ApiError.conflict(
        "Registration changed concurrently; retry to observe the settled record.",
      );
    }

    let promotedRegistration: IRegistration | null = null;
    // Set if the cascade fails. The seat is released after the try/catch rather than
    // inside it, so the release runs exactly once on every path; this carries the
    // original failure across that release so the caller still sees it.
    let cascadeError: unknown = null;

    if (wasConfirmed) {
      // 2. Hold the seat while the cascade runs.
      //
      // This deliberately does NOT free the seat first. The previous order was
      // decrement → find a candidate → promote → increment back, which opens a window
      // between the decrement and the increment where `filledSlots` understates true
      // occupancy. Several awaits live in that window (a find, a sort, a conflict check
      // per candidate), and a concurrent `reserveShift` only has to pass
      // `$expr: { $lt: ['$filledSlots', '$capacity'] }` during it to claim the seat that
      // is about to be handed to the promoted candidate. Both then hold it, and
      // `filledSlots` finishes at `capacity + 1` — an oversell, in the one invariant this
      // engine exists to guarantee.
      //
      // Holding the seat makes a promotion a *transfer* rather than a release followed by
      // a re-acquire: the seat never becomes claimable, so there is no window to race.
      // `filledSlots` is therefore untouched on the promotion path and only decremented
      // below when no candidate could take it.

      // The row is already CANCELLED at this point, so from here on the seat has no
      // occupant and the only question is who gets it. If anything below throws, the
      // function would exit with the seat still counted and nobody in it — a permanent
      // under-fill. The `catch` releases it and rethrows so the caller still sees the
      // real failure rather than a silent partial success.
      try {
        // 3. FIFO Cascade: Find next eligible waitlist candidate
        const waitlistedCandidates = await Registration.find({
          shiftId: new Types.ObjectId(shiftId),
          status: RegistrationStatus.WAITLISTED,
        }).sort({ waitlistPosition: 1, createdAt: 1 });

        const shiftDoc = await Shift.findById(shiftId);

        for (const candidate of waitlistedCandidates) {
          if (!shiftDoc) break;

          // Verify candidate has no schedule conflicts.
          //
          // Only a *conflict* skips a candidate. A bare `catch` here read every failure as
          // "this person is busy": a replica-set stepdown, a dropped socket, a slow query
          // hitting its timeout — each one silently passed over the head of the queue, with
          // no log and no retry, and handed the seat to whoever was behind them. The person
          // skipped never learns it happened, and neither does anybody else, because the
          // cascade then reports a perfectly ordinary promotion.
          //
          // `assertNoScheduleConflicts` signals a real clash with `ApiError.conflict`, and
          // that is the only thing this treats as one. Anything else rethrows into the outer
          // `catch`, which releases the held seat and surfaces the failure to the caller —
          // the seat goes back to the shift rather than to the wrong volunteer.
          let hasConflict = false;
          try {
            await this.assertNoScheduleConflicts(
              candidate.volunteerId.toString(),
              shiftDoc.startTime,
              shiftDoc.endTime,
              shiftId,
            );
          } catch (probeError) {
            if (!(probeError instanceof ApiError) || probeError.statusCode !== 409) throw probeError;
            hasConflict = true;
          }

          if (hasConflict) {
            // Skipped, never cancelled. The conflict is with a shift they hold *today*;
            // dropping them from this queue would cost them their place permanently for a
            // clash that may be gone by the time the next seat frees.
            continue;
          }

          // Promote conditionally, not with a plain save().
          //
          // The CAS at the top of this function serialises concurrent cancels of the *same*
          // registration, but two cancels of *different* confirmed rows on the same shift run
          // side by side, and both read the same head-of-queue candidate. An unconditional
          // `candidate.save()` lets both promote that one row: `waitlistCount` drops twice for
          // a single promotion, and two released seats collapse onto one person — the shift
          // ends up permanently under-filled. Same class of lost update as the oversell above,
          // one level out.
          //
          // Filtering on `status: WAITLISTED` makes the promotion itself the claim. The loser
          // gets null and simply moves to the next candidate, so its held seat still finds an
          // owner rather than being double-assigned.
          const promoted = await Registration.findOneAndUpdate(
            { _id: candidate._id, status: RegistrationStatus.WAITLISTED },
            {
              $set: {
                status: RegistrationStatus.CONFIRMED,
                confirmedAt: new Date(),
                waitlistPosition: null,
              },
            },
            { new: true },
          );
          if (!promoted) {
            // A concurrent cascade claimed this candidate first — try the next in line.
            continue;
          }

          promotedRegistration = promoted;

          // The seat transfers from the canceller to this candidate, so occupancy is
          // unchanged and `filledSlots` must not move. Only the queue shrinks.
          await Shift.findByIdAndUpdate(shiftId, {
            $inc: { waitlistCount: -1, version: 1 },
          });

          // Re-index remaining waitlist positions monotonically
          await this.reindexWaitlist(shiftId);
          break;
        }

        // No eligible candidate — the queue was empty or everyone in it has a conflict.
        // Only now does the seat genuinely become free, and releasing it here means it was
        // never briefly claimable while a promotion was still in flight.
      } catch (err) {
        // Do not release here. Recording the failure and falling through means the
        // release below is reached by exactly one path, whether the cascade succeeded
        // or threw.
        cascadeError = err;
      }

      // Release the held seat — exactly once, on every path.
      //
      // This sits outside the try deliberately. An earlier version released inside it and
      // released again in the catch, guarded by a flag set after the await. That flag
      // cannot work: `$inc` is not idempotent, and a write can apply on the server and
      // still reject on the client (a socket dropped after the update landed). Setting
      // the flag after the await double-decrements in exactly that case; setting it
      // before strands the seat when the write genuinely never applied. There is no
      // correct placement for it, because the question "did that write apply?" is not
      // answerable from a rejected promise.
      //
      // Hoisting the release removes the question. One decision, one write, no retry —
      // at-most-once semantics, which for a counter guarding capacity is the right side
      // to err on: a stranded seat under-fills one shift, a double release oversells it.
      if (!promotedRegistration) {
        try {
          await Shift.findByIdAndUpdate(shiftId, {
            $inc: { filledSlots: -1, version: 1 },
          });
        } catch (releaseError) {
          // A cascade failure is the more useful error to surface; only report this one
          // when the cascade itself was fine and handing the seat back is what broke.
          if (!cascadeError) throw releaseError;
        }
      }

      if (cascadeError) throw cascadeError;
    } else if (oldWaitlistPos !== null && oldWaitlistPos !== undefined) {
      // Cancelled record was waitlisted -> decrement waitlist count and reindex
      await Shift.findByIdAndUpdate(shiftId, {
        $inc: { waitlistCount: -1, version: 1 },
      });
      await this.reindexWaitlist(shiftId);
    }

    // 4. Emit SSE Broadcast
    eventHub.broadcast({
      type: "REGISTRATION_CANCELLED",
      data: {
        registrationId,
        shiftId,
        wasConfirmed,
        promotedVolunteerId: promotedRegistration
          ? promotedRegistration.volunteerId
          : null,
      },
    });

    // …and the inward-facing half, which had been declared and never fired.
    //
    // `registration.cancelled` has been in `DomainEventMap` since the bus was written, with a
    // full payload type, and nothing emitted it. Every other one of the eight events has
    // exactly one emitter. The consequence was not that a feature was missing — it was that
    // the bus published a contract with a hole in it: a reward rule, or a plugin author
    // reading the map as the list of what they may react to, could write a listener for this
    // and get silence. `emit` returns early when a name has no listeners, so nothing anywhere
    // would have said so.
    //
    // Emitted here rather than at the CAS above for the same reason `registration.created` is
    // emitted after its write: a listener does its own reads, and by this point the cascade
    // has settled, so a listener that goes and looks at the shift sees the promotion too. The
    // bus dispatches on `setImmediate`, so this costs the caller nothing.
    //
    // `reason` is deliberately absent rather than guessed at. This method does not take one —
    // an organiser cancelling on someone's behalf and a volunteer cancelling their own seat
    // arrive here identically — and inventing a value would make the field a lie the first
    // time somebody trusted it.
    domainEvents.emit("registration.cancelled", {
      accountId: String(registration.volunteerId),
      shiftId: String(shiftId),
    });

    if (promotedRegistration) {
      const promotedVolunteer = await Volunteer.findById(
        promotedRegistration.volunteerId,
      );
      eventHub.broadcast({
        type: "WAITLIST_PROMOTED",
        data: {
          shiftId,
          volunteerId: promotedRegistration.volunteerId,
          volunteerName: promotedVolunteer
            ? promotedVolunteer.name
            : "Volunteer",
          registrationId: promotedRegistration._id,
        },
      });
    }

    return {
      cancelled: claimed,
      promoted: promotedRegistration,
    };
  }

  /**
   * Renumber a shift's queue to 1..n after somebody leaves it.
   *
   * Contiguity is not cosmetic. The cascade orders candidates by `waitlistPosition` and
   * promotes the first that survives its conflict check, so these numbers *are* the queue:
   * a gap or a duplicate left behind by a cancellation is FIFO quietly turning into
   * something else. `createdAt` is the tie-break, which is what keeps the order sane while a
   * renumbering is only partly applied.
   *
   * A row is written only when its position actually changes, so an already-contiguous queue
   * costs one read and no writes at all — which matters because every cancellation on a
   * shift calls this.
   */
  private static async reindexWaitlist(shiftId: string): Promise<void> {
    const remaining = await Registration.find({
      shiftId: new Types.ObjectId(shiftId),
      status: RegistrationStatus.WAITLISTED,
    }).sort({ waitlistPosition: 1, createdAt: 1 });

    // Conditional on the row still being in the queue it is being renumbered inside.
    //
    // Reindexing is a read-all followed by a write-each, and between the two a concurrent
    // cascade can promote a row to CONFIRMED or a concurrent cancel can retire it. An
    // unconditional write then stamps a waitlist position onto a row that has left the
    // waitlist — a confirmed volunteer carrying `waitlistPosition: 3`, which the next
    // cascade's `sort({ waitlistPosition: 1 })` reads as queue order.
    //
    // (Mongoose sends a delta for a loaded document, so `save()` did not write the stale
    // `status` back over the concurrent change — the promotion survived. The position did
    // not, and that is enough to promote the wrong person next time.)
    //
    // At-most-once is the right side to err on here as everywhere else in this file: a row
    // that misses a renumbering keeps a position that is merely too high, and the next
    // cancel reindexes again. A row that is renumbered after leaving the queue corrupts the
    // order for everybody behind it.
    for (let i = 0; i < remaining.length; i++) {
      const targetPos = i + 1;
      if (remaining[i].waitlistPosition !== targetPos) {
        await Registration.updateOne(
          { _id: remaining[i]._id, status: RegistrationStatus.WAITLISTED },
          { $set: { waitlistPosition: targetPos } },
        );
      }
    }
  }

  /**
   * Three scheduling rules in one pass: no overlap, thirty minutes of rest either side, and
   * at most eight hours in a calendar day.
   *
   * Only the three schedule-occupying states are counted — CONFIRMED, CHECKED_IN and
   * SWAP_PENDING. WAITLISTED is absent deliberately: a queue place is not an assignment, so
   * a volunteer may sit on any number of overlapping waitlists, and the question is deferred
   * until a promotion actually tries to give them one of those shifts. That deferral is why
   * the cancellation cascade calls this again for every candidate it considers.
   *
   * `excludeShiftId` exists for the swap paths. A volunteer receiving a shift is usually
   * giving one up in the same breath, and the shift they surrender is still CONFIRMED to
   * them at the moment of the check — without excluding it, a straight trade of two
   * overlapping shifts would refuse itself. The cascade passes it too, though there it is
   * belt-and-braces: the candidate's row on that shift is WAITLISTED and so outside the
   * query anyway.
   *
   * This is read-then-act and holds no lock of its own. The lock is `reserveShift`'s, taken
   * before this is called; called directly and concurrently for one volunteer, it can pass
   * twice for two bookings that together break the rule, which is exactly the TOCTOU window
   * the reservation lock exists to close. The `session` parameter is plumbed through for a
   * transactional caller, and no caller passes one today.
   *
   * All three failures are 409s and each names its reason — `SCHEDULE_CONFLICT` for a
   * genuine overlap, `SCHEDULE_BUFFER_CONFLICT` for a gap shorter than the buffer, and
   * `DAILY_FATIGUE_EXCEEDED` for the daily cap. The cascade's probe filters on the status
   * code alone, so all three read to it as "this candidate is busy" while anything that is
   * not a 409 — a stepdown, a timeout — is rethrown rather than mistaken for one.
   */
  public static async assertNoScheduleConflicts(
    volunteerId: string,
    newStart: Date,
    newEnd: Date,
    excludeShiftId?: string,
    session?: ClientSession,
  ): Promise<void> {
    const bufferedStart = new Date(newStart.getTime() - REST_BUFFER_MS);
    const bufferedEnd = new Date(newEnd.getTime() + REST_BUFFER_MS);

    // 1. Fetch user's active registrations
    const query: Record<string, unknown> = {
      volunteerId: new Types.ObjectId(volunteerId),
      status: {
        $in: [
          RegistrationStatus.CONFIRMED,
          RegistrationStatus.CHECKED_IN,
          RegistrationStatus.SWAP_PENDING,
        ],
      },
    };

    if (excludeShiftId) {
      query.shiftId = { $ne: new Types.ObjectId(excludeShiftId) };
    }

    const activeRegs = await Registration.find(query)
      .populate("shiftId")
      .session(session || null);

    for (const reg of activeRegs) {
      const activeShift = reg.shiftId as unknown as IShift;
      if (!activeShift || !activeShift.startTime || !activeShift.endTime)
        continue;

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
          isDirectOverlap
            ? ErrorCode.SCHEDULE_CONFLICT
            : ErrorCode.SCHEDULE_BUFFER_CONFLICT,
          {
            conflictingShiftId: activeShift._id,
            conflictingShiftTitle: activeShift.title,
            requiredBufferMinutes: 30,
          },
        );
      }
    }

    // Daily fatigue threshold: at most 8 hours per calendar day in UIUC wall-clock time.
    // The zone matters because the rule is about a person's night, and a UTC day boundary
    // falls at 6 p.m. locally, mid-shift. Hours are attributed by overlap so an overnight
    // shift splits across the two days it actually spans, instead of loading all of it onto
    // the first and leaving the second free. The zone maths is `Intl`, so no date library.
    // EVERY day the new shift touches, not only the one it starts on.
    //
    // The overlap split is what makes an overnight shift count against both days it spans, and
    // checking only the start day threw half of that away: a volunteer with seven hours already
    // booked on Saturday could add a shift running 22:00 Friday to 06:00 Saturday, whose six
    // Saturday hours were never weighed against Saturday's total. Thirteen hours in a day, from
    // a rule that exists precisely to stop that, and the comment above already described the
    // behaviour this now has.
    const days = [chicagoDayRange(newStart)];
    const endDay = chicagoDayRange(newEnd);
    if (endDay.dayStart.getTime() !== days[0].dayStart.getTime()) days.push(endDay);

    for (const { dayStart, dayEnd } of days) {
      const overlapMs = (aStart: Date, aEnd: Date): number =>
        Math.max(
          0,
          Math.min(aEnd.getTime(), dayEnd.getTime()) -
            Math.max(aStart.getTime(), dayStart.getTime()),
        );

      let totalDurationMs = overlapMs(newStart, newEnd);

      for (const reg of activeRegs) {
        const activeShift = reg.shiftId as unknown as IShift;
        if (!activeShift || !activeShift.startTime || !activeShift.endTime)
          continue;

        totalDurationMs += overlapMs(
          new Date(activeShift.startTime),
          new Date(activeShift.endTime),
        );
      }

      if (totalDurationMs > MAX_DAILY_HOURS_MS) {
        const hours = (totalDurationMs / (1000 * 3600)).toFixed(1);
        throw ApiError.conflict(
          `Daily fatigue limit exceeded: Adding this shift brings total daily volunteer time to ${hours} hours (Max: 8.0 hours).`,
          ErrorCode.DAILY_FATIGUE_EXCEEDED,
          { totalHoursRequested: hours, maxDailyHoursAllowed: 8.0 },
        );
      }
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
    if (filters.volunteerId)
      query.volunteerId = new Types.ObjectId(filters.volunteerId);
    if (filters.status) query.status = filters.status;

    return Registration.find(query)
      .populate("shiftId", "title location startTime endTime category")
      // `email` is deliberately not projected: this roster read is visible to any
      // volunteer-kind caller, and a volunteer has no need for another volunteer's email.
      // Leaking it here was the /volunteers PII class living on a second path.
      .populate(
        "volunteerId",
        "name role certifications karmaPoints prestigeTier",
      )
      .sort({ createdAt: -1 });
  }
}
