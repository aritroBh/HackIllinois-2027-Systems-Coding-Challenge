/**
 * One player's run at one gym's coding challenge.
 *
 * The row is the state machine and the receipt: it records which challenge was served, from
 * where, until when, and — once judged — whether the win has been spent. Three invariants live
 * on indexes rather than in service code, because a count-then-write cannot survive two
 * requests arriving in the same millisecond and this repository has been bitten by exactly that
 * shape before (see the `BoothScan` unique index and the note in `tests/setup.ts` about the
 * twenty concurrent scans).
 *
 * `openKey` is the trick worth explaining. A partial unique index on `{ accountId, openKey }`
 * enforces "one open attempt per account" without a transaction: the field holds a constant
 * string while the attempt is OPEN and is set to `null` the moment it leaves that state, and a
 * partial filter keeps nulls out of the index entirely. Twenty concurrent starts therefore
 * produce one insert and nineteen duplicate-key errors, decided by the database.
 *
 * Statuses, and why each exists:
 *   OPEN     served, clock running, not yet answered
 *   WON      answered correctly — a single-use token that may still be spent
 *   LOST     answered incorrectly; the attempt is over
 *   EXPIRED  the deadline passed before an answer arrived
 *   SPENT    a win that has been exchanged for a capture
 *
 * WON and SPENT are separate states on purpose. The spend is a second conditional update
 * (`{ status: 'WON' } -> 'SPENT'`), which is what makes a win impossible to redeem twice no
 * matter how many requests carry the same attempt id.
 */
import mongoose, { Document, Schema, Types } from 'mongoose';

export const CHALLENGE_ATTEMPT_STATUSES = ['OPEN', 'WON', 'LOST', 'EXPIRED', 'SPENT'] as const;
/** Lifecycle of a gauntlet attempt: open while the deadline runs, then won, lost, expired, or spent. */
export type ChallengeAttemptStatus = (typeof CHALLENGE_ATTEMPT_STATUSES)[number];

/** The constant `openKey` carries while an attempt is open. Its value is irrelevant; its presence is the lock. */
export const OPEN_ATTEMPT_KEY = 'open';

/** One open gauntlet attempt per account (partial unique index): the geofenced, deadlined shot at a capture. */
export interface IChallengeAttempt extends Document {
  accountId: Types.ObjectId;
  gymId: Types.ObjectId;
  challengeId: string;
  status: ChallengeAttemptStatus;
  /** `OPEN_ATTEMPT_KEY` while open, null otherwise. The partial unique index reads this. */
  openKey: string | null;
  startedAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
  spentAt: Date | null;
  /** Per-case verdicts, so a losing player can see which case they missed without seeing the answer. */
  perCase: boolean[];
  createdAt: Date;
  updatedAt: Date;
}

const ChallengeAttemptSchema = new Schema<IChallengeAttempt>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    gymId: { type: Schema.Types.ObjectId, ref: 'Gym', required: true, index: true },
    challengeId: { type: String, required: true },
    status: { type: String, enum: CHALLENGE_ATTEMPT_STATUSES, default: 'OPEN', required: true },
    openKey: { type: String, default: OPEN_ATTEMPT_KEY },
    startedAt: { type: Date, default: Date.now, required: true },
    expiresAt: { type: Date, required: true },
    answeredAt: { type: Date, default: null },
    spentAt: { type: Date, default: null },
    perCase: { type: [Boolean], default: [] },
  },
  { timestamps: true }
);

/**
 * One open attempt per account, enforced by the database.
 *
 * The partial filter is what makes this work: without it, every finished attempt would carry a
 * null `openKey` and the second null would collide with the first. With it, only OPEN rows are
 * in the index at all.
 */
ChallengeAttemptSchema.index(
  { accountId: 1, openKey: 1 },
  { unique: true, partialFilterExpression: { openKey: { $type: 'string' } } }
);

/** For the "did this player already beat this gym's challenge" lookups and the cooldown after a loss. */
ChallengeAttemptSchema.index({ accountId: 1, gymId: 1, createdAt: -1 });

export const ChallengeAttempt = mongoose.model<IChallengeAttempt>('ChallengeAttempt', ChallengeAttemptSchema);
