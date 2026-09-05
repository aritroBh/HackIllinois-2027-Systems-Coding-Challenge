import mongoose, { Schema, Document, Types } from 'mongoose';

export enum RegistrationStatus {
  CONFIRMED = 'CONFIRMED',
  WAITLISTED = 'WAITLISTED',
  CANCELLED = 'CANCELLED',
  CHECKED_IN = 'CHECKED_IN',
  COMPLETED = 'COMPLETED',
  SWAP_PENDING = 'SWAP_PENDING',
}

export interface IRegistration extends Document {
  shiftId: Types.ObjectId;
  volunteerId: Types.ObjectId;
  status: RegistrationStatus;
  waitlistPosition?: number | null;
  idempotencyKey: string;
  confirmedAt?: Date;
  cancelledAt?: Date;
  checkInTime?: Date;
  checkOutTime?: Date;
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

// Invariant I2: One active registration per volunteer per shift
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
        ],
      },
    },
  }
);

// Invariant I4: FIFO waitlist query acceleration
RegistrationSchema.index(
  { shiftId: 1, status: 1, waitlistPosition: 1 },
  { partialFilterExpression: { status: RegistrationStatus.WAITLISTED } }
);

export const Registration = mongoose.model<IRegistration>('Registration', RegistrationSchema);
