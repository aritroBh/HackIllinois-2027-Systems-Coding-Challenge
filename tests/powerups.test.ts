/**
 * Deploying a power-up: the place-bound rules the other two economy actions have always had.
 *
 * Spins and gym battles have both enforced the 75 m geofence server-side since the beginning.
 * Deploy took a gym id and no position at all, so an item earned at the event on Saturday
 * could be spent on Sunday from a sofa — and one of the two gym items *shields* its target,
 * which turns "spend it from anywhere" into "hand any gym on campus two hours of immunity".
 * The client picking the nearest gym is a convenience; these are the checks.
 */
import { Volunteer, AccountKind, VolunteerRole } from '../src/models/volunteer.model';
import { Gym, Faction } from '../src/models/gym.model';
import { PowerUpInventory, PowerUpType } from '../src/models/powerup.model';
import { HackStop } from '../src/models/hackstop.model';
import { HackStopService } from '../src/services/hackstop.service';
import { signIn } from './helpers/session';

const SIEBEL = { latitude: 40.11380, longitude: -88.22470 };
/** About 1.4 km away — comfortably outside any 75 m fence, and still on the pack's campus. */
const FAR = { latitude: 40.12640, longitude: -88.22470 };

async function player(faction: Faction = Faction.TEAM_KERNEL) {
  return Volunteer.create({
    name: `P ${Math.random().toString(36).slice(2, 7)}`,
    email: `pu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER, faction,
  });
}

async function gym(controllingFaction: Faction) {
  return Gym.create({
    name: 'Siebel Cyber Bastion', locationName: 'Siebel Center',
    latitude: SIEBEL.latitude, longitude: SIEBEL.longitude,
    controllingFaction, controlPoints: 100, maxControlPoints: 1000, version: 0,
  });
}

async function give(volunteerId: unknown, itemType: PowerUpType, quantity = 1) {
  return PowerUpInventory.create({ volunteerId, itemType, quantity, name: itemType, rarity: 'EPIC', obtainedFrom: 'TEST' });
}

describe('a gym item is spent where the gym is', () => {
  it('refuses a deploy with no position, and one from across campus', async () => {
    const me = await player();
    const g = await gym(Faction.NEUTRAL);
    await give(me._id, PowerUpType.OVERCLOCK_SOLDER_CORE, 2);

    await expect(
      HackStopService.usePowerUp(String(me._id), PowerUpType.OVERCLOCK_SOLDER_CORE, String(g._id))
    ).rejects.toThrow(/needs your position/i);

    await expect(
      HackStopService.usePowerUp(String(me._id), PowerUpType.OVERCLOCK_SOLDER_CORE, String(g._id), FAR)
    ).rejects.toThrow(/Out of range/i);

    // Neither refusal consumed the item: the target is validated before the decrement.
    expect((await PowerUpInventory.findOne({ volunteerId: me._id }))!.quantity).toBe(2);
    expect((await Gym.findById(g._id))!.controlPoints).toBe(100);

    // Standing at it works, and is the only thing that does.
    const res = await HackStopService.usePowerUp(String(me._id), PowerUpType.OVERCLOCK_SOLDER_CORE, String(g._id), SIEBEL);
    expect(res.remainingQuantity).toBe(1);
    expect((await Gym.findById(g._id))!.controlPoints).toBe(350);
  });

  it('refuses to strengthen a rival faction\'s gym', async () => {
    // Both gym items help their target: the core adds control points, the shield makes the
    // gym uncontestable for two hours. Spending one on a rival's stronghold entrenches it —
    // a way to hand the other side two hours of immunity, from inside your own inventory.
    const me = await player(Faction.TEAM_KERNEL);
    const theirs = await gym(Faction.TEAM_TENSOR);
    await give(me._id, PowerUpType.INSOMNIA_COOKIE_SHIELD);

    await expect(
      HackStopService.usePowerUp(String(me._id), PowerUpType.INSOMNIA_COOKIE_SHIELD, String(theirs._id), SIEBEL)
    ).rejects.toThrow(/held by TEAM_TENSOR/i);

    const after = await Gym.findById(theirs._id);
    expect(after!.isShielded).toBeFalsy();
    expect((await PowerUpInventory.findOne({ volunteerId: me._id }))!.quantity).toBe(1);
  });
});

describe('a personal item is not place-bound', () => {
  it('is consumed with no gym and no coordinates at all', async () => {
    // A Cold Brew Elixir is drunk, not aimed. Requiring a position for it locked out anybody
    // in lite mode, where there is no renderer and therefore never a player position.
    const me = await player();
    await give(me._id, PowerUpType.COLD_BREW_ELIXIR);
    const before = (await Volunteer.findById(me._id))!.karmaPoints;

    const res = await HackStopService.usePowerUp(String(me._id), PowerUpType.COLD_BREW_ELIXIR);
    expect(res.remainingQuantity).toBe(0);
    expect((await Volunteer.findById(me._id))!.karmaPoints).toBeGreaterThan(before);
  });
});

describe('a beacon cooldown belongs to the person it is about', () => {
  it('reports it to a proved session and to nobody who merely names an id', async () => {
    // Round five removed the whole `lastSpunUsers` map and left a per-caller oracle behind
    // it, keyed on whatever identity the request carried. In legacy mode an identity is a
    // query parameter and account ids are public, so polling with a victim's id rebuilt their
    // last-spin time at every beacon — and beacon locations are public, so that is a position
    // history with no session and no audit row.
    const victim = await player();
    const spunAt = new Date(Date.now() - 60_000);
    await HackStop.create({
      beaconId: 'bx-oracle', name: 'Oracle Beacon', locationName: 'Siebel Center Atrium',
      latitude: SIEBEL.latitude, longitude: SIEBEL.longitude, cooldownSeconds: 300,
      lastSpunUsers: new Map([[String(victim._id), spunAt]]),
    });

    // A claimed identity gets nothing.
    const claimed = await HackStopService.listBeacons({ id: String(victim._id), source: 'legacy' });
    const claimedBeacon = claimed.find((b) => b.beaconId === 'bx-oracle')!;
    expect(claimedBeacon.yourLastSpinAt).toBeUndefined();
    expect(claimedBeacon.lastSpunUsers).toBeUndefined();

    // The victim's own session does.
    const proved = await HackStopService.listBeacons({ id: String(victim._id), source: 'session' });
    const provedBeacon = proved.find((b) => b.beaconId === 'bx-oracle')!;
    expect(new Date(provedBeacon.yourLastSpinAt as string).getTime()).toBe(spunAt.getTime());

    // And over HTTP a signed-in stranger learns nothing about the victim.
    const stranger = await player();
    const { agent } = await signIn(stranger.id);
    const res = await agent.get(`/api/v1/pokeshift/hackstops?volunteerId=${victim._id}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(spunAt.toISOString());
  });
});

describe('a hacker can read their own SOS ticket', () => {
  it('answers GET /me/sos with the live one, and null once it is settled', async () => {
    // Without this the hacker view had nothing to reconcile a remembered ticket against: one
    // resolved while the tab was shut came back stuck at DISPATCHED, a state with no Cancel
    // and no Clear, and no further SSE would ever arrive for it.
    const hacker = await Volunteer.create({
      name: 'Sam', email: null, kind: AccountKind.HACKER, role: VolunteerRole.HACKER,
    });
    const { agent, csrf } = await signIn(hacker.id);

    const empty = await agent.get('/api/v1/me/sos');
    expect(empty.status).toBe(200);
    expect(empty.body.data).toBeNull();

    const created = await agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', csrf).send({
      hackerName: 'Sam', tableLocation: 'Table 9', description: 'Need a hand', urgency: 'HIGH',
      coordinates: SIEBEL,
    });
    expect(created.status).toBe(201);

    const live = await agent.get('/api/v1/me/sos');
    expect(live.body.data.id).toBe(String(created.body.data._id));
    expect(live.body.data.status).toBe('OPEN');
    expect(live.headers['cache-control']).toBe('no-store');
  });
});
