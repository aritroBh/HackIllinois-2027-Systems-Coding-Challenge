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
  createdAt: Date;
  updatedAt: Date;
}

const CheckInSchema = new Schema<ICheckIn>(
  {
    registrationId: { type: Schema.Types.ObjectId, ref: 'Registration', required: true, index: true },
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
  },
  { timestamps: true }
);

export const CheckIn = mongoose.model<ICheckIn>('CheckIn', CheckInSchema);
