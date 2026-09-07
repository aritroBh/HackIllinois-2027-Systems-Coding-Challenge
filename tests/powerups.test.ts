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
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { uniqueKey } from './helpers/uniqueKey';
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

describe('a rota is a position with a timetable attached', () => {
  it('refuses GET /me/shifts to a claimed identity', async () => {
    // Same shape as /me/sos, and the earlier reasoning that only /sos carried a position was
    // too narrow: this returns the venue, the building and the window of every shift a named
    // person holds. In legacy mode an "account" is a query parameter and account ids are
    // public, so it was a schedule and a location history for a caller with no cookie.
    const victim = await Volunteer.create({
      name: 'Rota Rae', email: `rr-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).get(`/api/v1/me/shifts?volunteerId=${victim.id}`);
      expect(claimed.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }

    const { agent } = await signIn(victim.id);
    const mine = await agent.get('/api/v1/me/shifts');
    expect(mine.status).toBe(200);
  });
});

describe('taking somebody off the map is not something you can claim', () => {
  it('refuses PATCH /me/presence to a claimed identity', async () => {
    // On `requireAccount` alone this was a one-request way to remove any named person from
    // the presence store and drop their SSE session — and because a claimed identity is not a
    // session, the CSRF check was skipped too.
    const victim = await Volunteer.create({
      name: 'Optin Ola', email: `oo-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER, presenceOptIn: true,
    });
    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app)
        .patch(`/api/v1/me/presence?volunteerId=${victim.id}`)
        .send({ optIn: false });
      expect(claimed.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
    expect((await Volunteer.findById(victim._id))!.presenceOptIn).toBe(true);
  });
});

