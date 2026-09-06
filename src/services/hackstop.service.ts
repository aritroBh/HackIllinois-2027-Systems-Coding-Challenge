/**
 * HackStops — geofenced supply beacons that dispense power-ups.
 *
 * A volunteer standing within 75 m of a beacon spins it for a weighted-random power-up
 * and some karma. The loot roll happens server-side; the client is told what it got, and
 * never gets to influence rarity.
 *
 * The interesting constraint is the per-volunteer cooldown, which is stored as a map on
 * the beacon keyed by volunteer id. Two consequences follow from that shape:
 *
 *  - **The claim must be atomic.** It is a single conditional update matching only when
 *    no fresh spin exists for this volunteer, so two concurrent spins cannot both pass.
 *    Read-then-write would let a double-click collect twice.
 *  - **The key must be normalised.** Because the id is a Mongo map field path, casing is
 *    identity: `6A9B…` and `6a9b…` would occupy separate keys and give one volunteer as
 *    many independent cooldowns as they cared to spell. `spinBeacon` lowercases before
 *    the value is used as a key anywhere. This was a live, demonstrated bypass, not a
 *    theoretical one; the before/after measurement is in the README's evidence table.
 *    Normalising at the schema boundary alone would not be enough here — this service is
 *    also called directly, so the key is normalised where it is used as a key.
 *
 * Stale cooldown entries are pruned so the map does not grow without bound across an
 * event.
 */
import { HackStop, IHackStop } from '../models/hackstop.model';
import { PowerUpInventory, PowerUpType, POWER_UP_CATALOG, IPowerUpInventory } from '../models/powerup.model';
import { Gym } from '../models/gym.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { eventHub } from '../common/sse/eventHub';
import { KarmaService, KarmaSource } from './karma.service';
import { domainEvents } from '../common/events/domainEvents';

export interface ISpinResult {
  hackStopId: string;
  beaconId: string;
  name: string;
  distanceMeters: number;
  awardedKarma: number;
  awardedPowerUp: PowerUpType;
  itemDetails: {
    name: string;
    rarity: string;
    description: string;
  };
  nextAvailableAt: Date;
}

export class HackStopService {
  /**
   * Retrieves all active HackStop supply beacons.
   */
  public static async listBeacons(): Promise<IHackStop[]> {
    return HackStop.find({ isActive: true }).sort({ name: 1 });
  }

