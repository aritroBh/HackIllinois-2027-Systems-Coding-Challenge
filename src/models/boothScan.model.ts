/**
 * BoothScan — one row per (account, booth), and the proof that the pair has been paid.
 *
 * The rule the booth mechanic rests on is "once per account per booth, ever". That is not a
 * cooldown and it is not a daily cap, so neither the HackStop map nor the karma ledger can
 * express it: both forget. This collection is the memory, and the compound unique index
 * below is the enforcement.
 *
 * Uniqueness is the mechanism rather than a check, and the difference matters at a sponsor
 * table where twenty phones scan the same poster in the same second. `BoothService` inserts
 * this row *before* it pays anything, so the winner of the insert is the one and only caller
 * that goes on to award karma; everyone else gets a duplicate-key error and a 409. Reading
 * first and inserting after would be a read-then-write race, and what it would duplicate is
 * karma.
 *
 * There is no TTL. A row expiring would re-open a booth the account has already been paid
 * for, and the collection is bounded by (accounts × booths) over one weekend anyway.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IBoothScan extends Document {
  accountId: Types.ObjectId;
  /** A booth id from the pack's `booths.json`, validated by the service before insert. */
  boothId: string;
  /** Karma actually paid, after the daily cap in `KarmaService` had its say. */
  karmaAwarded: number;
  scannedAt: Date;
}

const BoothScanSchema = new Schema<IBoothScan>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    boothId: { type: String, required: true, trim: true },
    karmaAwarded: { type: Number, required: true, default: 0, min: 0 },
    scannedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);

/**
 * The once-ever guarantee. Never relax this to a plain index: it is the serialisation point
 * that stops a double-scan from being paid twice.
 */
BoothScanSchema.index({ accountId: 1, boothId: 1 }, { unique: true });

export const BoothScan = mongoose.model<IBoothScan>('BoothScan', BoothScanSchema);
