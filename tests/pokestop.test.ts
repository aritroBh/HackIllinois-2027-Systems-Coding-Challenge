import { Gym, Faction } from '../src/models/gym.model';
import { HackStop } from '../src/models/hackstop.model';
import { Volunteer } from '../src/models/volunteer.model';
import { PowerUpInventory, PowerUpType } from '../src/models/powerup.model';
import { GymService } from '../src/services/gym.service';
import { HackStopService } from '../src/services/hackstop.service';
import { VENUE_COORDINATES } from '../src/common/utils/geo';

describe('PokéShift Campus Turf Wars & HackStop Engine', () => {
  let volA: any;
  let volB: any;

  beforeEach(async () => {
    volA = await Volunteer.create({
      name: 'Ash Ketchum',
      email: 'ash@illinois.edu',
      karmaPoints: 100,
    });
    volB = await Volunteer.create({
      name: 'Gary Oak',
      email: 'gary@illinois.edu',
      karmaPoints: 100,
    });
  });

  describe('Gym Battles & Fortification', () => {
    it('allows an ally to fortify an existing gym up to maxControlPoints', async () => {
      const gym = await Gym.create({
        name: 'Siebel Central Atrium Arena',
        locationName: 'Siebel Center',
        latitude: VENUE_COORDINATES.SIEBEL_ATRIUM.latitude,
        longitude: VENUE_COORDINATES.SIEBEL_ATRIUM.longitude,
        controllingFaction: Faction.TEAM_KERNEL,
        controlPoints: 500,
        maxControlPoints: 1000,
      });

      const res = await GymService.battleOrContribute(
        gym._id.toString(),
        volA._id.toString(),
        Faction.TEAM_KERNEL,
        200
      );

      expect(res.action).toBe('CONTRIBUTED');
      expect(res.newControlPoints).toBe(700);
      expect(res.controllingFaction).toBe(Faction.TEAM_KERNEL);

      const updated = await Gym.findById(gym._id);
      expect(updated?.controlPoints).toBe(700);
    });

    it('damages opposing gym and successfully overthrows/captures it when CP is depleted', async () => {
      const gym = await Gym.create({
        name: 'ECEB Microelectronics Bastion',
        locationName: 'ECEB',
        latitude: VENUE_COORDINATES.ECEB_LOBBY.latitude,
        longitude: VENUE_COORDINATES.ECEB_LOBBY.longitude,
        controllingFaction: Faction.TEAM_KERNEL,
        controlPoints: 80,
        maxControlPoints: 1500,
        leaderName: 'Rival Champion',
      });

      // Gary attacks for TEAM_TENSOR with 150 power
      const res = await GymService.battleOrContribute(
        gym._id.toString(),
        volB._id.toString(),
        Faction.TEAM_TENSOR,
        150
      );

      expect(res.action).toBe('CAPTURED');
      expect(res.controllingFaction).toBe(Faction.TEAM_TENSOR);
      expect(res.leaderName).toBe(volB.name);

      const dbGym = await Gym.findById(gym._id);
      expect(dbGym?.controllingFaction).toBe(Faction.TEAM_TENSOR);
      expect(dbGym?.leaderVolunteerId?.toString()).toBe(volB._id.toString());
      expect(dbGym?.leaderName).toBe(volB.name);
    });
  });

  describe('HackStop Supply Beacons & Geofenced Spins', () => {
    let hackStop: any;

    beforeEach(async () => {
      hackStop = await HackStop.create({
        beaconId: 'BEACON_SIEBEL_TEST',
        name: 'Siebel Cyber Fountain',
        locationName: 'Siebel Center 1404',
        latitude: VENUE_COORDINATES.SIEBEL_ATRIUM.latitude,
        longitude: VENUE_COORDINATES.SIEBEL_ATRIUM.longitude,
        cooldownSeconds: 300,
        geofenceRadiusMeters: 75,
      });
    });

    it('rejects beacon spin if volunteer is outside 75m geofence perimeter', async () => {
      // ECEB coordinates (~285m away from Siebel Center)
      const farCoords = VENUE_COORDINATES.ECEB_LOBBY;

      await expect(
        HackStopService.spinBeacon(hackStop.beaconId, volA._id.toString(), farCoords)
      ).rejects.toThrow(/Out of range/i);
    });

    it('successfully spins beacon within 75m, awards Karma and stores power-up in inventory', async () => {
      // Valid coordinates right at Siebel Atrium
      const validCoords = { latitude: 40.113815, longitude: -88.224935 };

      const res = await HackStopService.spinBeacon(
        hackStop.beaconId,
        volA._id.toString(),
        validCoords
      );

      expect(res.distanceMeters).toBeLessThan(75);
      expect(res.awardedKarma).toBeGreaterThanOrEqual(25);
      expect(Object.values(PowerUpType)).toContain(res.awardedPowerUp);

      const inventory = await PowerUpInventory.findOne({
        volunteerId: volA._id,
        itemType: res.awardedPowerUp,
      });
      expect(inventory).not.toBeNull();
      expect(inventory?.quantity).toBe(1);
    });

    it('enforces 5-minute cooldown on subsequent spin attempts', async () => {
      const validCoords = { latitude: 40.113815, longitude: -88.224935 };

      // 1st Spin: Success
      await HackStopService.spinBeacon(hackStop.beaconId, volA._id.toString(), validCoords);

      // 2nd Spin immediately: Rejection
      await expect(
        HackStopService.spinBeacon(hackStop.beaconId, volA._id.toString(), validCoords)
      ).rejects.toThrow(/cooling down/i);
    });

    it('atomically decrements inventory when volunteer activates a power-up', async () => {
      // Seed an inventory item
      await PowerUpInventory.create({
        volunteerId: volA._id,
        itemType: PowerUpType.COLD_BREW_ELIXIR,
        name: 'Cold Brew Elixir of Haste',
        quantity: 2,
      });

      const useResult = await HackStopService.usePowerUp(volA._id.toString(), PowerUpType.COLD_BREW_ELIXIR);
      expect(useResult.remainingQuantity).toBe(1);

      const updated = await PowerUpInventory.findOne({ volunteerId: volA._id, itemType: PowerUpType.COLD_BREW_ELIXIR });
      expect(updated?.quantity).toBe(1);
    });
  });
});
