/**
 * Campus territory control — the PokéShift gym layer.
 *
 * Volunteers pick a faction and contest the fourteen mapped campus monuments. Reinforcing
 * an allied gym raises its control points; attacking an enemy gym lowers them; driving
 * them to zero flips the gym and makes the attacker its leader.
 *
 * Every battle mutation is an atomic compare-and-swap on a `version` field rather than a
 * read-modify-write. Two volunteers attacking the same gym on the last control point
 * would otherwise both read "1 point remaining", both write a capture, and both become
 * leader — the classic lost update. The loser of the CAS retries against fresh state.
 *
 * Power-up effects reach a gym from `hackstop.service` rather than through this file, and
 * they are not CAS retries — they are single atomic writes (a pipeline `$min`/`$add` for
 * the control-point boost, a `$set` plus a `version` bump for the shield). Different
 * mechanism, same guarantee: no path reads a gym, computes, and writes back.
 *
 * `awardBattleKarma` gates the *payout* behind a conditional per-volunteer cooldown, not
 * the battle. Without it, holding down reinforce on a friendly gym mints karma as fast as
 * requests can be issued. The conditional update also means two concurrent battles cannot
 * both pass the cooldown check and pay twice. Battle effects still apply while the
 * cooldown is active; only the karma stops, so spamming changes the map but not the score.
 *
 * `REQUIRE_GEOFENCE` is the only place in the codebase that flag has any effect, and over HTTP
 * it currently has none — which is worth stating plainly rather than leaving as a surprise.
 * `battleGymSchema` makes `coordinates` unconditionally required, so Zod rejects a body without
 * them before this service is entered, and the `if (env.REQUIRE_GEOFENCE && !coordinates)` check
 * below can only be reached by a direct call from another service or a test. The remote-capture
 * bypass it was written to close is already closed, one layer earlier and in every posture.
 *
 * The comment here used to say the flag was "off by default so the dashboard works without
 * location permission". That has not been true since `coordinates` became required: a dashboard
 * without location permission cannot battle at all, whatever the flag says. The check is kept
 * because it is correct for the non-HTTP callers, and because making coordinates optional again
 * is a decision somebody might take; it is not kept because it currently guards a request.
 */
import { Gym, IGym, Faction } from '../models/gym.model';
import { Volunteer } from '../models/volunteer.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { bindFaction } from './faction.service';
import { geofenceMetersFor } from '../common/utils/geofence';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { env } from '../config/env';
import { KarmaService, KarmaSource } from './karma.service';
import { domainEvents } from '../common/events/domainEvents';

/** Minimum gap between karma-paying battles per volunteer (anti-farm). */
const GYM_KARMA_COOLDOWN_MS = 60000;

/**
 * The outcome of one strike. `karmaAwarded` is what actually landed, not what the strike was
 * priced at: zero while this volunteer's minute-long payout cooldown is running, and clamped
 * again by the pack's daily `GYM` ceiling.
 */
export interface IBattleResult {
  gymId: string;
  action: 'CONTRIBUTED' | 'ATTACKED' | 'CAPTURED';
  controllingFaction: Faction;
  newControlPoints: number;
  maxControlPoints: number;
  leaderName: string;
  karmaAwarded: number;
  message: string;
}