describe('the next shift is one you can still turn up to', () => {
  it('skips a shift already worked and a place in a queue', async () => {
    // "Has not finished" is not "is still yours to work". A shift checked out of at 11:30
    // keeps an endTime of 14:00, so it stayed at the head of the list and the Me tab offered
    // it as next — and the token button refuses a COMPLETED registration, so the volunteer
    // could not mint a token for the shift they were actually about to work.
    const vol = await Volunteer.create({
      name: 'Next Nel', email: `nn-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const done = await Shift.create({
      title: 'Worked already', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000),
      capacity: 4, baseKarma: 10,
    });
    const real = await Shift.create({
      title: 'Actually next', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 1800_000), endTime: new Date(Date.now() + 7200_000),
      capacity: 4, baseKarma: 10,
    });
    await Registration.create({ shiftId: done._id, volunteerId: vol._id, status: RegistrationStatus.COMPLETED, idempotencyKey: uniqueKey('done') });
    await Registration.create({ shiftId: real._id, volunteerId: vol._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('real') });

    const { agent } = await signIn(vol.id);
    const res = await agent.get('/api/v1/me/shifts');
    expect(res.status).toBe(200);
    expect(res.body.data.next.title).toBe('Actually next');
    expect(res.body.data.next.status).toBe(RegistrationStatus.CONFIRMED);
    // And neither /me/card nor /me is left in a shared browser's HTTP cache. The card
    // carried an explicit day-long directive; /me carried none at all, which with an ETag
    // and no directives is heuristically cacheable — the same defect, one route further on.
    const card = await agent.get('/api/v1/me/card');
    expect(card.headers['cache-control']).toBe('no-store');
    const profile = await agent.get('/api/v1/me');
    expect(profile.headers['cache-control']).toBe('no-store');
  });
});

describe('a claimed identity is not a session, on every self-read', () => {
  /**
   * The rule the whole codebase draws: an *action* may believe a claimed `?volunteerId=`,
   * because `AUTH_MODE=legacy` is a documented open demo; a *disclosure* may not, because in
   * legacy the id comes from the query string and `GET /volunteers` hands account ids to
   * anonymous callers. Two rounds fixed the two `/me` routes that carry a location and left
   * the four beside them, which carry the rest of the account's game state.
   */
  it.each([
    ['/api/v1/me/inventory'],
    ['/api/v1/me/quests'],
    ['/api/v1/me/stickers'],
    ['/api/v1/me/card'],
  ])('refuses GET %s to a claimed identity', async (path) => {
    const victim = await Volunteer.create({
      name: 'Read Rhea', email: `rr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).get(`${path}?volunteerId=${victim.id}`);
      expect(claimed.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
    // The same account, having actually signed in, is answered.
    const { agent } = await signIn(victim.id);
    expect((await agent.get(path)).status).toBe(200);
  });

  it('refuses another account\'s inventory by path parameter, in both modes', async () => {
    // The sixth instance of this class, and the one the `/me/*` round could not reach: this
    // route takes the account id as a **path** parameter, so tightening `GET /me/inventory`
    // left it open. Two holes — the ownership check was switched off entirely in `legacy`, and
    // in `required` it was written `env.AUTH_MODE === 'required' && req.account && …`, so an
    // anonymous caller short-circuited the whole condition in the one mode meant to refuse it.
    const victim = await Volunteer.create({
      name: 'Bag Bea', email: `bb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const path = `/api/v1/pokeshift/inventory/${victim.id}`;

    // Anonymous, in the strict mode. This was 200 before the route was gated.
    const originalMode = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
    try {
      expect((await request(app).get(path)).status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = originalMode;
    }

    // And a claimed identity in the open-demo mode.
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      expect((await request(app).get(`${path}?volunteerId=${victim.id}`)).status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = originalMode;
    }

    // A signed-in stranger is refused; the owner is answered.
    const stranger = await Volunteer.create({
      name: 'Nosy Ned', email: `nn2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    expect((await (await signIn(stranger.id)).agent.get(path)).status).toBe(403);
    expect((await (await signIn(victim.id)).agent.get(path)).status).toBe(200);
  });

  it('refuses DELETE /presence to a claimed identity', async () => {
    // The PATCH beside this was fixed for exactly this attack; the DELETE does the same
    // thing more directly — drop them from the store, drop their SSE session — and was left.
    const victim = await Volunteer.create({
      name: 'Onmap Omar', email: `oo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER, presenceOptIn: true,
    });
    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).delete(`/api/v1/presence?volunteerId=${victim.id}`);
      expect(claimed.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
  });

  it('does not hand a claimed volunteer the populated shift roster', async () => {
    // Anonymous already got redacted counts. Naming any public volunteer id upgraded that to
    // every rostered person's name, certifications, karma, prestige and avatar hash.
    const vol = await Volunteer.create({
      name: 'Roster Rosa', email: `rr2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const shift = await Shift.create({
      title: 'Rostered shift', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000),
      capacity: 4, baseKarma: 10,
    });
    await Registration.create({
      shiftId: shift._id, volunteerId: vol._id,
      status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('roster'),
    });

    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).get(`/api/v1/shifts/${shift.id}?volunteerId=${vol.id}`);
      expect(claimed.status).toBe(200);
      expect(JSON.stringify(claimed.body)).not.toContain('Roster Rosa');
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
  });
});

describe('health is liveness for anyone and telemetry for a lead', () => {
  it('gives an anonymous caller no operational detail', async () => {
    // On a public URL the full body is a live read on how busy the event is, how much load
    // exhausts the slot ceilings, and whatever a failing job left in `jobs[].lastError`.
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HEALTHY');
    expect(res.body.streams).toBeUndefined();
    expect(res.body.presence).toBeUndefined();
    expect(res.body.jobs).toBeUndefined();
    expect(res.body.plugins).toBeUndefined();
  });

  it('gives a signed-in lead the whole picture', async () => {
    const lead = await Volunteer.create({
      name: 'Lead Lena', email: `ll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.SHIFT_LEAD,
    });
    const { agent } = await signIn(lead.id);
    const res = await agent.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.streams).toBeDefined();
    expect(res.body.jobs).toBeDefined();
  });
});
