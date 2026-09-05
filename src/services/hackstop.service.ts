import { HackStop, IHackStop } from '../models/hackstop.model';
import { PowerUpInventory, PowerUpType, POWER_UP_CATALOG, IPowerUpInventory } from '../models/powerup.model';
import { Volunteer } from '../models/volunteer.model';
import { Gym } from '../models/gym.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { eventHub } from '../common/sse/eventHub';

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
    volunteerId: string,
    userCoords: IGeoCoordinates
  ): Promise<ISpinResult> {
    const hackStop = await HackStop.findOne({ beaconId, isActive: true });
    if (!hackStop) {
      throw ApiError.notFound(`Active HackStop beacon "${beaconId}" not found.`);
    }

    // 1. Geodesic Geofence Verification via Haversine
    const distanceMeters = GeoEngine.haversineDistanceMeters(userCoords, {
      latitude: hackStop.latitude,
      longitude: hackStop.longitude,
    });

    if (distanceMeters > hackStop.geofenceRadiusMeters) {
      throw ApiError.forbidden(
        `Out of range: You are ${Math.round(distanceMeters)}m away. Must be within ${hackStop.geofenceRadiusMeters}m to spin ${hackStop.name}.`
      );
    }

    // 2. Cooldown Verification (5-minute sliding window)
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

    // 3. Roll Loot Table
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
    const awardedKarma = Math.floor(Math.random() * 25) + 25 + itemMeta.karmaBonus;

    // 4. Update Cooldown & Total Spins
    hackStop.lastSpunUsers.set(volunteerId, new Date(now));
    hackStop.totalSpins += 1;
    await hackStop.save();

    // 5. Award Power-Up to Volunteer Inventory
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

    // 6. Award Karma to Volunteer
    await Volunteer.findByIdAndUpdate(volunteerId, { $inc: { karmaPoints: awardedKarma } });

    const nextAvailableAt = new Date(now + hackStop.cooldownSeconds * 1000);

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
    const inv = await PowerUpInventory.findOneAndUpdate(
      { volunteerId, itemType, quantity: { $gte: 1 } },
      { $inc: { quantity: -1 } },
      { new: true }
    );

    if (!inv) {
      throw ApiError.badRequest(`Insufficient inventory: You have zero ${itemType}.`);
    }

    const itemMeta = POWER_UP_CATALOG[itemType];

    // Effect resolution
    if (itemType === PowerUpType.OVERCLOCK_SOLDER_CORE && targetGymId) {
      await Gym.findByIdAndUpdate(targetGymId, { $inc: { controlPoints: 250 } });
    } else if (itemType === PowerUpType.INSOMNIA_COOKIE_SHIELD && targetGymId) {
      const shieldExpiry = new Date(Date.now() + 7200000); // 2 hours
      await Gym.findByIdAndUpdate(targetGymId, {
        $set: { isShielded: true, shieldExpiresAt: shieldExpiry },
      });
    }

    await Volunteer.findByIdAndUpdate(volunteerId, { $inc: { karmaPoints: itemMeta.karmaBonus } });

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
