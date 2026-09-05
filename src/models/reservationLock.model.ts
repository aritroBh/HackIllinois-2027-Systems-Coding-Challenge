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
  acquiredAt: Date;
  expiresAt: Date;
}

const ReservationLockSchema = new Schema<IReservationLock>(
  {
    key: { type: String, required: true, unique: true, index: true },
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
