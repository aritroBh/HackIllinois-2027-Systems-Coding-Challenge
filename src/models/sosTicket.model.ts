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
 * which is what makes anyone take the 3 a.m. spill. It is committed when the ticket is
 * created, not when it is resolved: reserving it against the creator's daily budget in
 * `bountyLedger` and inserting this document are the third of the system's three
 * transactional paths, so a ticket never exists with its bounty uncommitted and budget is
 * never spent on a ticket that failed to insert.
 *
 * The lifecycle above is the common path and not the whole grammar — `SOS_TRANSITIONS` below
 * is, including the acknowledge and on-scene steps and the reassignment edge back to OPEN.
 *
 * **This is the most privacy-sensitive collection here.** A row says where a named person is
 * and what is wrong with them, sometimes medically. Reads are redacted for anyone who is not
 * a proved lead or a party to the ticket, and "proved" carries the weight: in
 * `AUTH_MODE=legacy` a claimed id is one string, so a claimed-lead check on a read is not a
 * check. `src/common/types/account.ts` has the rule and the count of times it was got wrong.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * What kind of help is needed. Nothing on the server branches on it — it is carried into the
 * broadcasts and shown to responders so somebody can decide whether they are the right person
 * to walk over. `requiredSkill`, which dispatch actually filters the candidate pool by, is a
 * separate field precisely so that a category can be added without touching the matcher.
 */
export enum SOSTicketCategory {
  HARDWARE_MALFUNCTION = 'HARDWARE_MALFUNCTION',
  SPILL_CLEANUP = 'SPILL_CLEANUP',
  POWER_OUTAGE = 'POWER_OUTAGE',
  MEDICAL_FIRST_AID = 'MEDICAL_FIRST_AID',
  LOGISTICS_SUPPLIES = 'LOGISTICS_SUPPLIES',
}

/**
 * How badly it is needed. This selects the per-urgency bounty ceiling in the pack's
 * `bountyCap`, which is the one server decision that reads it; beyond that it rides along in
 * the broadcasts for the responder's benefit. It does not reorder the candidate pool and it
 * does not change which transitions are legal.
 */
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

/**
 * The whole grammar, as a table rather than a chain of `if`s in the service.
 *
 * A table is checkable and a chain is not: a missing edge here is a 409 the caller can read,
 * whereas a missing branch in a service is a status silently overwritten. `RESOLVED` and
 * `CANCELLED` map to empty arrays deliberately — a state with no outgoing edges is how a
 * terminal state is spelled, and it is what stops a resolved ticket being reopened by a late
 * request that was in flight when somebody closed it.
 *
 * Terminal states have no outgoing edges; every other move must appear here.
 */
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

/**
 * The only legality question, asked before any status write.
 *
 * The `?? []` is not defensive noise about a missing key: `from` arrives as whatever is
 * stored on a document, and a row written by an older build — or by hand — can carry a status
 * this table does not name. Answering `false` there refuses the move, which is the right way
 * for an unknown state to fail; an unguarded index would throw on `.includes` and turn an
 * unrecognised ticket into a 500.
 *
 * Note that this answers "is the move legal", not "may this caller make it". Whether the
 * transition is *raced* is decided separately, by a compare-and-swap in `SOSService` naming
 * the status that was read — so two responders resolving at once produce one resolution and
 * one 409 rather than two payouts.
 */
export function canTransition(from: SOSTicketStatus, to: SOSTicketStatus): boolean {
  return (SOS_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * One line of the ticket's own audit trail, appended by the same update that makes the move,
 * so the history cannot disagree with the status. `by` is nullable because some transitions
 * have no actor: the escalation sweep and an auto-resolve both write a row with nobody's name
 * on it, and recording that honestly is better than attributing it to whoever happened to
 * trigger the tick.
 */
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
