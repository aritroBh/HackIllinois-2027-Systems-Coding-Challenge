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
 * `REQUIRE_GEOFENCE` optionally requires GPS on a battle, closing remote capture. It is
 * off by default so the dashboard works without location permission, and it is the only
 * place in the codebase that flag has any effect.
 */
import { Gym, IGym, Faction } from '../models/gym.model';
import { Volunteer } from '../models/volunteer.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { env } from '../config/env';
import { KarmaService, KarmaSource } from './karma.service';
import { domainEvents } from '../common/events/domainEvents';

/** Minimum gap between karma-paying battles per volunteer (anti-farm). */
const GYM_KARMA_COOLDOWN_MS = 60000;

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

export class GymService {
  /**
   * Retrieves all campus gyms with real-time control points.
   */
  public static async listGyms(): Promise<IGym[]> {
    return Gym.find().sort({ name: 1 });
  }

  /**
   * Atomic CAS Battle / Fortification Engine.
   * - If volunteer is in the controlling faction (or gym is NEUTRAL): reinforce points up to max.
   * - If volunteer is in an opposing faction: attack and reduce points.
   * - If control points reach 0: Gym is captured, flips faction, attacker becomes new Gym Leader!
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

    // Faction lock: the client names a faction per request, so without this
    // one account could reinforce as an ally and attack as a rival at will.
    // The first non-neutral battle binds the account; later mismatches fail.
    if (volunteerFaction !== Faction.NEUTRAL) {
      if (volunteer.faction && volunteer.faction !== volunteerFaction) {
        throw ApiError.conflict(
          `Faction allegiance locked to ${volunteer.faction}. Cannot battle as ${volunteerFaction}.`,
          ErrorCode.FACTION_ALLEGIANCE_LOCKED
        );
      }
      if (!volunteer.faction) {
        await Volunteer.findByIdAndUpdate(volunteerId, { $set: { faction: volunteerFaction } });
      }
    }

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
        const geoCheck = GeoEngine.isWithinGeofence(
          coordinates,
          { latitude: gym.latitude, longitude: gym.longitude },
          75
        );
        if (!geoCheck.allowed) {
          throw ApiError.forbidden(
            `Out of range: You are ${geoCheck.distanceMeters}m from ${gym.name}. Must be within 75m to contest this Gym.`
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
