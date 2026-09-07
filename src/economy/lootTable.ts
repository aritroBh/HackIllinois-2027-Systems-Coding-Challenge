/**
 * The HackStop spin table, read from the content pack.
 *
 * This file exists because the pack and the code disagreed about who was in charge, and the
 * pack lost silently. `content/<pack>/loot.json` declares `karmaMin`, `karmaMax` and a weighted
 * item list; it was parsed by `lootSchema`, cross-validated at boot, served to every browser
 * under `/dashboard/content` — and read by nothing. The table `HackStopService` actually rolled
 * against was a literal array inside that service, and it happened to hold the same five items
 * with the same five weights, so the two agreed by coincidence and nobody noticed they were two.
 *
 * A fork editing `loot.json` therefore changed nothing at all. `docs/CONTENT-PACKS.md` and
 * `docs/FORK_GUIDE.md` both told them it would. That is the failure this module removes: after
 * it, there is one table, it is the pack's, and a fork's edit takes effect.
 *
 * ## Why the roll is against the weight total and not against 100
 *
 * The old loop rolled `Math.random() * 100` and walked a running sum. That is correct only while
 * the weights happen to add to exactly 100, which the schema does not require and `loot.json`'s
 * own `_about` explicitly denies — it calls the weights "relative". The failure is quiet in both
 * directions. Weights summing under 100 leave a dead band at the top of the roll where the loop
 * finishes without matching anything and the caller's pre-seeded default is awarded, so the
 * first item's real share is its weight *plus* the entire shortfall. Weights summing over 100
 * make the tail unreachable: with 5 for the rarest item, the mythic drop can simply never
 * happen. Both of those are a rarity bug that no test would catch and no player could report,
 * because a drop table is only observable in aggregate.
 *
 * Normalising against the actual total makes the weights mean what the pack says they mean, and
 * makes any set of positive numbers a valid table.
 *
 * ## Why an unknown item type refuses to boot
 *
 * `POWER_UP_CATALOG` prices every item — `karmaBonus` is money, and it is deliberately in code
 * rather than in a public pack file. So the pack chooses the odds and the code chooses the
 * prices, and the join between them is the `type` string. A typo there used to be a crash at
 * spin time: `POWER_UP_CATALOG[awarded]` would be `undefined` and the read of `.karmaBonus`
 * would throw inside a request, for one unlucky player, at whatever hour they happened to walk
 * past the beacon.
 *
 * `crossValidate` now rejects it at boot instead, which is the same trade this repository
 * already makes for `karmaCaps`: a typo in the economy should stop the server starting rather
 * than surface at three in the morning. This module keeps its own assertion anyway, because it
 * is the thing that would actually break, and a guard next to the code it protects survives a
 * refactor of the validator.
 */
import { pack } from '../content/loader';
import { PowerUpType, POWER_UP_CATALOG } from '../models/powerup.model';

/** One row of the resolved table: a real catalogue item and its share of the roll. */
export interface LootEntry {
  type: PowerUpType;
  weight: number;
}

/**
 * Whether a string from the pack names a real power-up.
 *
 * `POWER_UP_CATALOG` is a `Record<PowerUpType, …>` with an entry per enum member, so its own
 * keys are the authority on what exists — checking against it rather than against
 * `Object.values(PowerUpType)` means a member that was added to the enum but never priced
 * cannot pass here either.
 */
export function isKnownPowerUp(type: string): type is PowerUpType {
  return Object.prototype.hasOwnProperty.call(POWER_UP_CATALOG, type);
}

/**
 * The pack's table, resolved once at import.
 *
 * Resolved eagerly rather than per spin: the pack cannot change while the process runs, and a
 * bad entry should stop the boot rather than the first spin. `loader.ts` guarantees the pack is
 * whole by the time anything imports it, so reading `pack.loot` at module scope is safe in the
 * same way every other `pack.*` read in `src/` is.
 */
export const LOOT_TABLE: readonly LootEntry[] = pack.loot.items.map((item) => {
  if (!isKnownPowerUp(item.type)) {
    throw new Error(
      `content pack "${pack.event.id}": loot.json names power-up "${item.type}", which is not in POWER_UP_CATALOG. ` +
        `Known types: ${Object.keys(POWER_UP_CATALOG).join(', ')}.`
    );
  }
  return { type: item.type, weight: item.weight };
});

/**
 * The sum the roll is taken against.
 *
 * `lootSchema` requires at least one item and every weight to be positive, so this is always
 * greater than zero and `rollLoot` needs no divide-by-zero branch. That guarantee lives in the
 * schema rather than here, which is why this file does not re-check it — but it is the reason
 * the code below is allowed to be this short, so it is worth saying where it comes from.
 */
export const LOOT_WEIGHT_TOTAL: number = LOOT_TABLE.reduce((sum, entry) => sum + entry.weight, 0);

/**
 * Draw one item.
 *
 * `random` is injectable so a test can pin the outcome; nothing in production passes it. It must
 * return a value in `[0, 1)` like `Math.random`, and the comparison below is `<` rather than
 * `<=` for that reason: at exactly 1 the walk would fall off the end of the table.
 *
 * The final `?? last` is not reachable through the loop above — the running sum reaches the
 * total, and any value below the total matches some row — but floating-point summation of the
 * weights is not associative, so the accumulated sum can land a fraction of an ULP under
 * `LOOT_WEIGHT_TOTAL`. Returning the last row there is right rather than merely safe: that band
 * belongs to the last row.
 */
export function rollLoot(random: () => number = Math.random): PowerUpType {
  const roll = random() * LOOT_WEIGHT_TOTAL;
  let cumulative = 0;
  for (const entry of LOOT_TABLE) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.type;
  }
  return LOOT_TABLE[LOOT_TABLE.length - 1].type;
}

/**
 * The karma a spin pays before the item's bonus, the raid multiplier and the daily cap.
 *
 * Uniform over the inclusive range `[karmaMin, karmaMax]` the pack declares. Inclusive at both
 * ends is what `loot.json` documents and what the previous literal did — `Math.random() * 25 + 25`
 * floored covers 25 to 49 for the shipped pack's `karmaMin: 25, karmaMax: 49` — so the `+ 1`
 * below preserves the shipped behaviour exactly rather than quietly narrowing the range by one.
 *
 * `crossValidate` refuses a pack with `karmaMin > karmaMax`, so the span is never negative.
 */
export function rollKarma(random: () => number = Math.random): number {
  const { karmaMin, karmaMax } = pack.loot;
  return karmaMin + Math.floor(random() * (karmaMax - karmaMin + 1));
}
