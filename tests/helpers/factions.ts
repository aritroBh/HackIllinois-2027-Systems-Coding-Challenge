/**
 * Two different playable sides, taken from the pack rather than named.
 *
 * The suite wrote `Faction.TEAM_KERNEL` and `Faction.TEAM_TENSOR` seventeen times, and in
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
 * The cast is deliberate and is the honest shape of things. `Faction` in `src/models/gym.model.ts`
 * still enumerates the shipped pack's three teams, but the model's validator has already moved
 * to `pack.factions` and does not consult the enum, so the enum is a stale convenience the
 * server no longer believes. Casting here, in one place with this note, is what lets those
 * three members be deleted without touching a single call site.
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
