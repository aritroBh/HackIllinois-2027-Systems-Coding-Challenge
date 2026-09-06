/**
 * KarmaLedger — one row per (account, source, day), holding the karma that source has
 * already paid that account on that day.
 *
 * The economy has to survive people who go looking for its edges, and every source has a
 * different edge. Gyms grew a per-volunteer cooldown, HackStops grew a per-beacon one,
 * check-out grew a time factor: three defences, three places to get wrong, and none of
 * them stops someone walking a loop of twelve beacons all night. A spent-from row states
 * the rule once instead. A source may pay an account at most `pack.event.karmaCaps[source]`
 * between one event-local midnight and the next, and the per-feature cooldowns go back to
 * being about pacing rather than about solvency.
 *
 * The unique compound index on `(accountId, source, day)` is what makes the cap a
 * guarantee rather than an intention. Two concurrent awards cannot both open today's row
 * and spend the budget twice: the second insert fails with duplicate-key error 11000 and
 * is retried against the row that won. The obvious alternative (read the day's total, add
 * to it, write it back) is a lost update under exactly the load that a leaderboard race
 * produces, and a lost update here mints karma.
 *
 * `amount` records karma actually granted, never karma requested. A request the cap held
 * back leaves no trace beyond the row sitting at its ceiling, which is the honest reading:
 * the ledger answers "what has this source paid", not "what was asked for".
 */
import mongoose, { Schema, Document, Types } from 'mongoose';
import { pack } from '../content/loader';

export interface IKarmaLedger extends Document {
  accountId: Types.ObjectId;
  /** Uppercase source key, matched against `pack.event.karmaCaps`. Absent there means uncapped. */
  source: string;
  day: string;
  amount: number;
  meta: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const KarmaLedgerSchema = new Schema<IKarmaLedger>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
    source: { type: String, required: true },
    /**
     * Event-local calendar day as `YYYY-MM-DD`, produced by `eventDay` below. Local rather
     * than UTC because the cap is a human rule about one night of a hackathon, and a UTC
     * boundary falls at 6 p.m. in Chicago, mid-shift, where a budget reset is a bug.
     */
    day: { type: String, required: true },
    amount: { type: Number, required: true, default: 0, min: 0 },
    /**
     * Context for the award that last moved this row: the gym, the beacon, the ticket.
     * Read by humans reconstructing a disputed balance. Nothing branches on it.
     */
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

/**
 * The cap. Never relax this to a plain index: the uniqueness is the serialisation point
 * that stops two first awards of the day from each opening a row with a full budget.
 */
KarmaLedgerSchema.index({ accountId: 1, source: 1, day: 1 }, { unique: true });

let dayFormatter: Intl.DateTimeFormat | null = null;

/**
 * The `day` key for a moment: the event's own calendar date, as `YYYY-MM-DD`.
 *
 * `en-CA` is chosen for its format rather than its locale. It is the one widely available
 * locale whose short date is already in ISO order, so the result needs no part-by-part
 * reassembly and cannot be broken by a runtime that orders the parts differently.
 */
export function eventDay(at: Date = new Date()): string {
  if (!dayFormatter) {
    dayFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: pack.event.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return dayFormatter.format(at);
}

export const KarmaLedger = mongoose.model<IKarmaLedger>('KarmaLedger', KarmaLedgerSchema);
