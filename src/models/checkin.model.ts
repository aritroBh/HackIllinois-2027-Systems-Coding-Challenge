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
    nonce: { type: String, required: true, unique: true },
    verifiedBy: { type: String, default: 'DESK_SCANNER' },
  },
  { timestamps: true }
);

export const CheckIn = mongoose.model<ICheckIn>('CheckIn', CheckInSchema);
