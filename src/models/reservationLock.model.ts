/**
 * The per-volunteer reservation mutex, and the one function that names a lock.
 *
 * Two things to know before reading the code. First, the lock is a *document with a unique
 * `key`*, not a flag on the volunteer: acquiring it is an insert that either succeeds or
 * fails with a duplicate key, which is a decision the database makes and two racing processes
 * cannot both win. Second, it is held across a read-then-act sequence rather than around a
 * single write, which is why it exists at all — the capacity guard needs no lock, but the
 * rest-buffer and fatigue checks read a volunteer's other shifts and then decide, and that
 * gap is what one person's two simultaneous requests would otherwise slip through.
 */
import mongoose, { Schema, Document } from 'mongoose';

/**
 * Short-lived per-volunteer mutex serializing shift reservations.
 *
 * The rest-buffer and fatigue checks are read-then-act: two concurrent
 * reserveShift calls for overlapping shifts by one volunteer could both pass
 * validation before either writes. Holding this lock for the duration of a
 * reservation closes that TOCTOU window across processes (the lock lives in
 * MongoDB, not in process memory). Locks self-expire via TTL as a
 * crash backstop; the happy path releases explicitly in a finally block.
 */
export interface IReservationLock extends Document {
  key: string;
  token: string;
  acquiredAt: Date;
  expiresAt: Date;
}

const ReservationLockSchema = new Schema<IReservationLock>(
  {
    key: { type: String, required: true, unique: true, index: true },
    /**
     * Who currently holds this lock.
     *
     * A lock whose holder is anonymous can be released by somebody who no longer owns it. The
     * stale-lock path here hands a key from a slow request to a waiting one, and without a
     * fence the slow request's `finally` then deletes the *new* holder's lock — leaving two
     * reservations for one volunteer running at once, which is the single thing this lock
     * exists to prevent. Every acquisition mints a token and every release names it.
     */
    token: { type: String, required: true },
    acquiredAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

// Crash backstop: orphaned locks vanish automatically.
ReservationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ReservationLock = mongoose.model<IReservationLock>(
  'ReservationLock',
  ReservationLockSchema
);

/**
 * Canonical lock name for a volunteer.
 *
 * Lowercased defensively. Request-borne ids are already normalised by the `objectId()`
 * schema helper, but services are also called directly (tests, internal flows, the
 * seeder), and an un-normalised id here would mint a *second* lock document for the same
 * person — which silently defeats the mutex this lock exists to provide.
 */
export function volunteerLockKey(volunteerId: string): string {
  return `vol:${volunteerId.toLowerCase()}`;
}
