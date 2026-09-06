/**
 * SOSTicket — a hacker's distress call and its dispatch record.
 *
 * A hacker with a dead power strip or a shorted soldering station files a ticket with
 * their coordinates. Dispatch scores on-duty volunteers by required skill and then by
 * Haversine distance to those coordinates, assigning the nearest qualified responder.
 *
 * Lifecycle: OPEN ──dispatch──> DISPATCHED ──resolve──> RESOLVED (or CANCELLED).
 *
 * The OPEN → DISPATCHED transition is a compare-and-swap on `status` so two concurrent
 * dispatchers cannot assign two responders to the same incident.
 *
 * `karmaBounty` is the reward paid on resolution — higher for urgent or unpleasant work,
 * which is what makes anyone take the 3 a.m. spill.
 */
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

/**
 * One vocabulary, used by the server, the pips in the hacker's SOS view and the tests
 * (plan §A7). ACKNOWLEDGED and ON_SCENE are optional intermediate states, so the original
 * OPEN → DISPATCHED → RESOLVED path still works exactly as it did.
 */
export enum SOSTicketStatus {
  OPEN = 'OPEN',
  DISPATCHED = 'DISPATCHED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  ON_SCENE = 'ON_SCENE',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
}

/** Terminal states have no outgoing edges; every other move must appear here. */
export const SOS_TRANSITIONS: Readonly<Record<SOSTicketStatus, readonly SOSTicketStatus[]>> = {
  [SOSTicketStatus.OPEN]: [SOSTicketStatus.DISPATCHED, SOSTicketStatus.RESOLVED, SOSTicketStatus.CANCELLED],
  // Reassignment sends a ticket back to OPEN; a responder may also resolve without ever
  // pressing acknowledge, which is what actually happens when someone is already standing there.
  [SOSTicketStatus.DISPATCHED]: [SOSTicketStatus.ACKNOWLEDGED, SOSTicketStatus.ON_SCENE, SOSTicketStatus.RESOLVED, SOSTicketStatus.OPEN, SOSTicketStatus.CANCELLED],
  [SOSTicketStatus.ACKNOWLEDGED]: [SOSTicketStatus.ON_SCENE, SOSTicketStatus.RESOLVED, SOSTicketStatus.OPEN, SOSTicketStatus.CANCELLED],
  [SOSTicketStatus.ON_SCENE]: [SOSTicketStatus.RESOLVED, SOSTicketStatus.OPEN, SOSTicketStatus.CANCELLED],
  [SOSTicketStatus.RESOLVED]: [],
  [SOSTicketStatus.CANCELLED]: [],
};

export function canTransition(from: SOSTicketStatus, to: SOSTicketStatus): boolean {
  return (SOS_TRANSITIONS[from] ?? []).includes(to);
}

export interface ISOSHistoryEntry {
  status: SOSTicketStatus;
  at: Date;
  by?: Types.ObjectId | null;
  note?: string;
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
  acknowledgedAt?: Date | null;
  onSceneAt?: Date | null;
  resolvedAt?: Date;
  /** Who raised it, when the creator is a signed-in account (hacker SOS). */
  createdById?: Types.ObjectId | null;
  /** Every state change, in order. */
  history: ISOSHistoryEntry[];
  /** Set once, when the 3-minute no-acknowledgement escalation fires. */
  escalatedAt?: Date | null;
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
    karmaBounty: {
      type: Number,
      default: 150,
      min: 0,
      /**
       * Zero, or a real offer. Never something in between.
       *
       * The floor of fifty lives in the Zod schema, where a caller's number is validated, and
       * that is the right place for it: fifty is a judgement about what is worth a responder's
       * walk, and it applies to what somebody asks for. Zero is not a small offer — it is the
       * system recording that no reward is attached, which it does when nobody could be
       * charged for one (a creatorless ticket in legacy mode, or a pack with the daily budget
       * set to zero, which plainly means bounties are off). A model minimum of fifty made that
       * state unrepresentable and turned an accounting rule into a refusal to file a
       * distress call.
       */
      validate: {
        validator: (v: number) => v === 0 || v >= 50,
        message: 'A bounty is either zero or at least 50 karma.',
      },
    },
    dispatchedAt: { type: Date },
    acknowledgedAt: { type: Date, default: null },
    onSceneAt: { type: Date, default: null },
    resolvedAt: { type: Date },
    createdById: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null, index: true },
    history: [
      {
        _id: false,
        status: { type: String, enum: Object.values(SOSTicketStatus), required: true },
        at: { type: Date, required: true, default: () => new Date() },
        by: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
        note: { type: String },
      },
    ],
    escalatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const SOSTicket = mongoose.model<ISOSTicket>('SOSTicket', SOSTicketSchema);
