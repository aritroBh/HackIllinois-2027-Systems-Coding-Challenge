/**
 * Per-account daily bounty budget.
 *
 * An SOS ticket carries a karma bounty that its creator promises to the responder. Left
 * uncapped, a ticket creator mints karma: raise a ticket with a huge bounty, have a friend
 * resolve it, repeat. The per-urgency ceiling that `SOSService.createTicket` reads off the
 * pack — behind the request schema's own flat 500 — stops a single absurd ticket; this
 * ledger stops the same ceiling being paid a hundred times in an afternoon.
 *
 * The whole check is one conditional update. The budget predicate
 * `spent <= budget - bounty` lives in the query, so the database decides, atomically,
 * whether this reservation fits. A `null` result is the only failure mode and it means
 * "no room left" — never "row missing", because step 1 has already guaranteed the row.
 * A read-then-write would let two concurrent tickets both observe the same `spent` and
 * both pass, which is the exact bug this exists to prevent.
 *
 * The caller supplies the session and owns the transaction. That is deliberate: a
 * reservation is only meaningful if it commits together with the thing it pays for. If the
 * ticket insert fails after the `$inc` has run, the caller's transaction aborts and the
 * budget is released with it. A reservation taken in its own transaction would leak budget
 * on every downstream failure, and nothing would ever give it back.
 *
 * Nothing here broadcasts. The ledger movement is not an event anybody watches, and a
 * broadcast issued inside a transaction body would be published even when the transaction
 * later aborts.
 */
import { ClientSession, Types } from 'mongoose';
import { BountyLedger } from '../models/bountyLedger.model';
import { ApiError } from '../common/errors/apiError';
import { pack } from '../content/loader';

export interface IReserveBountyInput {
  /** Account the bounty is charged to: the hacker who raised the ticket. */
  accountId: string;
  /** Calendar day key in the event timezone, `YYYY-MM-DD`. See `eventDayKey`. */
  day: string;
  /** Karma this ticket promises. */
  bounty: number;
  /** Ceiling for the day, from `pack.event.hackerBountyBudgetPerDay`. */
  budget: number;
}

export interface IBountyReservation {
  accountId: string;
  day: string;
  /** Karma now committed by this reservation. */
  bounty: number;
  budget: number;
  /** Total committed for the day including this reservation. */
  spent: number;
  /** Budget still free after this reservation. */
  remaining: number;
}

/**
 * Success or a named refusal, never an exception, because "you have spent your budget" is
 * an ordinary answer the caller renders as a 409 rather than an error in the ledger.
 * Genuine faults (a malformed account id, a database failure) still throw.
 */
export type BountyReserveResult =
  | { ok: true; reservation: IBountyReservation }
  | {
      ok: false;
      reason: 'BUDGET_EXHAUSTED';
      /** What was asked for. */
      requested: number;
      budget: number;
      /** Already committed today, before this request. */
      spent: number;
      remaining: number;
    };

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar day key for a moment, in the event's timezone.
 *
 * `en-CA` is used because its short date format is already `YYYY-MM-DD`; the point is the
 * timezone argument, which keeps the budget aligned to the event's own night rather than to
 * UTC midnight, which falls in the middle of the busiest hours of a hackathon.
 */
export function eventDayKey(at: Date = new Date(), timeZone: string = pack.event.timezone): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Karma bounty service handling high-urgency shift bounties, concurrency limits, and reward allocations.
 */
export class BountyService {
  /**
   * Commits `bounty` karma against `accountId`'s allowance for `day`, inside the caller's
   * transaction.
   *
   * @param input Account, day, amount and ceiling.
   * @param session The caller's transaction session. Both writes below join it, so an
   *                abort anywhere in the caller's body releases the reservation.
   */
  public static async reserve(input: IReserveBountyInput, session: ClientSession): Promise<BountyReserveResult> {
    const { accountId, day, bounty, budget } = input;

    if (!Types.ObjectId.isValid(accountId)) {
      throw ApiError.badRequest('A valid accountId is required to reserve a bounty.');
    }
    if (!DAY_KEY_PATTERN.test(day)) {
      throw ApiError.badRequest('Bounty day must be a YYYY-MM-DD calendar key.');
    }
    if (!Number.isInteger(bounty) || bounty <= 0) {
      throw ApiError.badRequest('Bounty must be a positive whole number of karma.');
    }
    if (!Number.isInteger(budget) || budget < 0) {
      throw ApiError.badRequest('Bounty budget must be a whole number of karma.');
    }

    const owner = new Types.ObjectId(accountId);

    // 1. Make sure the row exists without disturbing it. `$setOnInsert` is what keeps this
    //    from being a reset: an existing row is matched and left exactly as it is, so a
    //    first ticket of the day and a fiftieth take the same path.
    await BountyLedger.updateOne(
      { accountId: owner, day },
      { $setOnInsert: { accountId: owner, day, spent: 0 } },
      { upsert: true, session }
    );

    // 2. The budget check and the charge, as one operation. `budget - bounty` is computed
    //    here rather than with `$expr` so the predicate stays a plain range query the
    //    unique (accountId, day) index can serve.
    const charged = await BountyLedger.findOneAndUpdate(
      { accountId: owner, day, spent: { $lte: budget - bounty } },
      { $inc: { spent: bounty } },
      { new: true, session }
    );

    if (!charged) {
      // The predicate matched nothing, which for a row that certainly exists means the
      // remaining allowance is smaller than the request. Re-read only to report honest
      // numbers back to the caller; the decision was already made above.
      const current = await BountyLedger.findOne({ accountId: owner, day }, null, { session });
      const spent = current?.spent ?? 0;
      return {
        ok: false,
        reason: 'BUDGET_EXHAUSTED',
        requested: bounty,
        budget,
        spent,
        remaining: Math.max(0, budget - spent),
      };
    }

    return {
      ok: true,
      reservation: {
        accountId,
        day,
        bounty,
        budget,
        spent: charged.spent,
        remaining: Math.max(0, budget - charged.spent),
      },
    };
  }
}
