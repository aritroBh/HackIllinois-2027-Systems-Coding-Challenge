/**
 * Exact-position reads are audited (plan §A4): one document per read, never one per row.
 *
 * There are exactly **three** writers, and they are the exactly three code paths that can see
 * an unfuzzed position:
 *
 *   `dispatch`       — `SOSService.dispatchNearestVolunteer` ranking candidates by true range
 *   `presence-list`  — a lead's `GET /presence`
 *   `roster`         — a lead's `GET /shifts/:id/roster`
 *
 * That pairing is the whole privacy claim: "positions are never stored, and every exact read
 * is recorded" is only checkable because the set of readers and the set of writers here are
 * the same set. If you add a fourth reader, it writes a row or the claim stops being true.
 *
 * This comment used to name a fourth, "per lead player-card view", and `PresenceAuditReason`
 * still carries the matching `'lead-view'` member. No such route exists and nothing writes
 * that reason — it was designed and not built. The union member is left in place deliberately
 * rather than removed, so that a future player card writes an audited reason that already has
 * a name; it is listed here as unused so nobody reads it as evidence that the path exists.
 *
 * Positions themselves are never stored. The log holds who read whom and why, and TTLs out
 * after 30 days.
 */
import mongoose, { Schema, Document } from 'mongoose';

export type PresenceAuditReason = 'dispatch' | 'presence-list' | 'lead-view' | 'roster';

export interface IPresenceAudit extends Document {
  readerId: string;
  reason: PresenceAuditReason;
  subjectId?: string;
  ticketId?: string;
  shiftId?: string;
  candidatesScanned?: number;
  winnerId?: string;
  subjectCount?: number;
  at: Date;
}

const PresenceAuditSchema = new Schema<IPresenceAudit>(
  {
    readerId: { type: String, required: true, index: true },
    reason: { type: String, required: true, enum: ['dispatch', 'presence-list', 'lead-view', 'roster'] },
    subjectId: { type: String },
    ticketId: { type: String },
    shiftId: { type: String },
    candidatesScanned: { type: Number },
    winnerId: { type: String },
    subjectCount: { type: Number },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);
PresenceAuditSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const PresenceAudit = mongoose.model<IPresenceAudit>('PresenceAudit', PresenceAuditSchema);
