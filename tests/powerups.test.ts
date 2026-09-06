/**
 * Deploying a power-up: the place-bound rules the other two economy actions have always had.
 *
 * Spins and gym battles have both enforced the 75 m geofence server-side since the beginning.
 * Deploy took a gym id and no position at all, so an item earned at the event on Saturday
 * could be spent on Sunday from a sofa — and one of the two gym items *shields* its target,
 * which turns "spend it from anywhere" into "hand any gym on campus two hours of immunity".
 * The client picking the nearest gym is a convenience; these are the checks.
 */
import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env';
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

/** Gym names carry a unique index, so two gyms in one test need two names. */
let gymSeq = 0;
async function gym(controllingFaction: Faction) {
  return Gym.create({
    name: `Siebel Cyber Bastion ${++gymSeq}`, locationName: 'Siebel Center',
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

describe('a live distress call is not readable by naming somebody', () => {
  it('refuses GET /me/sos to a claimed identity, and answers a real session', async () => {
    // The route was written with `requireAccount`, which in the shipped legacy posture is
    // satisfied by `?volunteerId=` in the query string — and account ids are public, handed
    // out by the unauthenticated leaderboard. So it returned a named person's live
    // `tableLocation` and `category`: where they are sitting and whether they called for
    // medical help, to a caller with no cookie and no audit row. Even null-versus-a-ticket
    // is an oracle for whether somebody is in trouble.
    const victim = await Volunteer.create({
      name: 'Vic', email: null, kind: AccountKind.HACKER, role: VolunteerRole.HACKER,
    });
    const { agent, csrf } = await signIn(victim.id);
    const created = await agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', csrf).send({
      hackerName: 'Vic', tableLocation: 'Table 42, second floor', description: 'help',
      urgency: 'HIGH', coordinates: SIEBEL,
    });
    expect(created.status).toBe(201);

    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).get(`/api/v1/me/sos?volunteerId=${victim.id}`);
      expect(claimed.status).toBe(401);
      expect(JSON.stringify(claimed.body)).not.toContain('Table 42');
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }

    // The person it belongs to still gets it.
    const mine = await agent.get('/api/v1/me/sos');
    expect(mine.status).toBe(200);
    expect(mine.body.data.tableLocation).toBe('Table 42, second floor');
  });
});

describe('an account that never picked a side cannot buff every side', () => {
  it('refuses a rival gym to a factionless actor', async () => {
    // The first version of the check required the actor's faction to be *set*: `mine &&
    // holder !== mine`. `faction` defaults to null and only a gym battle binds it, so an
    // account that had never fought could spin beacons until it held a shield and then drop
    // two hours of immunity on any stronghold on campus — the one actor the rule was least
    // able to reason about was the one it let through.
    const drifter = await Volunteer.create({
      name: 'Drifter', email: `dr-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    expect(drifter.faction ?? null).toBeNull();
    const theirs = await gym(Faction.TEAM_TENSOR);
    await give(drifter._id, PowerUpType.INSOMNIA_COOKIE_SHIELD);

    await expect(
      HackStopService.usePowerUp(String(drifter._id), PowerUpType.INSOMNIA_COOKIE_SHIELD, String(theirs._id), SIEBEL)
    ).rejects.toThrow(/held by TEAM_TENSOR/i);
    expect((await Gym.findById(theirs._id))!.isShielded).toBeFalsy();

    // A neutral gym is still fair game — taking neutral ground is the point of the game.
    const open = await gym(Faction.NEUTRAL);
    const res = await HackStopService.usePowerUp(String(drifter._id), PowerUpType.INSOMNIA_COOKIE_SHIELD, String(open._id), SIEBEL);
    expect(res.remainingQuantity).toBe(0);
    expect((await Gym.findById(open._id))!.isShielded).toBe(true);
  });
});
