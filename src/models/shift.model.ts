import mongoose, { Schema, Document } from 'mongoose';

export enum ShiftCategory {
  FOOD = 'FOOD',
  LOGISTICS = 'LOGISTICS',
  SPONSOR_RELATIONS = 'SPONSOR_RELATIONS',
  INFO_DESK = 'INFO_DESK',
  HARDWARE_LAB = 'HARDWARE_LAB',
  MENTOR_SUPPORT = 'MENTOR_SUPPORT',
  CLEANUP = 'CLEANUP',
}

export interface IShift extends Document {
  title: string;
  description: string;
  category: ShiftCategory;
  location: string;
  startTime: Date;
  endTime: Date;
  capacity: number;
  filledSlots: number;
  waitlistCount: number;
  requiredSkills: string[];
  baseKarma: number;
  manualSurgeMultiplier: number;
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ShiftSchema = new Schema<IShift>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: {
      type: String,
      enum: Object.values(ShiftCategory),
      required: true,
      default: ShiftCategory.LOGISTICS,
    },
    location: { type: String, required: true },
    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: true, index: true },
    capacity: { type: Number, required: true, min: 1 },
    filledSlots: { type: Number, required: true, default: 0, min: 0 },
    waitlistCount: { type: Number, required: true, default: 0, min: 0 },
    requiredSkills: { type: [String], default: [] },
    baseKarma: { type: Number, default: 100, min: 10 },
    manualSurgeMultiplier: { type: Number, default: 1.0, min: 1.0, max: 5.0 },
    version: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

// Compound indexes for interval searches and scheduling lookups
ShiftSchema.index({ startTime: 1, endTime: 1 });
ShiftSchema.index({ category: 1, isActive: 1 });

export const Shift = mongoose.model<IShift>('Shift', ShiftSchema);
