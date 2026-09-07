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
 *    theoretical one — it was closed in `f3e58f2`, alongside the other casing-based guard
 *    bypasses of that round.
 *    Normalising at the schema boundary alone would not be enough here — this service is
 *    also called directly, so the key is normalised where it is used as a key.
 *
 * Stale cooldown entries are pruned so the map does not grow without bound across an
 * event.
 */
import { HackStop } from '../models/hackstop.model';
import { PowerUpInventory, PowerUpType, POWER_UP_CATALOG, IPowerUpInventory } from '../models/powerup.model';
import { Gym, Faction } from '../models/gym.model';
import { Volunteer } from '../models/volunteer.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { KarmaService, KarmaSource } from './karma.service';
import { domainEvents } from '../common/events/domainEvents';
import { rollLoot, rollKarma } from '../economy/lootTable';

/**
 * The radius for deploying a gym-targeted power-up, and the last place-bound check in the game
 * still using a literal.
 *
 * The other three are pack-driven: a spin reads the beacon's own `geofenceRadiusMeters` (which
 * the seed resolves from the pack), and a gym battle and an attendance check-in both call
 * `geofenceMetersFor` in `common/utils/geofence.ts`. This one has no venue to key on — a
 * power-up deploy names a gym, and a `Gym` document stores coordinates rather than a venue key —
 * so it would need the campus-wide value at best.
 *
 * An earlier version of this comment said all four "carry their own literal 75 — so they agree
 * on the number without any of them sharing it", and described that as the design. It was, and
 * the cost showed up the moment a pack wanted a different number: three of the four moved, and
 * a fork widening its campus fence still gets 75 here.
 */
const GEOFENCE_RADIUS_METERS = 75;

