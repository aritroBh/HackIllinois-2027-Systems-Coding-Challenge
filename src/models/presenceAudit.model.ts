/**
 * Exact-position reads are audited (plan §A4): one document per dispatch, per lead
 * `GET /presence` call, per lead player-card view and per roster view — never per row.
 * Positions themselves are never stored; the log holds who read whom and why, and is
 * deleted after 30 days.
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
