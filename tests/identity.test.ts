/**
 * Identity (plan M1): cookie sessions, the three adapters, CSRF, revocation, and the
 * `required` auth mode.
 *
 * `env` is a mutable object, so tests flip `AUTH_MODE` per block and restore it; the
 * account cache is cleared wherever a revocation must be visible immediately.
 */
import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { AuthService } from '../src/services/auth.service';
import { __clearAccountCache } from '../src/middleware/identity';
import { ConsoleMailer, __setMailerForTests } from '../src/auth/mailer';
import { mintSessionToken, verifySessionToken, cookieNames, csrfNonceFor } from '../src/common/utils/sessionToken';

const names = cookieNames(false);

function csrfFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = setCookie.find((c) => c.startsWith(`${names.csrf}=`));
  if (!raw) throw new Error('no csrf cookie');
  return decodeURIComponent(raw.split(';')[0].split('=')[1]);
}

async function makeVolunteer(overrides: Partial<{ name: string; email: string; role: VolunteerRole }> = {}) {
  return Volunteer.create({
    name: overrides.name ?? 'Casey Kim',
    email: overrides.email ?? `casey-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    role: overrides.role ?? VolunteerRole.VOLUNTEER,
  });
}

async function makeHacker() {
  return Volunteer.create({ name: 'Hacker Hal', kind: AccountKind.HACKER, role: VolunteerRole.HACKER, email: null });
}

/** Signs in through dev-login and returns an agent that keeps the cookies, plus the CSRF nonce. */
async function signIn(accountId: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/dev-login').send({ accountId });
  expect(res.status).toBe(200);
  return { agent, csrf: csrfFrom(res) };
}

describe('Session tokens', () => {
  it('mints and verifies; tampering and expiry are rejected', () => {
    const token = mintSessionToken({ sub: 'a'.repeat(24), sv: 3, kind: 'VOLUNTEER' }, 1_000);
    expect(verifySessionToken(token, 2_000)).toMatchObject({ valid: true, payload: { sub: 'a'.repeat(24), sv: 3 } });
    expect(verifySessionToken(token.slice(0, -2) + 'zz', 2_000)).toEqual({ valid: false, reason: 'INVALID_SIGNATURE' });
    expect(verifySessionToken(token, 1_000 + 48 * 3600_000 + 1)).toEqual({ valid: false, reason: 'EXPIRED' });
    expect(verifySessionToken('nope', 2_000)).toEqual({ valid: false, reason: 'MALFORMED' });
  });

  it('never exposes the session token in a response body', async () => {
    const vol = await makeVolunteer();
    const res = await request(app).post('/api/v1/auth/dev-login').send({ accountId: vol.id });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('v1.');
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const session = setCookie.find((c) => c.startsWith(`${names.session}=`)) as string;
    expect(session).toMatch(/HttpOnly/);
    expect(setCookie.find((c) => c.startsWith(`${names.csrf}=`))).not.toMatch(/HttpOnly/);
  });
});

describe('Adonix token verification (C5)', () => {
  const { verifyHs256Jwt } = require('../src/auth/adonix') as typeof import('../src/auth/adonix');
  const crypto = require('crypto') as typeof import('crypto');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload: unknown, secret = 's3cret') => {
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64(payload);
    const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
  };
  it('accepts a signed token with a future numeric exp and rejects missing, string or past exp', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(verifyHs256Jwt(sign({ id: 'u1', exp: future }), 's3cret')).toMatchObject({ id: 'u1' });
    expect(() => verifyHs256Jwt(sign({ id: 'u1' }), 's3cret')).toThrow(/no expiry/);
    expect(() => verifyHs256Jwt(sign({ id: 'u1', exp: 'never' }), 's3cret')).toThrow(/no expiry/);
    expect(() => verifyHs256Jwt(sign({ id: 'u1', exp: future - 1200 }), 's3cret')).toThrow(/expired/);
    expect(() => verifyHs256Jwt(sign({ id: 'u1', exp: future }, 'wrong'), 's3cret')).toThrow(/signature/);
  });
});

describe('Anonymous stream slots (C7)', () => {
  const { StreamLimits } = require('../src/common/streamLimits') as typeof import('../src/common/streamLimits');
  it('anonymous connections cannot exhaust the table, even from a trusted IP', () => {
    const table = new StreamLimits({ totalSlots: 50, anonSlots: 10, anonPerIp: 5, trustedCidrs: ['10.0.0.0/8'] });
    let refused: string | null = null;
    for (let i = 0; i < 60; i++) {
      const r = table.tryAcquire({ transport: 'sse', ip: `10.0.0.${(i % 3) + 1}` });
      if (!r.ok) {
        refused = r.reason;
        break;
      }
    }
    expect(refused).toMatch(/ANON|PER_IP/);
    expect(table.stats().anonymous).toBeLessThanOrEqual(10);
    const authed = table.tryAcquire({ transport: 'sse', accountId: 'acct1', ip: '10.0.0.1' });
    expect(authed.ok).toBe(true);
  });
});

describe('Providers and dev login', () => {
  it('lists providers with the current mode', async () => {
    const res = await request(app).get('/api/v1/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe(env.AUTH_MODE);
    const ids = res.body.data.providers.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['claim', 'magic', 'adonix', 'dev']));
  });

  it('GET /me returns the account for a cookie session and 401 without one', async () => {
    const vol = await makeVolunteer({ name: 'Me Person' });
    const { agent } = await signIn(vol.id);
    const me = await agent.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.data.account).toMatchObject({ id: vol.id, displayName: 'Me Person', kind: 'VOLUNTEER' });
    expect(me.body.data.source).toBe('session');
    const anon = await request(app).get('/api/v1/me');
    expect(anon.status).toBe(401);
  });
});

describe('Claim codes', () => {
  it('issues a 10-char code, claims it once, refuses reuse and garbage', async () => {
    const vol = await makeVolunteer();
    const issued = await request(app)
      .post('/api/v1/auth/claim-codes')
      .set('X-Organizer-Secret', env.ORGANIZER_SECRET)
      .send({ accountId: vol.id, ttlHours: 1 });
    expect(issued.status).toBe(201);
    const code: string = issued.body.data.code;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);

    // Tolerant of dashes and lowercase.
    const pretty = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
    const first = await request(app).post('/api/v1/auth/claim').send({ code: pretty });
    expect(first.status).toBe(200);
    expect(first.body.data.account.id).toBe(vol.id);

    const second = await request(app).post('/api/v1/auth/claim').send({ code });
    expect(second.status).toBe(401);
    expect(second.body.error).toBe('CREDENTIAL_INVALID');

    const junk = await request(app).post('/api/v1/auth/claim').send({ code: 'ZZZZZZZZZZ' });
    expect(junk.status).toBe(401);

    const linked = await Volunteer.findById(vol.id);
    expect(linked!.identities.some((i) => i.provider === 'claim')).toBe(true);
  });

  it('bulk issuance returns CSV rows for every account of a kind', async () => {
    await makeVolunteer({ email: 'a1@illinois.edu' });
    await makeVolunteer({ email: 'a2@illinois.edu' });
    await makeHacker();
    const res = await request(app)
      .post('/api/v1/auth/claim-codes/bulk')
      .set('X-Organizer-Secret', env.ORGANIZER_SECRET)
      .set('Accept', 'text/csv')
      .send({ kind: 'VOLUNTEER' });
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('accountId,name,email,code,expiresAt');
    expect(lines.length).toBe(3);
  });

  it('raises the brute-force alarm after 50 failures in an hour', async () => {
    AuthService.__resetClaimFailures();
    const { eventHub } = await import('../src/common/sse/eventHub');
    const spy = jest.spyOn(eventHub, 'broadcast');
    for (let i = 0; i < 50; i++) {
      await request(app).post('/api/v1/auth/claim').send({ code: 'ZZZZZZZZZZ' });
    }
    expect(spy.mock.calls.some((c) => (c[0] as { type: string }).type === 'CLAIM_BRUTE_FORCE')).toBe(true);
    spy.mockRestore();
    AuthService.__resetClaimFailures();
  });
});

describe('Magic links', () => {
  let mailer: ConsoleMailer;
  beforeEach(() => {
    mailer = new ConsoleMailer();
    __setMailerForTests(mailer);
  });
  afterEach(() => __setMailerForTests(null));

  it('always answers 202, mails a fragment link to known addresses, and redeems once', async () => {
    const vol = await makeVolunteer({ email: 'magic@illinois.edu' });
    const unknown = await request(app).post('/api/v1/auth/magic-link').send({ email: 'nobody@illinois.edu' });
    expect(unknown.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);

    const known = await request(app).post('/api/v1/auth/magic-link').send({ email: 'MAGIC@illinois.edu' });
    expect(known.status).toBe(202);
    expect(mailer.sent).toHaveLength(1);
    const link = mailer.sent[0].text.match(/#magic=([A-Za-z0-9_-]+)/);
    expect(link).not.toBeNull();
    expect(mailer.sent[0].text).not.toMatch(/\?magic=/);

    const token = link![1];
    const redeem = await request(app).post('/api/v1/auth/magic').send({ token });
    expect(redeem.status).toBe(200);
    expect(redeem.body.data.account.id).toBe(vol.id);
    const again = await request(app).post('/api/v1/auth/magic').send({ token });
    expect(again.status).toBe(401);
  });
});

describe('Revocation', () => {
  it('a lead can revoke a volunteer; the old cookie stops working immediately (cache evicted)', async () => {
    const vol = await makeVolunteer();
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: volAgent } = await signIn(vol.id);
    const { agent: leadAgent, csrf } = await signIn(lead.id);
    expect((await volAgent.get('/api/v1/me')).status).toBe(200);

    const revoke = await leadAgent.post(`/api/v1/auth/revoke/${vol.id}`).set('X-CSRF-Token', csrf).send({});
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.sessionVersion).toBe(1);
    // No __clearAccountCache() here on purpose: revoke must evict the entry itself.
    expect((await volAgent.get('/api/v1/me')).status).toBe(401);
  });

  it('revocation respects the role hierarchy: lead cannot revoke lead/organizer, organizer can, anyone can revoke themselves', async () => {
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const lead2 = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const org = await makeVolunteer({ role: VolunteerRole.ORGANIZER });
    const { agent: leadAgent, csrf: leadCsrf } = await signIn(lead.id);
    const { agent: orgAgent, csrf: orgCsrf } = await signIn(org.id);
    expect((await leadAgent.post(`/api/v1/auth/revoke/${org.id}`).set('X-CSRF-Token', leadCsrf).send({})).status).toBe(403);
    expect((await leadAgent.post(`/api/v1/auth/revoke/${lead2.id}`).set('X-CSRF-Token', leadCsrf).send({})).status).toBe(403);
    expect((await orgAgent.post(`/api/v1/auth/revoke/${lead2.id}`).set('X-CSRF-Token', orgCsrf).send({})).status).toBe(200);
    // Self-revocation is a logout-everywhere and is always allowed.
    expect((await leadAgent.post(`/api/v1/auth/revoke/${lead.id}`).set('X-CSRF-Token', leadCsrf).send({})).status).toBe(200);
    expect((await leadAgent.get('/api/v1/me')).status).toBe(401);
  });

  it('role grants respect the hierarchy: an organizer cannot mint an ADMIN or touch an admin; an admin can', async () => {
    const org = await makeVolunteer({ role: VolunteerRole.ORGANIZER });
    const admin = await makeVolunteer({ role: VolunteerRole.ADMIN });
    const vol = await makeVolunteer();
    const { agent: o, csrf: oCsrf } = await signIn(org.id);
    const { agent: a, csrf: aCsrf } = await signIn(admin.id);
    expect((await o.patch(`/api/v1/auth/accounts/${vol.id}/role`).set('X-CSRF-Token', oCsrf).send({ role: 'ADMIN' })).status).toBe(403);
    expect((await o.patch(`/api/v1/auth/accounts/${vol.id}/role`).set('X-CSRF-Token', oCsrf).send({ role: 'ORGANIZER' })).status).toBe(403);
    expect((await o.patch(`/api/v1/auth/accounts/${admin.id}/role`).set('X-CSRF-Token', oCsrf).send({ role: 'VOLUNTEER' })).status).toBe(403);
    expect((await o.patch(`/api/v1/auth/accounts/${vol.id}/role`).set('X-CSRF-Token', oCsrf).send({ role: 'SHIFT_LEAD' })).status).toBe(200);
    expect((await a.patch(`/api/v1/auth/accounts/${vol.id}/role`).set('X-CSRF-Token', aCsrf).send({ role: 'ADMIN' })).status).toBe(200);
    expect((await Volunteer.findById(vol.id))!.role).toBe(VolunteerRole.ADMIN);
  });

  it('anonymous legacy callers cannot mint claim codes without the organiser secret', async () => {
    const vol = await makeVolunteer();
    const none = await request(app).post('/api/v1/auth/claim-codes').send({ accountId: vol.id });
    expect(none.status).toBe(401);
    const bulk = await request(app).post('/api/v1/auth/claim-codes/bulk').send({ kind: 'VOLUNTEER' });
    expect(bulk.status).toBe(401);
  });

  it('bulk CSV neutralises spreadsheet formula prefixes and never sends the code unquoted', async () => {
    await makeVolunteer({ name: '=HYPERLINK("http://evil")' });
    await makeVolunteer({ name: '  -2+3+cmd|calc' });
    const res = await request(app)
      .post('/api/v1/auth/claim-codes/bulk')
      .set('X-Organizer-Secret', env.ORGANIZER_SECRET)
      .set('Accept', 'text/csv')
      .send({ kind: 'VOLUNTEER' });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    // The model trims names, so the leading spaces are gone by the time the CSV is built; the
    // neutraliser still has to catch the `-` prefix that survives.
    expect(res.text).toContain(`"'-2+3+cmd|calc"`);
    expect(res.text).not.toMatch(/^"=|,"=/m);
  });

  it('a plain volunteer cannot revoke', async () => {
    const vol = await makeVolunteer();
    const other = await makeVolunteer();
    const { agent, csrf } = await signIn(vol.id);
    const res = await agent.post(`/api/v1/auth/revoke/${other.id}`).set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(403);
  });
});

describe('AUTH_MODE=required', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
  });
  afterAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
  });

  it('anonymous reads are 401 except the allow-list', async () => {
    expect((await request(app).get('/api/v1/shifts')).status).toBe(401);
    expect((await request(app).get('/api/v1/volunteers')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/providers')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('a session can read; a mutation needs the CSRF header; a body id naming someone else is 403', async () => {
    const vol = await makeVolunteer();
    const other = await makeVolunteer();
    const shift = await Shift.create({
      title: 'Desk',
      description: 'x',
      category: ShiftCategory.INFO_DESK,
      location: 'Siebel Center Atrium',
      startTime: new Date('2027-02-27T10:00:00Z'),
      endTime: new Date('2027-02-27T12:00:00Z'),
      capacity: 2,
    });
    const { agent, csrf } = await signIn(vol.id);
    expect((await agent.get('/api/v1/shifts')).status).toBe(200);

    const noCsrf = await agent.post('/api/v1/registrations').send({ shiftId: shift.id });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error).toBe('CSRF_INVALID');

    const mismatch = await agent.post('/api/v1/registrations').set('X-CSRF-Token', csrf).send({ shiftId: shift.id, volunteerId: other.id });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error).toBe('IDENTITY_MISMATCH');

    const ok = await agent.post('/api/v1/registrations').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(ok.status).toBe(201);
    expect(String(ok.body.data.volunteerId)).toBe(vol.id);
    expect(csrf).toBe(csrfNonceFor(vol.id, 0));
  });

  it('a hacker can read the map but is refused staff-only actions', async () => {
    const hacker = await makeHacker();
    const shift = await Shift.create({
      title: 'Desk',
      description: 'x',
      category: ShiftCategory.INFO_DESK,
      location: 'Siebel Center Atrium',
      startTime: new Date('2027-02-27T10:00:00Z'),
      endTime: new Date('2027-02-27T12:00:00Z'),
      capacity: 2,
    });
    const { agent, csrf } = await signIn(hacker.id);
    expect((await agent.get('/api/v1/pokeshift/gyms')).status).toBe(200);
    const reg = await agent.post('/api/v1/registrations').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(reg.status).toBe(403);
    const token = await agent.post('/api/v1/attendance/token').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(token.status).toBe(403);
  });

  it('claim-code bootstrap works anonymously with the organiser secret and only with it', async () => {
    const vol = await makeVolunteer();
    const ok = await request(app)
      .post('/api/v1/auth/claim-codes')
      .set('X-Organizer-Secret', env.ORGANIZER_SECRET)
      .send({ accountId: vol.id });
    expect(ok.status).toBe(201);
    const wrong = await request(app).post('/api/v1/auth/claim-codes').set('X-Organizer-Secret', 'nope').send({ accountId: vol.id });
    expect(wrong.status).toBe(403);
    const none = await request(app).post('/api/v1/auth/claim-codes').send({ accountId: vol.id });
    expect(none.status).toBe(401);
  });

  it('swap proposals and acceptances act as the session, never as a body id (C1)', async () => {
    const a = await makeVolunteer();
    const b = await makeVolunteer();
    const shift = await Shift.create({
      title: 'Desk',
      description: 'x',
      category: ShiftCategory.INFO_DESK,
      location: 'Siebel Center Atrium',
      startTime: new Date('2027-02-27T10:00:00Z'),
      endTime: new Date('2027-02-27T12:00:00Z'),
      capacity: 2,
    });
    const { agent, csrf } = await signIn(a.id);
    // Naming B as the proposer trips the identity check.
    const spoof = await agent
      .post('/api/v1/swaps')
      .set('X-CSRF-Token', csrf)
      .send({ proposerVolunteerId: b.id, proposerShiftId: shift.id, targetShiftId: shift.id });
    expect(spoof.status).toBe(403);
    expect(spoof.body.error).toBe('IDENTITY_MISMATCH');
    // Accepting "as B" is ignored: the acceptor is A, who is not the target → the service refuses.
    const accept = await agent.post(`/api/v1/swaps/${shift.id}/accept`).set('X-CSRF-Token', csrf).send({ targetVolunteerId: b.id });
    expect([403, 404, 409]).toContain(accept.status);
    expect(accept.status).not.toBe(200);
  });

  it('logout revokes: the same cookie no longer works (C3)', async () => {
    const vol = await makeVolunteer();
    const { agent, csrf } = await signIn(vol.id);
    const rawCookie = ((await agent.get('/api/v1/me')).request as unknown as { header: Record<string, string> }).header?.cookie;
    expect((await agent.get('/api/v1/me')).status).toBe(200);
    const out = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).send({});
    expect(out.status).toBe(200);
    // A copy of the pre-logout cookie must be dead too, not just cleared in this jar.
    const replay = await request(app).get('/api/v1/me').set('Cookie', rawCookie ?? '');
    expect(replay.status).toBe(401);
  });

  it('the model refuses an incoherent kind/role pair', async () => {
    await expect(Volunteer.create({ name: 'Bad', kind: AccountKind.HACKER, role: VolunteerRole.SHIFT_LEAD })).rejects.toThrow(/Incoherent account/);
  });
});

describe('AUTH_MODE=required — review round 2 pins', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
  });
  afterAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
  });

  it('HEAD is gated exactly like GET; only OPTIONS is exempt', async () => {
    expect((await request(app).head('/api/v1/shifts')).status).toBe(401);
    expect((await request(app).head('/api/v1/volunteers')).status).toBe(401);
    expect((await request(app).options('/api/v1/shifts')).status).toBeLessThan(400);
  });

  it('hackers cannot read the SOS ticket list, ops telemetry, or resolve swap cycles; volunteers cannot resolve cycles either', async () => {
    const hacker = await makeHacker();
    const vol = await makeVolunteer();
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: h, csrf: hCsrf } = await signIn(hacker.id);
    const { agent: v, csrf: vCsrf } = await signIn(vol.id);
    const { agent: l, csrf: lCsrf } = await signIn(lead.id);
    expect((await h.get('/api/v1/sos/tickets')).status).toBe(403);
    expect((await h.get('/api/v1/stats/operations')).status).toBe(403);
    expect((await h.get('/api/v1/stats/leaderboard')).status).toBe(200);
    expect((await h.post('/api/v1/swaps/cycles/resolve').set('X-CSRF-Token', hCsrf).send({})).status).toBe(403);
    expect((await v.get('/api/v1/sos/tickets')).status).toBe(200);
    expect((await v.get('/api/v1/stats/operations')).status).toBe(200);
    expect((await v.post('/api/v1/swaps/cycles/resolve').set('X-CSRF-Token', vCsrf).send({})).status).toBe(403);
    expect((await l.post('/api/v1/swaps/cycles/resolve').set('X-CSRF-Token', lCsrf).send({})).status).toBe(200);
  });

  it('POST /volunteers echoes the projected account, never identities or sessionVersion', async () => {
    const org = await makeVolunteer({ role: VolunteerRole.ORGANIZER });
    const { agent, csrf } = await signIn(org.id);
    const res = await agent.post('/api/v1/volunteers').set('X-CSRF-Token', csrf).send({ name: 'New Nia', email: `nia-${Date.now()}@illinois.edu` });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('New Nia');
    expect(res.body.data.identities).toBeUndefined();
    expect(res.body.data.sessionVersion).toBeUndefined();
  });

  it('volunteer directory hides email/phone/identities/sessionVersion from non-leads and identities/sessionVersion from everyone', async () => {
    const target = await makeVolunteer({ name: 'Private Pat' });
    await Volunteer.updateOne({ _id: target._id }, { $set: { phone: '+1 217 555 0100' } });
    const vol = await makeVolunteer();
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: v } = await signIn(vol.id);
    const { agent: l } = await signIn(lead.id);
    const asVol = await v.get(`/api/v1/volunteers/${target.id}`);
    expect(asVol.status).toBe(200);
    expect(asVol.body.data.name).toBe('Private Pat');
    expect(asVol.body.data.email).toBeUndefined();
    expect(asVol.body.data.phone).toBeUndefined();
    expect(asVol.body.data.identities).toBeUndefined();
    expect(asVol.body.data.sessionVersion).toBeUndefined();
    const asLead = await l.get(`/api/v1/volunteers/${target.id}`);
    expect(asLead.body.data.email).toBe(target.email);
    expect(asLead.body.data.phone).toBe('+1 217 555 0100');
    expect(asLead.body.data.identities).toBeUndefined();
    expect(asLead.body.data.sessionVersion).toBeUndefined();
    const list = await v.get('/api/v1/volunteers');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('@illinois.edu');
  });

  it('SSE channel authorisation holds through the real cookie wiring (attachIdentity + hub), not only the test shim', async () => {
    const hacker = await makeHacker();
    const vol = await makeVolunteer();
    const { agent: h } = await signIn(hacker.id);
    const { agent: v } = await signIn(vol.id);
    // The whole point of this test is what `required` mode refuses, so say so out loud. Several
    // suites flip this global, and a silent restore in the wrong order would turn every
    // assertion below into a test of legacy mode wearing this test's name.
    expect(env.AUTH_MODE).toBe('required');

    // A refusal is a normal JSON response; an ACCEPTANCE is an endless event-stream, and
    // supertest tries to parse it as a body. When one of these assertions failed it therefore
    // surfaced as `Parse Error: Expected HTTP/` from the parser rather than as "expected 403,
    // received 200", which named the wrong thing entirely. Destroying the socket instead makes
    // the failure say what actually went wrong.
    const asStream = (t: request.Test) =>
      t.buffer(false).parse((res, cb) => {
        (res as unknown as { destroy(): void }).destroy();
        cb(null, '');
      });

    expect((await asStream(request(app).get('/api/v1/stats/events?v=2&channels=sos'))).status).toBe(403);
    expect((await asStream(h.get('/api/v1/stats/events?v=2&channels=presence:exact'))).status).toBe(403);
    expect((await asStream(v.get('/api/v1/stats/events?v=2&channels=presence:exact'))).status).toBe(403);
  });

  it('a signed-in Adonix exchange without explicit link intent is 409 ACCOUNT_LINK_CONFIRM (account-tying guard)', async () => {
    const vol = await makeVolunteer();
    const { agent, csrf } = await signIn(vol.id);
    const res = await agent.post('/api/v1/auth/adonix').set('X-CSRF-Token', csrf).send({ token: 'header.payload.signature-long-enough' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ACCOUNT_LINK_CONFIRM');
    expect((await Volunteer.findById(vol.id))!.identities).toHaveLength(0);
  });

  it('a session-authenticated Adonix link attempt without the CSRF nonce is refused before any exchange', async () => {
    const vol = await makeVolunteer();
    const { agent } = await signIn(vol.id);
    const res = await agent.post('/api/v1/auth/adonix').send({ token: 'x.y.z' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CSRF_INVALID');
  });
});

describe('committed-default secrets outside production', () => {
  /**
   * Every secret with a committed default must be replaced by a random per-boot value
   * outside production, and `ORGANIZER_SECRET` most of all.
   *
   * It is not only a signing key. `X-Organizer-Secret` is accepted by `/auth/claim-codes`
   * regardless of AUTH_MODE — it is the bootstrap path that exists before any session does
   * — and a claim code mints a session for whichever account it names. While the default
   * stayed live, one unauthenticated request carrying a string published in this repository
   * produced a claim code for an ADMIN account, and a second turned that code into an ADMIN
   * session. That was true on every deployment that was not `NODE_ENV=production`.
   *
   * The two weaker secrets were already being randomised here; this one was missed, which
   * is exactly why it is asserted rather than left to the reader of `env.ts`.
   */
  const COMMITTED_DEFAULTS: Array<[string, string]> = [
    ['SESSION_SECRET', 'nexus_session_change_me'],
    ['QR_HMAC_SECRET', 'hackillinois_waveshift_secret_key_2027'],
    ['ORGANIZER_SECRET', 'waveshift_change_me_in_production'],
  ];

  it.each(COMMITTED_DEFAULTS)('%s is not the committed default at runtime', (name, committed) => {
    expect((env as unknown as Record<string, string>)[name]).not.toBe(committed);
  });

  it('the organizer secret cannot be guessed from the repository', async () => {
    const vol = await makeVolunteer();
    const res = await request(app)
      .post('/api/v1/auth/claim-codes')
      .set('X-Organizer-Secret', 'waveshift_change_me_in_production')
      .send({ accountId: vol.id });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBeUndefined();
  });
});

describe('a claimed identity is not a proved one (legacy mode)', () => {
  /**
   * `legacy` mode is the open-demo contract: a mutation may name a `volunteerId` and it is
   * believed. That is fine for game actions and must never be enough for the three things
   * below, because account ids are public — `GET /volunteers` and the leaderboard both hand
   * them out to anonymous callers, so "name an organiser's id" is not an attack that needs
   * anything the attacker does not already have.
   *
   * `requireSession` exists for precisely this and these routes were not using it.
   */
  it('cannot mint a claim code by naming an organiser', async () => {
    const organizer = await makeVolunteer({ role: VolunteerRole.ORGANIZER });
    const victim = await makeVolunteer();
    const res = await request(app)
      .post('/api/v1/auth/claim-codes')
      .send({ volunteerId: organizer.id, accountId: victim.id });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBeUndefined();
  });

  it('cannot grant a role or revoke a session by naming an organiser', async () => {
    const organizer = await makeVolunteer({ role: VolunteerRole.ORGANIZER });
    const victim = await makeVolunteer();

    const grant = await request(app)
      .patch(`/api/v1/auth/accounts/${victim.id}/role`)
      .send({ volunteerId: organizer.id, role: 'SHIFT_LEAD' });
    expect(grant.status).toBe(401);
    expect((await Volunteer.findById(victim.id))!.role).toBe(VolunteerRole.VOLUNTEER);

    const revoke = await request(app)
      .post(`/api/v1/auth/revoke/${organizer.id}`)
      .send({ volunteerId: organizer.id });
    expect(revoke.status).toBe(401);
  });

  it('cannot read the roster PII projection by naming a lead', async () => {
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    await makeVolunteer();

    const claimed = await request(app).get(`/api/v1/volunteers?volunteerId=${lead.id}`);
    expect(claimed.status).toBe(200);
    for (const row of claimed.body.data) {
      expect(row.email).toBeUndefined();
      expect(row.phone).toBeUndefined();
    }

    // The same request from a real lead session still sees contact details — the gate is on
    // how the identity was established, not on the role.
    const { agent } = await signIn(lead.id);
    const proved = await agent.get('/api/v1/volunteers');
    expect(proved.status).toBe(200);
    expect(proved.body.data.some((r: { email?: string }) => typeof r.email === 'string')).toBe(true);
  });

  it('cannot read another account\'s email through /me', async () => {
    const victim = await makeVolunteer();
    const res = await request(app).get(`/api/v1/me?volunteerId=${victim.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('legacy');
    expect(res.body.data.account.email).toBeNull();
  });
});