/**
 * A gym as the map layer is allowed to see it.
 *
 * `GET /pokeshift/gyms` carries no session requirement, so in `legacy` — the shipped default
 * `AUTH_MODE` — an anonymous caller reached it. It returned whole Mongoose documents, and a gym
 * document holds `leaderVolunteerId`, `leaderName`, `lastBattledAt` and a `defenders` array
 * whose entries carry `volunteerName`, `contributedPower` and `assignedAt`.
 *
 * A gym is a named campus building, and contesting one requires standing within 75 m of it. So
 * those fields together said that a named person was at a named place at a stated time, to
 * anybody who asked, with no credential behind the request and no audit row behind the read.
 * That is the same disclosure that had already been taken off the beacon listing when
 * `lastSpunUsers` was removed from it, and it is the fourth or fifth appearance in this
 * repository of the same class: a projection nobody wrote, on a route nobody gated, in the auth
 * mode that admits everyone.
 *
 * The redaction costs the interface nothing, which is the part worth checking rather than
 * assuming. The client reads exactly one thing off the sensitive half: a count, rendered as
 * "N defending". No view reads `leaderName`, `leaderVolunteerId`, `lastBattledAt`, or any field
 * of an individual defender.
 *
 * Deliberately no line numbers, and no longer an expression to grep for. This paragraph used to
 * say the client read `(g.defenders || []).length` at `public/app.js:788` and `:1951`. All three
 * facts died in the same change: the projection replaced the `defenders` array with a
 * `defenderCount` scalar, so the expression greps to nothing, and the two line numbers now point
 * at a shift renderer and a coordinate comment. An auditor checking this redaction was sent to
 * two unrelated places to look for something that no longer exists.
 *
 * `public/` is owned by a different session and its line numbers move under this file. Citing a
 * behaviour that can be grepped for (`defenderCount`) outlives citing a location that cannot.
 */
export interface PublicGym {
  _id: unknown;
  name: string;
  locationName: string;
  latitude: number;
  longitude: number;
  controllingFaction: Faction;
  controlPoints: number;
  maxControlPoints: number;
  level: number;
  isShielded: boolean;
  /**
   * How many hold it, and the only thing about them that leaves the server.
   *
   * There was briefly a `defenders` field alongside this — a length-preserving array of empty
   * objects — so that a client counting `defenders.length` kept working across the change. Both
   * call sites read `defenderCount` now, so the shim is gone.
   */
  defenderCount: number;
}

export class GymService {
  /**
   * Every gym, name-ordered, redacted for an audience that may be anonymous.
   *
   * See `PublicGym` for what is removed and why. `.lean()` because nothing here needs a
   * hydrated document and the projection discards most of it anyway.
   */
  public static async listGymsPublic(): Promise<PublicGym[]> {
    const gyms = await Gym.find()
      .select('name locationName latitude longitude controllingFaction controlPoints maxControlPoints level isShielded defenders')
      .sort({ name: 1 })
      .lean();
    return gyms.map((gym) => ({
      _id: gym._id,
      name: gym.name,
      locationName: gym.locationName,
      latitude: gym.latitude,
      longitude: gym.longitude,
      controllingFaction: gym.controllingFaction,
      controlPoints: gym.controlPoints,
      maxControlPoints: gym.maxControlPoints,
      level: gym.level,
      isShielded: gym.isShielded,
      defenderCount: (gym.defenders ?? []).length,
    }));
  }

  /**
   * Every gym, unredacted, name-ordered. A gym carries no active flag, so this really is the
   * whole board.
   *
   * **Not reachable from HTTP.** `GET /pokeshift/gyms` answers from `listGymsPublic` above.
   * This one exists for server-side callers that need the full document — and for a future
   * organiser view, which would need its own role gate and its own audit row before it could
   * use this.
   */
  public static async listGyms(): Promise<IGym[]> {
    return Gym.find().sort({ name: 1 });
  }

