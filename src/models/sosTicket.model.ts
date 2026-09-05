import mongoose, { Schema, Document, Types } from 'mongoose';

export enum SOSTicketCategory {
  HARDWARE_MALFUNCTION = 'HARDWARE_MALFUNCTION',
  SPILL_CLEANUP = 'SPILL_CLEANUP',
  POWER_OUTAGE = 'POWER_OUTAGE',
  MEDICAL_FIRST_AID = 'MEDICAL_FIRST_AID',
  LOGISTICS_SUPPLIES = 'LOGISTICS_SUPPLIES',
}

export enum SOSTicketUrgency {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export enum SOSTicketStatus {
  OPEN = 'OPEN',
  DISPATCHED = 'DISPATCHED',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
}

export interface ISOSTicket extends Document {
  hackerName: string;
  tableLocation: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  category: SOSTicketCategory;
  description: string;
  urgency: SOSTicketUrgency;
  requiredSkill?: string;
  status: SOSTicketStatus;
  assignedVolunteerId?: Types.ObjectId | null;
  karmaBounty: number;
  dispatchedAt?: Date;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SOSTicketSchema = new Schema<ISOSTicket>(
  {
    hackerName: { type: String, required: true, trim: true },
    tableLocation: { type: String, required: true, trim: true },
    coordinates: {
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
    },
    category: {
      type: String,
      enum: Object.values(SOSTicketCategory),
      required: true,
      default: SOSTicketCategory.LOGISTICS_SUPPLIES,
    },
    description: { type: String, required: true },
    urgency: {
      type: String,
      enum: Object.values(SOSTicketUrgency),
      required: true,
      default: SOSTicketUrgency.MEDIUM,
    },
    requiredSkill: { type: String },
    status: {
      type: String,
      enum: Object.values(SOSTicketStatus),
      required: true,
      default: SOSTicketStatus.OPEN,
      index: true,
    },
    assignedVolunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
    karmaBounty: { type: Number, default: 150, min: 50 },
    dispatchedAt: { type: Date },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

export const SOSTicket = mongoose.model<ISOSTicket>('SOSTicket', SOSTicketSchema);
