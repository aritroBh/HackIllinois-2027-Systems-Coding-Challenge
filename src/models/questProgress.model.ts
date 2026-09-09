/**
 * QuestProgress — one row per (account, quest, window).
 *
 * The window key is what makes a repeating quest repeatable. "Spin two beacons this hour"
 * is not one quest with a timer, it is a new row every hour, so yesterday's finished row
 * stays finished and today's starts at zero without anything having to reset it. An event
 * quest lives in the single row keyed `event`.
 *
 * The compound unique index below is the idempotency guard, and it is the whole reason this
 * collection is shaped this way. Progress is written as an upsert against it, so the same
 * domain event delivered twice, or two events arriving in the same millisecond, cannot open
 * two rows and count twice. Completion is then a conditional update on `completedAt: null`,
 * which is what makes the reward exactly-once rather than merely usually-once: the loser of
 * that race matches nothing and pays nothing.
 *
 * `count` and `distinct` are two views of progress, not two counters. A COUNT quest
 * increments `count`; a DISTINCT quest adds to `distinct` and a STREAK quest adds the window
 * it advanced in, and for both of those `count` is the derived progress the service writes
 * back so a reader does not have to know the rule. `distinct` grows by at most one entry per
 * event or per window over one hackathon, which is bounded in the hundreds.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/** One account's progress on one quest: the count the domain bus advances. */
export interface IQuestProgress extends Document {
  accountId: Types.ObjectId;
  /** A quest id from the pack's `quests.json`. */
  questId: string;
  /** `YYYY-MM-DDTHH`, `YYYY-MM-DD` or the literal `event`, in the event's own timezone. */
  windowKey: string;
  count: number;
  /** Collected values for a DISTINCT quest, or the advanced windows of a STREAK. */
  distinct: string[];
  /** Set once, by the conditional update that wins the completion race. Null until then. */
  completedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const QuestProgressSchema = new Schema<IQuestProgress>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    questId: { type: String, required: true, trim: true },
    windowKey: { type: String, required: true, trim: true },
    count: { type: Number, required: true, default: 0, min: 0 },
    distinct: { type: [String], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * The idempotency guard. Never relax this to a plain index: it is the serialisation point
 * that stops two concurrent advances of the same quest from each opening a row, which would
 * split one player's progress in half and pay the reward twice.
 */
QuestProgressSchema.index({ accountId: 1, questId: 1, windowKey: 1 }, { unique: true });

export const QuestProgress = mongoose.model<IQuestProgress>('QuestProgress', QuestProgressSchema);
