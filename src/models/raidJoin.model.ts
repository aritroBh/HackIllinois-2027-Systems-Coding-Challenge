/**
 * RaidJoin — one row per (raid, account): who took part in a raid window.
 *
 * Nobody presses a join button. A raid is joined by doing the thing the raid asks for while
 * it is open, so the row is written by a domain-bus listener rather than by a request, and
 * `GET /game/raids` reads it back as the roster. That is the difference between a raid and a
 * scoreboard filter: the roster is a fact recorded at the time, so it survives the window
 * closing, the account changing faction, and the karma being spent.
 *
 * A raid's window is absolute and its id is unique in the pack, so the id alone identifies
 * the window — there is no window key here, unlike `QuestProgress`. The unique index on
 * (raidId, accountId) is what makes the listener safe to run on a re-delivered event and on
 * twenty spins in one hour: the roster records that someone took part, not how often.
 *
 * `firstEvent` is the event that enrolled them, kept because a raid may count more than one
 * and knowing which one landed is the difference between a raid nobody joined and a raid
 * listening for an event nothing emits.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IRaidJoin extends Document {
  /** A raid id from the pack's `raids.json`. */
  raidId: string;
  accountId: Types.ObjectId;
  /** The domain event name that enrolled this account, e.g. `hackstop.spun`. */
  firstEvent: string;
  joinedAt: Date;
}

const RaidJoinSchema = new Schema<IRaidJoin>(
  {
    raidId: { type: String, required: true, trim: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
    firstEvent: { type: String, required: true, trim: true },
    joinedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false }
);

/** One row per account per raid. Joining twice is a no-op, not a second name on the roster. */
RaidJoinSchema.index({ raidId: 1, accountId: 1 }, { unique: true });

export const RaidJoin = mongoose.model<IRaidJoin>('RaidJoin', RaidJoinSchema);