  /**
   * One strike against a gym: reinforce it, damage it, or take it.
   *
   * Which of the three happens is decided by who holds the gym, not by the caller — there is
   * no "attack" or "reinforce" parameter to lie about, only a faction and a power. A gym held
   * by your own faction, or by nobody, is reinforced; anything else is attacked. A strike
   * whose power meets or exceeds the remaining control points captures outright rather than
   * reducing them to zero, so a gym is never left standing at nought waiting for somebody to
   * send one more request.
   *
   * **Reinforcing neutral ground claims it.** The ally branch writes `controllingFaction`
   * unconditionally, and `isAlly` counts NEUTRAL as an ally, so the first person to reinforce
   * an unclaimed gym flies their flag over it. That is a capture in everything but the wire
   * format: it broadcasts `GYM_REINFORCED` and emits no `gym.captured` domain event, so the
   * quests, raids and plugins that count captures do not count walking up to an empty
   * building. Only taking a gym off a rival counts.
   *
   * **Leadership can change without the gym changing hands.** A friendly strike above 150
   * power replaces the leader, so a stronghold's name is the last person to commit
   * meaningfully to it rather than whoever happened to touch it first.
   *
   * The placement of the checks is what makes them mean anything. The `NEUTRAL` refusal and
   * the faction lock sit outside the retry loop, because they are facts about the account and
   * cannot change while it is being contended for. The geofence and the shield sit inside it,
   * re-evaluated against the gym as it was read on this attempt: a shield dropped by somebody
   * else's power-up while this request was losing a compare-and-swap has to stop the retry,
   * and it does, because the read that feeds the check is inside the loop rather than above
   * it. The radius comes from the pack — `geofenceMetersFor()` with no venue key, so the
   * campus-wide value — rather than the beacon-style per-document field HackStops use. A gym
   * therefore widens with its campus and not on its own; `territories.json` names a venue per
   * gym, so carrying that key onto the document would make per-gym radii possible, and that is
   * a schema change rather than a line here.
   *
   * Karma is paid after the CAS has won and nothing compensates it if the award throws: the
   * strike stands and the payout is lost. That is the survivable direction — the alternative
   * is a second write undoing a document that other players are already contending for.
   *
   * Five attempts, jittered, then a 409 that asks the caller to try again. A bounded loop
   * that gives up is the honest answer to contention this cannot resolve; spinning would only
   * move the queue into the database.
   */
  public static async battleOrContribute(
    gymId: string,
    volunteerId: string,
    volunteerFaction: Faction,
    power: number = 100,
    coordinates?: IGeoCoordinates
  ): Promise<IBattleResult> {
    if (!Number.isFinite(power) || power < 10 || power > 500) {
      throw ApiError.badRequest('Attack/defense power must be a finite number between 10 and 500.');
    }

    const volunteer = await Volunteer.findById(volunteerId);
    if (!volunteer) {
      throw ApiError.notFound('Volunteer not found.');
    }

    // NEUTRAL is not a side you can fight for.
    //
    // The lock below only ran for a non-neutral declaration, and `isAlly` compares the
    // declared faction to the gym's — so an account already bound to TEAM_KERNEL could
    // declare `NEUTRAL`, skip the lock entirely, and then take the attack branch against
    // any gym including its own, capture it for nobody, and be paid for it. The whole
    // purpose of the lock is that one account cannot reinforce as an ally and attack as a
    // rival at will, and `NEUTRAL` was the word that turned it off.
    if (volunteerFaction === Faction.NEUTRAL) {
      throw ApiError.badRequest(
        'Pick a faction to contest a gym: NEUTRAL is the unclaimed state, not a side.',
        { code: ErrorCode.VALIDATION_ERROR }
      );
    }

    // Faction lock: the client names a faction per request, so without this one account could
    // reinforce as an ally and attack as a rival at will. The first battle binds the account;
    // later mismatches fail.
    //
    // The rule itself lives in `faction.service.ts` rather than here, and that move was made
    // when `PATCH /me/faction` was added. The endpoint has to enforce exactly this — bind if
    // unbound, refuse a different side, accept the same one — and a second implementation of
    // "when is allegiance settled" is how this repository ended up with two gazetteers and two
    // loot tables. One rule, one implementation, two callers.
    //
    // What that service does that this block used to spell out: the write is a conditional
    // update, not a save. Two first-ever battles declaring different factions both read
    // `faction == null` and both wrote; the second won, so one of the two accounts fought a
    // whole battle for a side it was not, in the end, on. The filter makes the binding itself
    // the claim, and the loser takes the mismatch branch — which is what a second request
    // naming a different faction is supposed to get anyway.
    await bindFaction(volunteerId, volunteerFaction);

    // Strict mode closes the remote-capture bypass: coordinates mandatory.
    if (env.REQUIRE_GEOFENCE && !coordinates) {
      throw ApiError.badRequest('GPS coordinates are required to contest a gym.', {
        code: ErrorCode.MISSING_REQUIRED_FIELD,
      });
    }

    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Jittered backoff between CAS retries. A bare spin makes every loser retry in the
      // same instant, so the same writer keeps losing and the database sees a thundering herd.
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 40 * attempt)));
      }
      const gym = await Gym.findById(gymId);
      if (!gym) {
        throw ApiError.notFound('Gym not found.');
      }

      // Checked whenever coordinates are present, not only under REQUIRE_GEOFENCE: a client
      // that volunteers a position is held to it either way.
      if (coordinates) {
        // The campus-wide radius from the pack, not a literal.
        //
        // Campus-wide rather than per-venue, and the reason is a real limit rather than a
        // shortcut: a `Gym` document stores coordinates and no venue key, so there is nothing
        // here to look a venue's own `radiusMeters` up by. `territories.json` does name a venue
        // per gym, so carrying it onto the document would make per-gym radii possible — that is
        // a schema change and a migration, not a line here, and it is worth doing only if an
        // event actually has a landmark that needs a different radius from its campus default.
        const radiusMeters = geofenceMetersFor();
        const geoCheck = GeoEngine.isWithinGeofence(
          coordinates,
          { latitude: gym.latitude, longitude: gym.longitude },
          radiusMeters
        );
        if (!geoCheck.allowed) {
          // Quotes the radius applied, not a literal that may disagree with it.
          throw ApiError.forbidden(
            `Out of range: You are ${geoCheck.distanceMeters}m from ${gym.name}. Must be within ${geoCheck.maxRadiusMeters}m to contest this Gym.`
          );
        }
      }

      // Expiry is compared here rather than swept by a job, so a lapsed shield stops
      // protecting the gym the moment someone contests it.
      if (gym.isShielded && gym.shieldExpiresAt && gym.shieldExpiresAt > new Date()) {
        throw ApiError.conflict('Gym is currently protected by an active Boba Shield. Cannot contest!');
      }

      const currentFaction = gym.controllingFaction;
      const isAlly = currentFaction === Faction.NEUTRAL || currentFaction === volunteerFaction;

      if (isAlly) {
        const newPoints = Math.min(gym.maxControlPoints, gym.controlPoints + power);
        const shouldBeLeader = !gym.leaderVolunteerId || power > 150;

        const updated = await Gym.findOneAndUpdate(
          { _id: gym._id, version: gym.version },
          {
            $set: {
              controllingFaction: volunteerFaction,
              controlPoints: newPoints,
              leaderVolunteerId: shouldBeLeader ? volunteer._id : gym.leaderVolunteerId,
              leaderName: shouldBeLeader ? volunteer.name : gym.leaderName,
              lastBattledAt: new Date(),
            },
            $inc: { version: 1 },
          },
          { new: true }
        );

        if (!updated) continue; // CAS conflict, retry next iteration

        const karmaAward = await this.awardBattleKarma(volunteerId, Math.floor(power * 0.25));

        eventHub.broadcast({
          type: 'GYM_REINFORCED',
          data: { gymId, faction: volunteerFaction, controlPoints: newPoints, leaderName: updated.leaderName },
        });

        return {
          gymId,
          action: 'CONTRIBUTED',
          controllingFaction: volunteerFaction,
          newControlPoints: newPoints,
          maxControlPoints: gym.maxControlPoints,
          leaderName: updated.leaderName,
          karmaAwarded: karmaAward,
          message: `Successfully fortified ${gym.name} for ${volunteerFaction}! (+${power} CP)`,
        };
      } else {
        if (gym.controlPoints > power) {
          const newPoints = gym.controlPoints - power;
          const updated = await Gym.findOneAndUpdate(
            { _id: gym._id, version: gym.version },
            {
              $set: {
                controlPoints: newPoints,
                lastBattledAt: new Date(),
              },
              $inc: { version: 1 },
            },
            { new: true }
          );

          if (!updated) continue; // CAS conflict, retry next iteration

          const karmaAward = await this.awardBattleKarma(volunteerId, Math.floor(power * 0.35));

          eventHub.broadcast({
            type: 'GYM_ATTACKED',
            data: { gymId, attackedFaction: currentFaction, remainingPoints: newPoints },
          });

          return {
            gymId,
            action: 'ATTACKED',
            controllingFaction: currentFaction,
            newControlPoints: newPoints,
            maxControlPoints: gym.maxControlPoints,
            leaderName: gym.leaderName,
            karmaAwarded: karmaAward,
            message: `Inflicted ${power} damage on ${gym.name}! ${newPoints} CP remaining.`,
          };
        } else {
          // A strike that meets or exceeds the remaining points flips the gym. The reset is
          // clamped inside [100, maxControlPoints]: a bare floor of 100 hands a small gym
          // more points than its own ceiling. Defenders are cleared because the regime
          // changed; the capture broadcast is the audit trail for who held it before.
          const freshControlPoints = Math.min(gym.maxControlPoints, Math.max(100, power));
          const updated = await Gym.findOneAndUpdate(
            { _id: gym._id, version: gym.version },
            {
              $set: {
                controllingFaction: volunteerFaction,
                controlPoints: freshControlPoints,
                leaderVolunteerId: volunteer._id,
                leaderName: volunteer.name,
                defenders: [
                  {
                    volunteerId: volunteer._id,
                    volunteerName: volunteer.name,
                    contributedPower: power,
                    assignedAt: new Date(),
                  },
                ],
                lastBattledAt: new Date(),
              },
              $inc: { version: 1 },
            },
            { new: true }
          );

          if (!updated) continue; // CAS conflict, retry next iteration

          const karmaAward = await this.awardBattleKarma(volunteerId, 150); // Capture bonus!

          // Committed: the capture is durable, so anything that reacts to it can now run.
          domainEvents.emit('gym.captured', { accountId: String(volunteerId), gymId: String(gymId), faction: String(volunteerFaction) });

          eventHub.broadcast({
            type: 'GYM_CAPTURED',
            data: {
              gymId,
              newFaction: volunteerFaction,
              conqueror: volunteer.name,
              controlPoints: freshControlPoints,
            },
          });

          return {
            gymId,
            action: 'CAPTURED',
            controllingFaction: volunteerFaction,
            newControlPoints: freshControlPoints,
            maxControlPoints: gym.maxControlPoints,
            leaderName: volunteer.name,
            karmaAwarded: karmaAward,
            message: `💥 CAPTURE! ${gym.name} was overthrown and now flies the banner of ${volunteerFaction}!`,
          };
        }
      }
    }

    throw ApiError.conflict('Gym contestation was interrupted by high-concurrency write contention. Please retry.');
  }

  /**
   * Awards battle karma subject to an atomic per-volunteer cooldown. The
   * conditional update means concurrent battles cannot both mint karma, and
   * spamming reinforce on an allied gym stops paying after the first hit.
   * Battle effects still apply during cooldown; only the payout is gated.
   */
  private static async awardBattleKarma(volunteerId: string, amount: number): Promise<number> {
    const cutoff = new Date(Date.now() - GYM_KARMA_COOLDOWN_MS);
    // The CAS still owns the cooldown: it is what stops two captures inside the window both
    // paying. Only the payout itself moved, so caps and the ledger apply here too.
    const claimed = await Volunteer.findOneAndUpdate(
      {
        _id: volunteerId,
        $or: [{ lastGymKarmaAt: null }, { lastGymKarmaAt: { $lt: cutoff } }],
      },
      { $set: { lastGymKarmaAt: new Date() } },
      { new: true }
    );
    if (!claimed) return 0;
    const award = await KarmaService.awardKarma(volunteerId, amount, KarmaSource.GYM, { reason: 'gym-capture' });
    return award.awarded;
  }
}
