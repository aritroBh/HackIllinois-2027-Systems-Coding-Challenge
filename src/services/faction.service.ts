/**
 * Faction allegiance: choosing a side, and the rule that you only choose once.
 *
 * The rule itself is old and lives in `GymService.battleOrContribute`: the client names a
 * faction on every battle request, so without a lock one account could reinforce as an ally and
 * attack as a rival at will. The first non-neutral battle binds the account; later mismatches
 * are refused.
 *
 * This module exists because that rule was about to have a second implementation. The dashboard
 * has a faction picker, and it was purely local — `public/app.js` keeps
 * `currentVolunteerFaction` in a module variable, defaults it to the first playable faction, and
 * no endpoint ever wrote it. So the HUD said TEAM KERNEL while `GET /me/card` said NEUTRAL for
 * the same account in the same second, and a reload silently changed your side. Adding an
 * endpoint that wrote the field without going through the lock would have given the system two
 * places that decide when allegiance is settled, which is how the check-in geofence and the map
 * ended up with two gazetteers.
 *
 * So the lock moved here and `GymService` calls it. One rule, one implementation, two callers.
 *
 * ## Why the write is a conditional update and not a save
 *
 * Two first-ever requests declaring different factions both read `faction == null` and both
 * write; last write wins, and the loser has fought a battle for a side it is not on. The filter
 * makes the binding itself the claim: exactly one request can match `faction: null`, and the
 * loser re-reads and takes the mismatch branch — which is what a second request naming a
 * different faction is supposed to get anyway.
 *
 * ## Why NEUTRAL is refused
 *
 * `NEUTRAL` is the unclaimed state of a *territory*, not a side a person can be on. Allowing it
 * here would let an account sit in a state where `volunteer.faction` is set but matches no
 * playable faction, which every downstream `isAlly` comparison would then answer strangely. In
 * the battle path it was worse than strange: declaring `NEUTRAL` skipped the lock entirely and
 * let a bound account attack its own gyms.
 */
import { Types } from 'mongoose';
import { Volunteer } from '../models/volunteer.model';
import { pack } from '../content/loader';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

/** The faction ids a person may actually hold — the pack's, minus the unclaimed state. */
export function playableFactions(): string[] {
  return pack.factions.map((faction) => faction.id).filter((id) => id !== 'NEUTRAL');
}

/**
 * Refuse anything that is not a side somebody can be on.
 *
 * Reads the pack rather than an enum in `src/`, so a fork's own factions work and a typo is
 * refused with the list of what was expected — the message is the documentation for anybody
 * calling this by hand.
 */
export function assertPlayable(faction: string): void {
  if (!playableFactions().includes(faction)) {
    throw ApiError.badRequest(
      faction === 'NEUTRAL'
        ? 'NEUTRAL is the unclaimed state of a territory, not a side. Pick one of: ' + playableFactions().join(', ') + '.'
        : `Unknown faction "${faction}". This event's factions are: ${playableFactions().join(', ')}.`,
      { code: ErrorCode.VALIDATION_ERROR }
    );
  }
}

/** What `bindFaction` did, so a caller can tell a first choice from a repeat. */
export interface FactionBinding {
  faction: string;
  /** True when this call is what settled it; false when the account was already bound to it. */
  bound: boolean;
}

/**
 * Bind an account to a faction, or confirm it is already on that one.
 *
 * Idempotent on the same faction — asking again for the side you already hold is a success, not
 * a conflict, because a client retrying a request it is unsure landed must not be told it has
 * done something wrong. A *different* faction is `409 FACTION_ALLEGIANCE_LOCKED`.
 *
 * `assertPlayable` runs first, so a caller cannot bind to a faction the pack does not declare
 * even by calling this directly.
 */
export async function bindFaction(volunteerId: string | Types.ObjectId, faction: string): Promise<FactionBinding> {
  assertPlayable(faction);

  const id = typeof volunteerId === 'string' ? new Types.ObjectId(volunteerId) : volunteerId;
  const account = await Volunteer.findById(id).select('faction');
  if (!account) {
    throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
  }

  if (account.faction) {
    if (account.faction !== faction) {
      throw ApiError.conflict(
        `Faction allegiance is locked to ${account.faction}. It is chosen once and cannot be changed.`,
        ErrorCode.FACTION_ALLEGIANCE_LOCKED
      );
    }
    return { faction, bound: false };
  }

  // Conditional on the account still being unbound: this update *is* the claim.
  const claimed = await Volunteer.findOneAndUpdate(
    { _id: id, $or: [{ faction: null }, { faction: { $exists: false } }] },
    { $set: { faction } },
    { new: true }
  ).select('faction');

  if (claimed) return { faction, bound: true };

  // Lost the race. Re-read to find out to what, and answer as though the other request had
  // simply arrived first — which it did.
  const settled = await Volunteer.findById(id).select('faction');
  if (settled?.faction && settled.faction !== faction) {
    throw ApiError.conflict(
      `Faction allegiance is locked to ${settled.faction}. It is chosen once and cannot be changed.`,
      ErrorCode.FACTION_ALLEGIANCE_LOCKED
    );
  }
  return { faction, bound: false };
}
