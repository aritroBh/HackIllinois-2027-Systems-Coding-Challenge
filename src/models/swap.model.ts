/**
 * ShiftSwap — a proposal to trade shifts, and the input to the cycle finder.
 *
 * Two shapes share this collection:
 *
 *  - **Bilateral.** `targetVolunteerId` is set. A names B's specific shift; B accepts;
 *    the two registrations exchange owners inside a transaction.
 *  - **Open / cyclic.** `targetVolunteerId` is null and `desiredShiftIds` lists what the
 *    proposer wants. These are the edges of a directed graph — an edge u→v means u wants
 *    the shift v currently holds. `CyclicTradeFinder` searches that graph for elementary
 *    cycles, which is how a 3-way trade completes when no bilateral pair exists.
 *
 * Direct 1-to-1 trades fail most of the time in practice: A wants B's shift, B wants
 * C's, C wants A's. Cycle discovery is what turns that deadlock into one rotation.
 *
 * `status` is the concurrency guard — a proposal is claimed PENDING → EXECUTED so two
 * resolvers cannot execute the same trade twice.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export enum SwapStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
}

export interface IShiftSwap extends Document {
  proposerVolunteerId: Types.ObjectId;
  proposerShiftId: Types.ObjectId;
  targetVolunteerId?: Types.ObjectId | null;
  targetShiftId: Types.ObjectId;
  desiredShiftIds?: Types.ObjectId[];
  status: SwapStatus;
  isCyclic?: boolean;
  cycleParticipants?: Types.ObjectId[];
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ShiftSwapSchema = new Schema<IShiftSwap>(
  {
    proposerVolunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    proposerShiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true },
    targetVolunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null, index: true },
    targetShiftId: { type: Schema.Types.ObjectId, ref: 'Shift', required: true },
    desiredShiftIds: [{ type: Schema.Types.ObjectId, ref: 'Shift' }],
    status: {
      type: String,
      enum: Object.values(SwapStatus),
      default: SwapStatus.PENDING,
      index: true,
    },
    isCyclic: { type: Boolean, default: false },
    cycleParticipants: [{ type: Schema.Types.ObjectId, ref: 'Volunteer' }],
    failureReason: { type: String },
  },
  { timestamps: true }
);

export const ShiftSwap = mongoose.model<IShiftSwap>('ShiftSwap', ShiftSwapSchema);
