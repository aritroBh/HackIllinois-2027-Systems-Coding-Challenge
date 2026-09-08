/**
 * Two different playable sides, taken from the pack rather than named.
 *
 * The suite named the shipped pack's two teams through the Faction enum seventeen times
 * (those members no longer exist, which is why they are not backticked here), and in
 * every one of them the identity of the team was irrelevant: what each test needed was
 * *the side that holds this gym* and *a different side*, so that reinforcing and contesting
 * take different branches. Naming the shipped pack's teams to express "two of them" tied the
 * suite to `hackillinois-2027` — a fork that renames its factions would have had a red suite
 * describing teams it does not have, for a codebase that no longer mentions them anywhere in
 * `src/`.
 *
 * `HOLDER` and `RIVAL` say what the tests mean. They come from `pack.factions` in declared
 * order with `NEUTRAL` removed, so they follow whatever pack is loaded.
 *
 * The cast is deliberate. `Faction` in `src/models/gym.model.ts` now holds only `NEUTRAL` —
 * the three team members were deleted once these call sites stopped naming them, and the
 * model's validator reads `pack.factions` rather than the enum. So the cast is not widening
 * a string into one of three known members; it is saying that a pack-declared faction id is
 * what this field carries, which the enum no longer describes and the validator already
 * enforces. Keeping it in this one file is what made that deletion a no-op everywhere else.
 */
import { pack } from '../../src/content/loader';
import type { Faction } from '../../src/models/gym.model';

const playable = pack.factions.map((f) => f.id).filter((id) => id !== 'NEUTRAL');

// Fail loudly at import rather than handing back `undefined`, which would surface much later
// as a gym seeded with no controlling faction and a test failing for the wrong reason.
if (playable.length < 2) {
  throw new Error(
    `tests/helpers/factions: the active pack declares ${playable.length} playable faction(s); `
    + 'these helpers need two distinct sides to tell reinforce from contest.',
  );
}

/** The side a gym under test is held by. */
export const HOLDER = playable[0] as Faction;

/** A different side, so contesting is a different code path from reinforcing. */
export const RIVAL = playable[1] as Faction;