  /**
   * Evaluates 75m geodesic geofence and 5-min cooldown, awarding power-ups and karma on success.
   */
  public static async spinBeacon(
    beaconId: string,
    rawVolunteerId: string,
    userCoords: IGeoCoordinates
  ): Promise<ISpinResult> {
    // The cooldown is keyed by this string as a Mongo map field path, so casing is
    // identity here: `6A9B…` and `6a9b…` would occupy separate keys and give one
    // volunteer 2^n independent cooldowns. Normalise before it is ever used as a key.
    const volunteerId = rawVolunteerId.toLowerCase();

    const hackStop = await HackStop.findOne({ beaconId, isActive: true });
    if (!hackStop) {
      throw ApiError.notFound(`Active HackStop beacon "${beaconId}" not found.`);
    }

    if (
      !userCoords ||
      !Number.isFinite(userCoords.latitude) ||
      !Number.isFinite(userCoords.longitude)
    ) {
      throw ApiError.badRequest('Valid finite latitude and longitude coordinates are required.');
    }

    const distanceMeters = GeoEngine.haversineDistanceMeters(userCoords, {
      latitude: hackStop.latitude,
      longitude: hackStop.longitude,
    });

    if (Number.isNaN(distanceMeters) || distanceMeters > hackStop.geofenceRadiusMeters) {
      throw ApiError.forbidden(
        `Out of range: You are ${Math.round(distanceMeters)}m away. Must be within ${hackStop.geofenceRadiusMeters}m to spin ${hackStop.name}.`
      );
    }

    // A cheap early refusal so the common double-tap gets a countdown instead of rolling
    // loot it will not receive. The claim below is what actually enforces the cooldown.
    const now = Date.now();
    const lastSpunTime = hackStop.lastSpunUsers.get(volunteerId);
    if (lastSpunTime) {
      const elapsedSeconds = (now - new Date(lastSpunTime).getTime()) / 1000;
      if (elapsedSeconds < hackStop.cooldownSeconds) {
        const remainingSeconds = Math.ceil(hackStop.cooldownSeconds - elapsedSeconds);
        throw ApiError.conflict(
          `HackStop cooling down: Available again in ${remainingSeconds} seconds.`
        );
      }
    }

    // Weights are server-side and never travel to the client, so rarity cannot be asked for.
    const lootWeights: Array<{ type: PowerUpType; weight: number }> = [
      { type: PowerUpType.COLD_BREW_ELIXIR, weight: 40 },
      { type: PowerUpType.INSOMNIA_COOKIE_SHIELD, weight: 25 },
      { type: PowerUpType.OVERCLOCK_SOLDER_CORE, weight: 20 },
      { type: PowerUpType.RUBBER_DUCK_OMNISCIENCE, weight: 10 },
      { type: PowerUpType.ANKER_GAUNTLET, weight: 5 },
    ];

    const roll = Math.random() * 100;
    let cumulative = 0;
    let awardedPowerUp = PowerUpType.COLD_BREW_ELIXIR;

    for (const item of lootWeights) {
      cumulative += item.weight;
      if (roll <= cumulative) {
        awardedPowerUp = item.type;
        break;
      }
    }

    const itemMeta = POWER_UP_CATALOG[awardedPowerUp];
    let awardedKarma = Math.floor(Math.random() * 25) + 25 + itemMeta.karmaBonus;

    // Atomically claim the cooldown slot. The conditional update only
    // matches when no fresh spin exists for this volunteer, so concurrent
    // double-spins cannot both pass. If the claim loses, fall through to the
    // legacy read path below, which re-reads fresh state and reports the
    // accurate outcome (cooldown message preserved for the test contract).
    // NOTE: volunteerIds are ObjectId hex (validated upstream), so the dotted
    // map path cannot be abused for key injection.
    const cooldownCutoff = new Date(now - hackStop.cooldownSeconds * 1000);
    const claimed = await HackStop.findOneAndUpdate(
      {
        _id: hackStop._id,
        $or: [
          { [`lastSpunUsers.${volunteerId}`]: { $exists: false } },
          { [`lastSpunUsers.${volunteerId}`]: { $lt: cooldownCutoff } },
        ],
      },
      {
        $set: { [`lastSpunUsers.${volunteerId}`]: new Date(now) },
        $inc: { totalSpins: 1 },
      },
      { new: true }
    );

    if (!claimed) {
      const fresh = await HackStop.findById(hackStop._id);
      if (!fresh) {
        throw ApiError.notFound(`Active HackStop beacon "${beaconId}" not found.`);
      }
      const lastSpunTime = fresh.lastSpunUsers.get(volunteerId);
      if (lastSpunTime) {
        const elapsedSeconds = (now - new Date(lastSpunTime).getTime()) / 1000;
        if (elapsedSeconds < fresh.cooldownSeconds) {
          const remainingSeconds = Math.ceil(fresh.cooldownSeconds - elapsedSeconds);
          throw ApiError.conflict(
            `HackStop cooling down: Available again in ${remainingSeconds} seconds.`
          );
        }
      }
      // Claim lost to a concurrent winner whose write has not yet become
      // visible, or clock skew: treat as cooldown rather than double-looting.
      throw ApiError.conflict('HackStop cooling down: spin already recorded. Try again shortly.');
    }

    // Prune expired cooldown entries. `lastSpunUsers` gains a key per volunteer who ever
    // spins this beacon, and a document that reaches Mongo's 16 MB limit stops accepting
    // spins entirely. Best-effort: a failed prune must never fail the spin that paid for it.
    try {
      const spun = claimed.lastSpunUsers;
      if (spun && spun.size > 500) {
        const staleUnset: Record<string, number> = {};
        for (const [uid, ts] of spun.entries()) {
          if (new Date(ts).getTime() < now - hackStop.cooldownSeconds * 1000 && uid !== volunteerId) {
            staleUnset[`lastSpunUsers.${uid}`] = 1;
          }
        }
        const staleKeys = Object.keys(staleUnset);
        if (staleKeys.length > 0) {
          await HackStop.updateOne({ _id: hackStop._id }, { $unset: staleUnset });
        }
      }
    } catch {
      // Prune is hygiene, not correctness.
    }
    await PowerUpInventory.findOneAndUpdate(
      { volunteerId, itemType: awardedPowerUp },
      {
        $inc: { quantity: 1 },
        $setOnInsert: {
          name: itemMeta.name,
          rarity: itemMeta.rarity,
          obtainedFrom: `HACKSTOP:${beaconId}`,
        },
      },
      { upsert: true, new: true }
    );

    // Pay through the ledger: spins are the easiest karma on the map, so the daily cap
    // on this source is the thing that stops a beacon becoming a farm.
    const spinAward = await KarmaService.awardKarma(volunteerId, awardedKarma, KarmaSource.HACKSTOP, { beaconId: hackStop.beaconId });
    awardedKarma = spinAward.awarded;

    const nextAvailableAt = new Date(now + hackStop.cooldownSeconds * 1000);

    // The spin is committed; anything that reacts to it (quests, plugins) subscribes rather
    // than being called from here.
    domainEvents.emit('hackstop.spun', { accountId: String(volunteerId), beaconId: hackStop.beaconId, awardedKarma });

    eventHub.broadcast({
      type: 'HACKSTOP_SPUN',
      data: {
        beaconId,
        hackStopName: hackStop.name,
        volunteerId,
        awardedKarma,
        awardedPowerUp,
        itemDetails: itemMeta,
      },
    });

    return {
      hackStopId: hackStop._id.toString(),
      beaconId,
      name: hackStop.name,
      distanceMeters,
      awardedKarma,
      awardedPowerUp,
      itemDetails: {
        name: itemMeta.name,
        rarity: itemMeta.rarity,
        description: itemMeta.description,
      },
      nextAvailableAt,
    };
  }

