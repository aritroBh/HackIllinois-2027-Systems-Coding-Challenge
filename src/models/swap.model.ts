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
