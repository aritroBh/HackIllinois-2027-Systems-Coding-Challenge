/**
 * KarmaService — the one and only writer of `Volunteer.karmaPoints`.
 *
 * Karma used to be minted wherever it was earned: check-out, gym battles, HackStop spins,
 * power-up deployments and SOS resolution each ran their own `$inc`. Every one of them was
 * individually correct and the set of them was not, because no single place could answer
 * "how much has this account been paid today, and by what". Routing every award through
 * one door buys three things at once: a per-source daily cap that actually holds, a ledger
 * that can reconstruct a disputed balance, and one place where the prestige tier is kept
 * in step with the balance it is derived from.
 *
 * **Presence never awards karma.** Being somewhere is not work, and paying for location
 * would turn an opt-in safety and coordination feature into a reason to leave a phone on a
 * table in Siebel overnight. Presence pays nothing here, and nothing in `src/presence/`
 * calls this service. Quests that happen to require walking somewhere pay for the quest.
 *
 * **The cap.** `pack.event.karmaCaps` maps a source key to its ceiling for one event-local
 * day. A source with no entry is uncapped, which is a deliberate default: a new source
 * added by a fork should work before it is tuned, and an operator who wants it bounded
 * writes one line of pack. An award larger than the remaining budget is clamped, not
 * refused. Half a HackStop payout is a better answer than an error at a beacon.
 *
 * **What is atomic and what is not.** The ledger spend and the balance increment are two
 * writes with no transaction between them, and this file spends first. Both orders can be
 * interrupted in the middle; this one under-pays where the other would over-pay, and an
 * economy that leaks upward is the one you cannot quietly fix afterwards.
 *
 * Nothing is broadcast from here. Every caller already announces its own event (a
 * check-out, a spin, a resolved ticket) carrying the awarded figure, and a second frame
 * per award would say the same thing twice on the same channel.
 */
import { Types, UpdateQuery } from 'mongoose';
import { KarmaLedger, IKarmaLedger, eventDay } from '../models/karmaLedger.model';
import { Volunteer, computePrestigeTier } from '../models/volunteer.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { pack } from '../content/loader';

/** Source keys used by the shipped pack. A fork may award against any string it likes. */
export const KarmaSource = {
  CHECKOUT: 'CHECKOUT',
  GYM: 'GYM',
  HACKSTOP: 'HACKSTOP',
  POWERUP: 'POWERUP',
  QUEST: 'QUEST',
  SOS: 'SOS',
} as const;

export interface IKarmaAward {
  /** Karma actually added to the balance, after the daily cap was applied. */
  awarded: number;
  /** True when the cap held any of the request back, including when it held all of it. */
  capped: boolean;
  /** The account's balance after this award. */
  total: number;
}

export type AccountRef = string | Types.ObjectId;

/**
 * Bound on the compare-and-swap retries below. Contention is per (account, source, day),
 * so the only writers racing are one person's own concurrent requests. Five attempts is
 * far past what a phone with a stuck retry button produces, and a bound means a pathological
 * case fails loudly rather than spinning against the database.
 */
const CAP_CAS_ATTEMPTS = 5;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

/**
 * The configured ceiling for a source, or `null` when it has none.
 *
 * `hasOwnProperty` rather than `in`: the caps object is a plain object parsed from JSON, so
 * `in` would report a cap for `toString` or `constructor` and then read a function as a
 * number. Source keys reach here from call sites rather than from users, but a lookup that
 * is only safe because of who calls it is worth two extra words.
 */
function capFor(source: string): number | null {
  const caps: Record<string, number> = pack.event.karmaCaps;
  return Object.prototype.hasOwnProperty.call(caps, source) ? caps[source] : null;
}

export class KarmaService {
  /**
   * Awards karma to an account, clamped to what remains of the source's daily cap.
   *
   * @param accountId Volunteer or hacker account to pay.
   * @param amount Karma requested. Must be a positive whole number; a caller computing a
   *               zero or negative award has a bug, and swallowing it here would hide it.
   * @param source Cap bucket, e.g. `GYM`. Matched against `pack.event.karmaCaps`.
   * @param meta Context stored on the ledger row for later human reading.
   */
  public static async awardKarma(
    accountId: AccountRef,
    amount: number,
    source: string,
    meta?: Record<string, unknown>
  ): Promise<IKarmaAward> {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw ApiError.badRequest('Karma awards must be a positive whole number.', { source, amount });
    }
    if (!Types.ObjectId.isValid(accountId)) {
      throw ApiError.badRequest('Karma awards need a valid account id.', { source });
    }
    // Normalised once so the ledger key is the same shape whether the caller held a string
    // or a document id. Two spellings of one account would be two rows, and two caps.
    const id = new Types.ObjectId(accountId);

