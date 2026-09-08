/**
 * Faction allegiance: choosing a side, and the rule that you only choose once.
 *
 * The picker in the dashboard wrote nothing. `currentVolunteerFaction` lived in a module
 * variable in `public/app.js`, defaulted to the first playable faction, and no endpoint
 * persisted it — so the campus HUD said TEAM KERNEL while `GET /me/card` said NEUTRAL for the
 * same account in the same second, and a reload silently moved you to another side.
 *
 * `PATCH /me/faction` closes that, and the interesting part is not the endpoint: it is that
 * adding it could easily have produced a *second* implementation of "when is allegiance
 * settled", alongside the one `GymService` has always enforced. This file pins the rule from
 * both callers, because a rule with two implementations is a rule with two behaviours as soon as
 * somebody edits one of them.
 */
import request from 'supertest';
import { app } from '../src/app';
import { Volunteer, AccountKind, VolunteerRole } from '../src/models/volunteer.model';
import { bindFaction, playableFactions, assertPlayable } from '../src/services/faction.service';
import { ApiError } from '../src/common/errors/apiError';
import { signIn } from './helpers/session';

/** A fresh volunteer with no faction, which is the state every case here starts from. */
async function makeAccount() {
  return Volunteer.create({
    name: `F ${Math.random().toString(36).slice(2, 7)}`,
    email: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: AccountKind.VOLUNTEER,
    role: VolunteerRole.VOLUNTEER,
  });
}

describe('the pack decides what the sides are', () => {
  it('offers every faction the pack declares, and never NEUTRAL', () => {
    const options = playableFactions();
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain('NEUTRAL');
  });

  it('refuses NEUTRAL by name, because it is the unclaimed state of a territory', () => {
    // Not a pedantic distinction. In the battle path, declaring NEUTRAL used to skip the lock
    // entirely and let a bound account attack its own gyms.
    expect(() => assertPlayable('NEUTRAL')).toThrow(ApiError);
    expect(() => assertPlayable('NEUTRAL')).toThrow(/not a side/);
  });

  it('refuses a faction this pack does not declare, and says what it does', () => {
    expect(() => assertPlayable('TEAM_NOT_REAL')).toThrow(/This event's factions are/);
  });
});

describe('allegiance is chosen once', () => {
  it('binds an unbound account and reports that this call is what settled it', async () => {
    const volunteer = await makeAccount();
    const chosen = playableFactions()[0];

    const result = await bindFaction(volunteer.id, chosen);

    expect(result).toEqual({ faction: chosen, bound: true });
    const stored = await Volunteer.findById(volunteer.id).select('faction');
    expect(stored?.faction).toBe(chosen);
  });

  it('is idempotent on the same faction, so a retry is not an error', async () => {
    const volunteer = await makeAccount();
    const chosen = playableFactions()[0];

    await bindFaction(volunteer.id, chosen);
    const again = await bindFaction(volunteer.id, chosen);

    // `bound: false` rather than a 409: a client that is unsure whether its first request landed
    // must be able to ask again without being told it has done something wrong.
    expect(again).toEqual({ faction: chosen, bound: false });
  });

  it('refuses a different faction once bound', async () => {
    const volunteer = await makeAccount();
    const [first, second] = playableFactions();

    await bindFaction(volunteer.id, first);

    await expect(bindFaction(volunteer.id, second)).rejects.toThrow(/locked to/);
    const stored = await Volunteer.findById(volunteer.id).select('faction');
    expect(stored?.faction).toBe(first);
  });

  it('settles exactly one winner when two first-ever choices race', async () => {
    const volunteer = await makeAccount();
    const [first, second] = playableFactions();

    // The reason the write is a conditional update and not a read-then-save. Both of these read
    // `faction == null`; if both could write, the loser has been silently moved to a side it did
    // not pick, and in the battle path it would then fight for that side.
    const results = await Promise.allSettled([
      bindFaction(volunteer.id, first),
      bindFaction(volunteer.id, second),
    ]);

    const settled = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(settled).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const stored = await Volunteer.findById(volunteer.id).select('faction');
    expect([first, second]).toContain(stored?.faction);
    expect((settled[0] as PromiseFulfilledResult<{ faction: string }>).value.faction).toBe(stored?.faction);
  });
});

describe('PATCH /me/faction', () => {
  it('persists the choice, so the HUD and GET /me/card stop disagreeing', async () => {
    const volunteer = await makeAccount();
    const { agent, csrf } = await signIn(volunteer.id);
    const chosen = playableFactions()[0];

    const card = await agent.get('/api/v1/me/card');
    // The state this fixes: the picker showed a side, the card said NEUTRAL.
    expect(card.body.data.faction).toBe('NEUTRAL');

    const patched = await agent
      .patch('/api/v1/me/faction')
      .set('X-CSRF-Token', csrf)
      .send({ faction: chosen });

    expect(patched.status).toBe(200);
    expect(patched.body.data).toEqual({ faction: chosen, bound: true });

    const after = await agent.get('/api/v1/me/card');
    expect(after.body.data.faction).toBe(chosen);
  });

  it('answers 409 on a second, different choice', async () => {
    const volunteer = await makeAccount();
    const { agent, csrf } = await signIn(volunteer.id);
    const [first, second] = playableFactions();

    await agent.patch('/api/v1/me/faction').set('X-CSRF-Token', csrf).send({ faction: first });
    const conflict = await agent
      .patch('/api/v1/me/faction')
      .set('X-CSRF-Token', csrf)
      .send({ faction: second });

    expect(conflict.status).toBe(409);
    // The envelope is `{ success, error, message, statusCode }` — `error` IS the code, not an
    // object wrapping one. Asserting on the code and not just the status is what distinguishes
    // this 409 from the transaction-contention 409 the error handler also produces.
    expect(conflict.body.error).toBe('FACTION_ALLEGIANCE_LOCKED');
  });

  it('refuses a claimed identity, so nobody can bind a stranger to a side for the whole event', async () => {
    const victim = await makeAccount();
    const chosen = playableFactions()[0];

    // No cookie, just an asserted id — which `requireAccount` alone accepts in `legacy` mode.
    // The choice cannot be undone, so this would be a permanent, unattributable change to
    // somebody else's account.
    const response = await request(app)
      .patch('/api/v1/me/faction')
      .send({ volunteerId: victim.id, faction: chosen });

    expect(response.status).toBe(401);
    const stored = await Volunteer.findById(victim.id).select('faction');
    expect(stored?.faction ?? null).toBeNull();
  });

  it('rejects a malformed id before it reaches a lookup', async () => {
    const volunteer = await makeAccount();
    const { agent, csrf } = await signIn(volunteer.id);

    const response = await agent
      .patch('/api/v1/me/faction')
      .set('X-CSRF-Token', csrf)
      .send({ faction: 'not a faction id' });

    expect(response.status).toBe(400);
  });
});
