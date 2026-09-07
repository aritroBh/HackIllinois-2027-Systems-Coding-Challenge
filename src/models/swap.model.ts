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

/**
 * Only three of these six are ever written today, and the distinction matters to anyone
 * filtering on them.
 *
 * `PENDING` is the initial state and the CAS predicate for every execution; `EXECUTED` and
 * `FAILED` are the two terminal states `SwapService` writes — the first when the trade
 * committed, the second with a `failureReason` when a leg turned out to be invalid or the
 * transaction did not commit.
 *
 * `ACCEPTED`, `REJECTED` and `CANCELLED` are declared and nothing in `src/` sets them. A
 * bilateral acceptance goes straight from PENDING to EXECUTED inside one transaction, so
 * there is no moment for an ACCEPTED row to exist; a rejection or a withdrawal has no route
 * at all. They are left here because `listSwapsQuerySchema` accepts the whole enum and a
 * filter for a state nothing writes should return an empty list rather than a 400 — but do
 * not read their presence as evidence that a reject or cancel endpoint exists.
 */
export enum SwapStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
}

/**
 * `targetShiftId` is required in both shapes and means different things in each: in a
 * bilateral proposal it is the specific shift being asked for, and in an open one it is the
 * proposer's opening ask, with `desiredShiftIds` carrying the full set of edges the cycle
 * finder may use. `isCyclic` and `cycleParticipants` are written only when a rotation
 * executes, so they are the record of which ring a proposal ended up in.
 */
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
