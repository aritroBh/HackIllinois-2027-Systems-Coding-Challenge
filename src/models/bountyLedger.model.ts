/**
 * BountyLedger — one row per account per event day, holding the karma that account has
 * already committed to SOS bounties that day.
 *
 * The row exists so the daily budget can be enforced by the database rather than by a
 * read-then-write in application code. Two SOS tickets raised at the same moment both read
 * the same `spent` if the check is a query; they cannot both pass a conditional `$inc`
 * against a unique row, which is why the ceiling lives in the update predicate and the
 * uniqueness lives in the index below.
 *
 * `day` is a calendar key (`YYYY-MM-DD`) in the event's own timezone, not a timestamp. A
 * hackathon runs through the small hours, and a UTC day boundary would reset an attendee's
 * budget in the middle of the night when incidents peak.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/** Collection name, for matching a duplicate-key error against this ledger by name. */
export const BOUNTY_LEDGER_COLLECTION = 'bountyledgers';

/** One account's SOS bounty spending for one day: the row the oversell guard increments. */
export interface IBountyLedgerEntry extends Document {
  accountId: Types.ObjectId;
  day: string;
  spent: number;
  createdAt: Date;
  updatedAt: Date;
}

const BountyLedgerSchema = new Schema<IBountyLedgerEntry>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    spent: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

/**
 * The uniqueness that makes the conditional `$inc` an atomic budget check. Without it a
 * racing upsert can create a second row for the same account and day, and each request
 * then spends against its own private copy of the budget.
 */
BountyLedgerSchema.index({ accountId: 1, day: 1 }, { unique: true });

export const BountyLedger = mongoose.model<IBountyLedgerEntry>('BountyLedger', BountyLedgerSchema);