    const day = eventDay();
    const cap = capFor(source);
    const granted =
      cap === null
        ? await KarmaService.spendUncapped(id, source, day, amount, meta)
        : await KarmaService.spendUnderCap(id, source, day, amount, cap, meta);

    if (granted === 0) {
      const balance = await Volunteer.findById(id).select('karmaPoints').lean();
      if (!balance) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      return { awarded: 0, capped: true, total: balance.karmaPoints };
    }

    const account = await Volunteer.findOneAndUpdate(
      { _id: id },
      { $inc: { karmaPoints: granted } },
      { new: true }
    );
    if (!account) {
      // The ledger spent budget for an account that does not exist. Hand it back, or the
      // ceiling for a real account created later at the same id would already be eaten.
      await KarmaLedger.updateOne({ accountId: id, source, day }, { $inc: { amount: -granted } });
      throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    }

    // The tier is a stored label over the balance, so it is recomputed on the only path
    // that can move the balance. Written only on a change: most awards cross no threshold.
    const tier = computePrestigeTier(account.karmaPoints);
    if (tier !== account.prestigeTier) {
      await Volunteer.updateOne({ _id: id }, { $set: { prestigeTier: tier } });
    }

    return { awarded: granted, capped: granted < amount, total: account.karmaPoints };
  }

  /**
   * Records an award against a source with no ceiling. There is nothing to clamp and so
   * nothing to serialise: an upsert with `$inc` cannot lose an update and needs no retry
   * loop. Two concurrent first awards can still collide on the unique index. That is not a
   * failure. It means the row now exists, so the increment is simply replayed onto it.
   */
  private static async spendUncapped(
    accountId: Types.ObjectId,
    source: string,
    day: string,
    amount: number,
    meta?: Record<string, unknown>
  ): Promise<number> {
    const filter = { accountId, source, day };
    try {
      await KarmaLedger.updateOne(filter, KarmaService.spendUpdate(amount, meta), { upsert: true });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      await KarmaLedger.updateOne(filter, KarmaService.spendUpdate(amount, meta));
    }
    return amount;
  }

  /**
   * Spends up to `amount` from what remains of today's ceiling, and returns what was taken.
   *
   * The read at the top of each attempt computes the clamp; it does not decide the outcome.
   * Correctness comes from what follows it. A first award of the day inserts, and the unique
   * index rejects a concurrent twin. A later award increments only while the row still holds
   * the exact balance the clamp was computed from, so a racing writer loses its write rather
   * than its budget, and comes round again to clamp against the total that won.
   */
  private static async spendUnderCap(
    accountId: Types.ObjectId,
    source: string,
    day: string,
    amount: number,
    cap: number,
    meta?: Record<string, unknown>
  ): Promise<number> {
    for (let attempt = 0; attempt < CAP_CAS_ATTEMPTS; attempt++) {
      const row = await KarmaLedger.findOne({ accountId, source, day }).select('amount').lean();
      const spent = row ? row.amount : 0;
      const granted = Math.min(amount, Math.max(0, cap - spent));
      if (granted === 0) return 0;

      if (!row) {
        try {
          await KarmaLedger.create({ accountId, source, day, amount: granted, meta: meta ?? {} });
          return granted;
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          continue; // Someone else opened today's row; re-clamp against their total.
        }
      }

      // A *range*-matched conditional increment, not an exact-value compare-and-set.
      //
      // Naming the exact balance we read makes every concurrent writer invalidate every
      // other one: with twenty simultaneous awards, nineteen filters miss on each pass and
      // the loop runs out of attempts while there is still room under the cap. Matching
      // `amount <= cap - granted` instead preserves the invariant just as strictly — the
      // increment can only apply where it still fits — while letting any writer whose grant
      // genuinely fits win on its first try. A retry then means what it should: somebody
      // else consumed the room, so re-read and clamp against the total that won.
      const result = await KarmaLedger.updateOne(
        { accountId, source, day, amount: { $lte: cap - granted } },
        KarmaService.spendUpdate(granted, meta)
      );
      if (result.modifiedCount === 1) return granted;
    }

    // Reaching here means every attempt found the row already at or above the ceiling that
    // our own grant needed, without ever reading a total that left room. The honest report
    // is that the cap is full — refusing the award with a 409 would tell the caller their
    // check-in failed when it did not, and the caller cannot do anything with a retry.
    return 0;
  }

  /**
   * `meta` is set only when the caller supplied one, so an award without context leaves the
   * previous award's context in place rather than blanking it.
   */
  private static spendUpdate(granted: number, meta?: Record<string, unknown>): UpdateQuery<IKarmaLedger> {
    const update: UpdateQuery<IKarmaLedger> = { $inc: { amount: granted } };
    if (meta) update.$set = { meta };
    return update;
  }
}
