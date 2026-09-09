/**
 * CheckIn — the attendance record produced when a volunteer's rotating QR token is
 * accepted at a desk scanner.
 *
 * This collection is the durable half of the anti-replay defence. The in-process nonce
 * cache in `DynamicQrTokenEngine` is fast but forgets on restart and is not shared
 * across instances, so it cannot be the system of record. The `unique` constraint on
 * `nonce` below is: a replayed token fails the insert with duplicate-key error 11000,
 * which the check-in service converts into a 409 REPLAY_ATTACK_DETECTED. That holds
 * across restarts and across replicas.
 *
 * Karma is not awarded here. It is computed at check-out, when the worked duration is
 * known, and written to both this row (`karmaAwarded`) and the volunteer's balance.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/** One attendance record: the verified scan, its single-use nonce, and any karma paid. */
export interface ICheckIn extends Document {
  registrationId: Types.ObjectId;
  shiftId: Types.ObjectId;
  volunteerId: Types.ObjectId;
  checkInTime: Date;
  checkOutTime?: Date;
  durationMinutes?: number;
  karmaAwarded: number;
  nonce: string;
  verifiedBy: string;
  /**
   * The account that presented the scan, when a session was behind it.
   *
   * `verifiedBy` is a label the client sends and can therefore say anything; this is read
   * from the cookie. Nullable because `legacy` mode admits an unauthenticated desk.
   */
  verifiedByAccountId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const CheckInSchema = new Schema<ICheckIn>(
  {
    /**
     * One attendance per registration, enforced here rather than checked in the service.
     *
     * The service read the registration's status and returned the existing row if it was
     * already checked in, which is correct sequentially and useless under concurrency: ten
     * scans of ten freshly minted tokens all read CONFIRMED and all created a row. Ten rows
     * become ten check-outs and ten payouts, from a volunteer whose phone retried or a desk
     * with several scanners. The nonce index does not help — every token has its own nonce,
     * by design, so that a photograph goes stale.
     *
     * `unique` makes the database the serialisation point. The loser of the race gets a
     * duplicate key, which the service turns back into the row that won.
     */
    registrationId: { type: Schema.Types.ObjectId, ref: 'Registration', required: true, unique: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true, index: true },
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    checkInTime: { type: Date, required: true, default: Date.now },
    checkOutTime: { type: Date },
    durationMinutes: { type: Number },
    karmaAwarded: { type: Number, default: 0 },
    /**
     * Single-use token identifier. `unique: true` is the cross-process replay shield —
     * see the file header. Never relax this to a plain index.
     */
    nonce: { type: String, required: true, unique: true },
    verifiedBy: { type: String, default: 'DESK_SCANNER' },
    verifiedByAccountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
  },
  { timestamps: true }
);

export const CheckIn = mongoose.model<ICheckIn>('CheckIn', CheckInSchema);