/**
 * What one spin produced. `awardedKarma` is the figure the ledger actually granted after the
 * raid multiplier and the daily `HACKSTOP` cap, not the amount that was rolled, so a player
 * who has farmed beacons all afternoon sees the smaller number rather than a promise.
 */
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
   * The active supply beacons, without the cooldown ledger.
   *
   * `lastSpunUsers` maps a volunteer id to the moment they last spun this beacon. It is
   * bookkeeping for one conditional update, and it was going out on an unauthenticated list
   * route on every document — so anybody who could reach `GET /pokeshift/hackstops` could
   * harvest the maps every few minutes and build a who-was-at-which-beacon-when timeline for
   * the whole event, joined against ids and names that are public by design. The presence
   * layer fuzzes positions to twenty metres, publishes them a tick late and audits every exact
   * read; this handed out a movement history from a JSON list, for free, with no audit row.
   *
   * Callers get their own cooldown instead, which is the only part of the map that concerns
   * them and the only part the client ever used. A caller with no identity gets none, rather
   * than an error: the beacon list is useful to a signed-out visitor and the field is simply
   * absent for them.
   */
  public static async listBeacons(viewer?: { id: string; source: string } | null): Promise<Array<Record<string, unknown>>> {
    const beacons = await HackStop.find({ isActive: true }).select('-lastSpunUsers').sort({ name: 1 }).lean();
    // A PROVED caller, not a claimed one.
    //
    // Removing the whole `lastSpunUsers` map closed the bulk disclosure and left a per-caller
    // oracle behind it, keyed on whatever identity the request carried. In `AUTH_MODE=legacy`
    // — the shipped default — that identity is a query parameter, and account ids are public:
    // `GET /pokeshift/hackstops?volunteerId=<anyone>` polled every few minutes rebuilds that
    // person's last-spin time at every beacon, and beacon locations are public, so it is a
    // position history with no session and no audit row. The same `source === 'session'`
    // condition the presence and directory reads already use.
    const viewerId = viewer && viewer.source === 'session' ? viewer.id : null;
    if (!viewerId) return beacons as Array<Record<string, unknown>>;

    // One extra read, projected to the single map entry that belongs to this caller. Asking
    // Mongo for `lastSpunUsers.<id>` rather than the whole map keeps the document that comes
    // back the size of the answer instead of the size of the event.
    const key = `lastSpunUsers.${viewerId}`;
    const mine = await HackStop.find({ isActive: true }).select(`beaconId cooldownSeconds ${key}`).lean();
    const spunAt = new Map<string, Date>();
    for (const row of mine) {
      const at = (row.lastSpunUsers as unknown as Record<string, Date> | undefined)?.[viewerId];
      if (at) spunAt.set(String(row.beaconId), new Date(at));
    }
    return beacons.map((b) => {
      const at = spunAt.get(String(b.beaconId));
      return {
        ...b,
        yourLastSpinAt: at ?? null,
        yourNextSpinAt: at ? new Date(at.getTime() + (b.cooldownSeconds ?? 300) * 1000) : null,
      };
    });
  }

  /**
   * Spin a beacon: geofence, cooldown, loot, karma.
   *
   * Neither the radius nor the cooldown is a constant in this file. Both are read off the
   * beacon document — `geofenceRadiusMeters` and `cooldownSeconds`, which the schema defaults
   * to 75 m and 300 s — so a pack can loosen one beacon in a large atrium without touching
   * any code, and the refusal messages quote the beacon's own numbers rather than these.
   *
   * The cooldown is consulted twice, for two different jobs. The read near the top is a cheap
   * refusal that gives the ordinary double-tap a countdown instead of a rolled item it will
   * never receive; it enforces nothing, because two requests can both pass a read. The
   * conditional update further down is the enforcement, and when a caller loses that claim it
   * is told the beacon is cooling down — the loot for that request has already been rolled by
   * then and is simply discarded.
   *
   * **The cooldown is claimed before anything is granted, and nothing hands it back.** The
   * inventory upsert and the karma award both run after the claim has committed, with no
   * transaction spanning them, so a failure in between costs the player the item and the
   * remainder of the cooldown. `BoothService.scan` deletes its guard row on that path; this
   * does not, and what a lost guard costs is the difference between them: a booth pays once
   * ever, so handing the row back is the only way it can ever be retried, whereas a spin comes
   * round again on its own timer. Doing it the other way — grant first, claim
   * after — would put the guard behind the loot, which is the shape that lets a double-tap
   * collect twice.
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

    // The odds come from the pack, the prices from the code.
    //
    // `loot.json` owns the weights and the karma band; `POWER_UP_CATALOG` owns each item's
    // `karmaBonus`. That split is deliberate — a pack is public, served to every browser under
    // `/dashboard/content`, and the amount an item pays is money. The join between the two is
    // the `type` string, and `crossValidate` refuses at boot any pack that names a type the
    // catalogue does not price, so `itemMeta` below cannot be undefined here.
    //
    // Both draws are still server-side and neither travels to the client, so rarity cannot be
    // asked for. What changed is only where the table lives: it used to be a literal in this
    // function that duplicated `loot.json` item for item and weight for weight, which meant a
    // fork editing the pack changed nothing and had no way to find out.
    const awardedPowerUp = rollLoot();
    const itemMeta = POWER_UP_CATALOG[awardedPowerUp];
    let awardedKarma = rollKarma() + itemMeta.karmaBonus;

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
   * The account's stacks, empties excluded.
   *
   * A stack spent down to zero is left in place rather than deleted — the unique
   * `(volunteerId, itemType)` index means the next award of that item finds and reuses the
   * row — so `quantity > 0` here is the whole reason "you have zero Anker Gauntlets" is not a
   * line in every player's bag.
   */
  public static async getVolunteerInventory(volunteerId: string): Promise<IPowerUpInventory[]> {
    return PowerUpInventory.find({ volunteerId, quantity: { $gt: 0 } });
  }

  /**
   * Spend one item from the bag.
   *
   * **Only two of the five do anything.** The Overclocked Solder Core adds 250 control points
   * to a gym and the Insomnia Cookie Shield makes one uncontestable for two hours. The Cold
   * Brew Elixir, the Rubber Duck and the Anker Gauntlet are consumed and pay their karma
   * bonus, and that is all they do: the effects `powerup.model` advertises for those three —
   * a speed boost, an auto-resolved SOS ticket, a doubled territorial multiplier — appear
   * nowhere in this codebase, and neither do the fatigue immunity and priority waitlist pass
   * it claims for the Cookie Shield alongside the gym shield that method really does apply.
   * That is an unwritten half of the game layer rather than a subtlety of this method, and
   * the catalog text is the thing that is wrong about it.
   *
   * Everything that can refuse a use runs before the decrement, and the ordering is the whole
   * safety argument: the decrement is not in a transaction with the effect, so a target that
   * turns out to be missing, out of range or a rival's *after* the item had been spent would
   * eat the item and pay its bonus for an effect that never landed.
   *
   * A `targetGymId` sent with an item that does not take one is still geofenced and still
   * refused on a rival's gym, and then ignored, because the target block is keyed on the
   * parameter rather than on the item type. Harmless in itself, but it means a client that
   * attaches the nearest gym to every use will collect 403s that a Cold Brew Elixir never
   * needed to earn.
   *
   * The karma bonus goes through the ledger like every other award, so the daily `POWERUP`
   * cap can clamp it — but unlike a spin, a booth scan or a quest, nothing in the return value
   * says what was granted. A capped player is told the item deployed and is left to notice
   * their balance did not move.
   */
  public static async usePowerUp(
    volunteerId: string,
    itemType: PowerUpType,
    targetGymId?: string,
    coordinates?: IGeoCoordinates
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

      // A gym is a place, and acting on one means standing at it.
      //
      // Spins and battles have both enforced the 75 m geofence here since the beginning;
      // this path enforced nothing at all. `POST /pokeshift/inventory/use` took a gym id and
      // no position, so a volunteer who had earned a core at the event could spend it from
      // home: +250 CP and its karma bonus for an action nobody performed, or a two-hour
      // shield dropped on any gym on campus, which makes every legitimate on-site attacker's
      // battle throw. The client picks the nearest gym and sends where it is, but a client is
      // not a check — the whole point of the geofence is that the server decides.
      if (!coordinates) {
        throw ApiError.badRequest(
          `${itemMeta.name} acts on a gym, so it needs your position. Open Campus and place your trainer.`,
          { code: ErrorCode.MISSING_REQUIRED_FIELD }
        );
      }
      const geoCheck = GeoEngine.isWithinGeofence(
        coordinates,
        { latitude: targetGym.latitude, longitude: targetGym.longitude },
        GEOFENCE_RADIUS_METERS
      );
      if (!geoCheck.allowed) {
        throw ApiError.forbidden(
          `Out of range: You are ${geoCheck.distanceMeters}m from ${targetGym.name}. Must be within ${GEOFENCE_RADIUS_METERS}m to deploy there.`
        );
      }

      // And it must not be a rival's gym.
      //
      // Both gym-targeted items *help* their target: the core adds control points, the shield
      // makes the gym uncontestable for two hours. Spending one on a stronghold another
      // faction holds entrenches it — a way to hand a rival two hours of immunity, or to burn
      // an ally's core doing it. Neutral is fair game, because taking neutral ground is the
      // thing the game is about.
      const holder = targetGym.controllingFaction;
      const actor = await Volunteer.findById(volunteerId).select('faction');
      const mine = actor?.faction ?? null;
      // A held gym is a rival's unless it is demonstrably yours.
      //
      // The first version required `mine` to be set, which let the one account that has
      // never picked a side buff every side: `faction` defaults to null and only a gym
      // battle binds it, so a fresh account could spin beacons until it held a shield and
      // then drop two hours of immunity on any stronghold on campus. Reading "no faction" as
      // "not this faction" is the only reading that matches what the rule is for.
      if (holder && holder !== Faction.NEUTRAL && holder !== mine) {
        throw ApiError.conflict(
          `${targetGym.name} is held by ${holder}. A ${itemMeta.name} strengthens the gym it is used on, so it cannot be spent on a rival's.`,
          ErrorCode.FACTION_ALLEGIANCE_LOCKED
        );
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
