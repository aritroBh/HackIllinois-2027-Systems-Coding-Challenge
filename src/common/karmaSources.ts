/**
 * Every bucket karma can be minted against.
 *
 * This lives in `common/` with no imports of its own so that both halves of the contract can
 * depend on it without a cycle: `KarmaService` mints against these keys, and the content
 * schema requires a pack to price every one of them.
 *
 * The requirement exists because the cap lookup fails **open**. `capFor()` returns `null`
 * for a source the pack does not mention, and `null` routes the award to `spendUncapped` —
 * so a source that is simply missing from `karmaCaps` is not "uncapped by mistake", it is
 * "unlimited, silently". Three of the seven were missing: `POWERUP`, `CHECKOUT` and
 * `BOOTH`, which between them are the highest-yield paths in the game. The shipped
 * `example-campus` pack had no `karmaCaps` key at all, so a fork started with no economy
 * limits whatsoever.
 *
 * Adding a source here without pricing it in every pack now fails `content:validate` and
 * refuses to boot, which is the intended trade: a typo in an economy ceiling should be a
 * loud failure at start-up rather than a quiet one discovered from a leaderboard at 3 a.m.
 */
export const KARMA_SOURCES = [
  /** Paid at check-out for a shift actually worked. The main legitimate earner. */
  'CHECKOUT',
  /** Capturing or reinforcing a territory gym. */
  'GYM',
  /** Spinning a HackStop beacon. */
  'HACKSTOP',
  /** Consuming a power-up from the inventory. */
  'POWERUP',
  /** Completing a quest. */
  'QUEST',
  /** Resolving somebody else's SOS ticket, paid from their bounty. */
  'SOS',
  /** Scanning a sponsor booth, once per account per booth. */
  'BOOTH',
] as const;

export type KarmaSourceKey = (typeof KARMA_SOURCES)[number];