  /**
   * Retrieves volunteer's power-up inventory.
   */
  public static async getVolunteerInventory(volunteerId: string): Promise<IPowerUpInventory[]> {
    return PowerUpInventory.find({ volunteerId, quantity: { $gt: 0 } });
  }

  /**
   * Consumes a power-up from inventory with atomic quantity decrement.
   */
  public static async usePowerUp(
    volunteerId: string,
    itemType: PowerUpType,
    targetGymId?: string
  ): Promise<{ message: string; remainingQuantity: number }> {
    const itemMeta = POWER_UP_CATALOG[itemType];

    // The target is validated before the item is consumed. The decrement is not part of a
    // transaction, so a bad target after it would eat the item and still pay its karma
    // bonus for an effect that never landed.
    const needsTarget =
      itemType === PowerUpType.OVERCLOCK_SOLDER_CORE || itemType === PowerUpType.INSOMNIA_COOKIE_SHIELD;
    if (needsTarget && !targetGymId) {
      throw ApiError.badRequest(`${itemMeta.name} requires a target gym.`);
    }
    if (targetGymId) {
      const targetGym = await Gym.findById(targetGymId);
      if (!targetGym) {
        throw ApiError.badRequest('Target gym not found.');
      }
    }

    const inv = await PowerUpInventory.findOneAndUpdate(
      { volunteerId, itemType, quantity: { $gte: 1 } },
      { $inc: { quantity: -1 } },
      { new: true }
    );

    if (!inv) {
      throw ApiError.badRequest(`Insufficient inventory: You have zero ${itemType}.`);
    }

    if (itemType === PowerUpType.OVERCLOCK_SOLDER_CORE && targetGymId) {
      // Add-then-clamp, evaluated server-side as an aggregation-pipeline update.
      //
      // This used to read the gym, compute `min(max, cp + 250)` in Node, and write the
      // result back. That is a read-modify-write, and every gym mutation elsewhere is a
      // version CAS precisely because they lose updates: two volunteers spending a core
      // on the same gym both read the same `controlPoints` and both write the same
      // total, so one core is consumed and silently does nothing.
      //
      // Expressing the arithmetic as a pipeline makes it one atomic document update —
      // `$add` and `$min` run against the document's own current value, so concurrent
      // boosts compose instead of overwriting each other, and the clamp still holds.
      await Gym.findByIdAndUpdate(targetGymId, [
        {
          $set: {
            controlPoints: {
              $min: [{ $add: ['$controlPoints', 250] }, '$maxControlPoints'],
            },
            version: { $add: ['$version', 1] },
          },
        },
      ]);
    } else if (itemType === PowerUpType.INSOMNIA_COOKIE_SHIELD && targetGymId) {
      // Idempotent by nature — a later expiry simply wins, and two shields applied at
      // once leave the gym shielded either way — so this needs no CAS. It still bumps
      // `version` so a concurrent battle CAS re-reads rather than acting on stale state.
      const shieldExpiry = new Date(Date.now() + 7200000); // 2 hours
      await Gym.findByIdAndUpdate(targetGymId, {
        $set: { isShielded: true, shieldExpiresAt: shieldExpiry },
        $inc: { version: 1 },
      });
    }

    if (itemMeta.karmaBonus > 0) {
      await KarmaService.awardKarma(volunteerId, itemMeta.karmaBonus, KarmaSource.POWERUP, { itemType });
    }

    eventHub.broadcast({
      type: 'POWERUP_CONSUMED',
      data: { volunteerId, itemType, name: itemMeta.name },
    });

    return {
      message: `Successfully deployed ${itemMeta.name}!`,
      remainingQuantity: inv.quantity,
    };
  }
}
