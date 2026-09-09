/**
 * Registration — the join between a Volunteer and a Shift, and the row that carries
 * scheduling state through its whole lifecycle.
 *
 * This is the busiest collection in the system: every reservation, waitlist entry,
 * promotion, check-in, swap and cancellation mutates a row here. Two of the four
 * system invariants are enforced by the indexes at the bottom of this file rather
 * than in application code, because application-level checks are read-then-write and
 * lose races under the contention this system is built for.
 *
 * Lifecycle (a row moves forward, never backward):
 *
 *   CONFIRMED ──check-in──> CHECKED_IN ──check-out──> COMPLETED
 *       │                        │
 *       └──────cancel────────────┴──> CANCELLED
 *
 *   WAITLISTED ──cascade promotion──> CONFIRMED
 *   WAITLISTED ──cancel──> CANCELLED
 *
 * SWAP_PENDING is defined for a row mid-trade — the schedule-conflict checker and the
 * partial unique index both count it as occupied — but note that **nothing currently writes
 * it**: swaps rewrite `volunteerId` on the existing registration rather than parking it in an
 * intermediate state. It is read-side only today. Anything that starts writing it must also
 * teach `cancelRegistration` to treat it as seat-occupying, or cancelling such a row will
 * release no seat and strand it.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Registration lifecycle states.
 *
 * Two different subsets matter, and conflating them is easy:
 *
 *   - **Index-active** (CONFIRMED, WAITLISTED, CHECKED_IN, SWAP_PENDING, COMPLETED) — the
 *     five states named in the partial unique index below. One row per (shift, volunteer)
 *     across all five. CANCELLED alone is excluded, so a volunteer can re-register for a
 *     shift they previously cancelled — but not for one they already worked.
 *   - **Schedule-occupying** (CONFIRMED, CHECKED_IN, SWAP_PENDING) — the three states
 *     `assertNoScheduleConflicts` treats as claiming the volunteer's time. WAITLISTED is
 *     deliberately absent: a queue position is not an assignment, so a volunteer may sit
 *     on several overlapping waitlists and is only checked for conflicts on promotion.
 */
export enum RegistrationStatus {
  CONFIRMED = 'CONFIRMED',
  WAITLISTED = 'WAITLISTED',
  CANCELLED = 'CANCELLED',
  CHECKED_IN = 'CHECKED_IN',
  COMPLETED = 'COMPLETED',
  SWAP_PENDING = 'SWAP_PENDING',
}

/** One volunteer's hold on one shift: confirmed seat or queue place, through to completion. */
export interface IRegistration extends Document {
  shiftId: Types.ObjectId;
  volunteerId: Types.ObjectId;
  status: RegistrationStatus;
  /**
   * 1-based queue position, or null when the row is not WAITLISTED.
   *
   * Positions are kept contiguous (1..n) by `reindexWaitlist` after any removal, so
   * "head of queue" is always `waitlistPosition: 1` and the cascade never has to scan.
   */
  waitlistPosition?: number | null;
  /**
   * The idempotency key that created this row. Retained after commit so a replayed
   * request can be answered from the stored response instead of double-booking.
   */
  idempotencyKey: string;
  confirmedAt?: Date;
  cancelledAt?: Date;
  checkInTime?: Date;
  checkOutTime?: Date;
  /** Karma actually paid at check-out. Written once, on the COMPLETED transition. */
  earnedKarma?: number;
  createdAt: Date;
  updatedAt: Date;
}

const RegistrationSchema = new Schema<IRegistration>(
  {
    shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true, index: true },
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    status: {
      type: String,
      enum: Object.values(RegistrationStatus),
      required: true,
      default: RegistrationStatus.CONFIRMED,
      index: true,
    },
    waitlistPosition: { type: Number, default: null },
    idempotencyKey: { type: String, required: true },
    confirmedAt: { type: Date },
    cancelledAt: { type: Date },
    checkInTime: { type: Date },
    checkOutTime: { type: Date },
    earnedKarma: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/**
 * Invariant I2 — one active registration per volunteer per shift.
 *
 * Enforced by the database, not by a service-layer lookup, because "check then insert"
 * is a TOCTOU race: two concurrent reservations both read "no existing row" and both
 * insert. This partial unique index makes the second insert fail with duplicate-key
 * error 11000, which `errorHandler` maps to a 409.
 *
 * The partial filter is what makes re-registration possible after a CANCELLED row: a
 * volunteer who drops out and changes their mind can sign up again.
 *
 * COMPLETED is IN the filter, and that is the difference between "I withdrew" and "I already
 * did this". Excluding it let a volunteer who had worked a shift and been paid for it register
 * for the same shift again while it was still open, mint a fresh QR token, check in, check out
 * and be paid a second time — with `filledSlots` incremented again each round, permanently
 * consuming a seat somebody else could have taken. Cancelling is a change of mind; finishing
 * is not something you can do twice.
 */
RegistrationSchema.index(
  { shiftId: 1, volunteerId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          RegistrationStatus.CONFIRMED,
          RegistrationStatus.WAITLISTED,
          RegistrationStatus.CHECKED_IN,
          RegistrationStatus.SWAP_PENDING,
          RegistrationStatus.COMPLETED,
        ],
      },
    },
  }
);

/**
 * Invariant I4 — FIFO waitlist ordering.
 *
 * The cancellation cascade asks "who is at the head of this shift's queue?" on every
 * confirmed drop. This partial index answers that from the index alone: it is scoped
 * to WAITLISTED rows only, so it stays small even when the collection is dominated by
 * COMPLETED history, and it is ordered so the head is the first entry rather than a
 * sort over the whole queue.
 */
RegistrationSchema.index(
  { shiftId: 1, status: 1, waitlistPosition: 1 },
  { partialFilterExpression: { status: RegistrationStatus.WAITLISTED } }
);

export const Registration = mongoose.model<IRegistration>('Registration', RegistrationSchema);
