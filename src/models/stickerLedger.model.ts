/**
 * Sticker ledger — one row per (account, sticker), and the reason it was earned.
 *
 * `Volunteer.badges` is the denormalised copy the offline card and the leaderboard read.
 * This collection is the record behind it: it says *when* a sticker was earned and *what*
 * earned it, which is what makes an award auditable and a duplicate award detectable.
 *
 * The compound unique index below is the whole mechanism. Awarding is an upsert against it,
 * so "give this hacker the Alma Mater pin" is safe to run twice, from two rules, in two
 * concurrent requests: the second attempt is a no-op rather than a second row, and the
 * service reports it as not-new instead of announcing the same sticker again.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/** One sticker award: which memorabilia, to whom, and for what — awarded once. */
export interface IStickerLedger extends Document {
  accountId: Types.ObjectId;
  /** An item id from the pack's `memorabilia.json`, validated by the service before insert. */
  stickerId: string;
  /** What earned it, as `SOURCE:detail` (`HACKSTOP:alma-reliquary`, `QUEST:first-shift`). */
  source: string;
  awardedAt: Date;
}

const StickerLedgerSchema = new Schema<IStickerLedger>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    stickerId: { type: String, required: true, trim: true },
    source: { type: String, required: true, trim: true, default: 'UNKNOWN' },
    awardedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);

/** One row per sticker per account. Awarding the same sticker twice is a no-op, not a duplicate. */
StickerLedgerSchema.index({ accountId: 1, stickerId: 1 }, { unique: true });

export const StickerLedger = mongoose.model<IStickerLedger>('StickerLedger', StickerLedgerSchema);
