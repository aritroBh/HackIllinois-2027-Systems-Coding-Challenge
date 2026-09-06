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
    expect(JSON.stringify(res.body)).not.toContain('v1.');
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const session = setCookie.find((c) => c.startsWith(`${names.session}=`)) as string;
    expect(session).toMatch(/HttpOnly/);
    expect(setCookie.find((c) => c.startsWith(`${names.csrf}=`))).not.toMatch(/HttpOnly/);
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
    const issued = await request(app).post('/api/v1/auth/claim-codes').send({ accountId: vol.id, ttlHours: 1 });
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
    const res = await request(app).post('/api/v1/auth/claim-codes/bulk').set('Accept', 'text/csv').send({ kind: 'VOLUNTEER' });
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
  it('a lead can revoke; the old cookie stops working once the cache is cleared', async () => {
    const vol = await makeVolunteer();
    const lead = await makeVolunteer({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: volAgent } = await signIn(vol.id);
    const { agent: leadAgent, csrf } = await signIn(lead.id);
    expect((await volAgent.get('/api/v1/me')).status).toBe(200);

    const revoke = await leadAgent.post(`/api/v1/auth/revoke/${vol.id}`).set('X-CSRF-Token', csrf).send({});
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.sessionVersion).toBe(1);
    __clearAccountCache();
    expect((await volAgent.get('/api/v1/me')).status).toBe(401);
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

  it('the model refuses an incoherent kind/role pair', async () => {
    await expect(Volunteer.create({ name: 'Bad', kind: AccountKind.HACKER, role: VolunteerRole.SHIFT_LEAD })).rejects.toThrow(/Incoherent account/);
  });
});
