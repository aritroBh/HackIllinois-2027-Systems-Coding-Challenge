/**
 * Legacy compatibility (plan M1): the pre-M1 request shapes keep working in `legacy` mode
 * exactly as before, and the same flows work in `required` mode once a session exists.
 *
 * The existing suites all run in `legacy` (the default outside production). This file is
 * the one place that drives the core reserve → token → cancel flow under `required` with a
 * dev-login shim, so production mode is exercised in CI rather than assumed.
 */
import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { Volunteer, VolunteerRole } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { cookieNames } from '../src/common/utils/sessionToken';

const names = cookieNames(false);

async function fixtures() {
  const vol = await Volunteer.create({ name: 'Legacy Lou', email: `lou-${Date.now()}@illinois.edu`, role: VolunteerRole.VOLUNTEER });
  const shift = await Shift.create({
    title: 'Info Desk',
    description: 'Answer questions',
    category: ShiftCategory.INFO_DESK,
    location: 'Siebel Center Atrium',
    startTime: new Date('2027-02-27T10:00:00Z'),
    endTime: new Date('2027-02-27T12:00:00Z'),
    capacity: 2,
  });
  return { vol, shift };
}

describe('legacy mode keeps the original contract', () => {
  it('body volunteerId reserves, mints a token and cancels with no cookies', async () => {
    expect(env.AUTH_MODE).toBe('legacy');
    const { vol, shift } = await fixtures();
    const reserve = await request(app).post('/api/v1/registrations').send({ shiftId: shift.id, volunteerId: vol.id });
    expect(reserve.status).toBe(201);
    const token = await request(app).post('/api/v1/attendance/token').send({ shiftId: shift.id, volunteerId: vol.id });
    expect(token.status).toBe(200);
    const cancel = await request(app).delete(`/api/v1/registrations/${reserve.body.data._id}?volunteerId=${vol.id}`);
    expect(cancel.status).toBe(200);
  });
});

describe('required mode runs the same flow behind a session', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
  });
  afterAll(() => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
  });

  it('anonymous → 401; session + CSRF → reserve, token, cancel all succeed without a body id', async () => {
    const { vol, shift } = await fixtures();
    const anon = await request(app).post('/api/v1/registrations').send({ shiftId: shift.id, volunteerId: vol.id });
    expect(anon.status).toBe(401);

    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/dev-login').send({ accountId: vol.id });
    expect(login.status).toBe(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const csrf = decodeURIComponent((setCookie.find((c) => c.startsWith(`${names.csrf}=`)) as string).split(';')[0].split('=')[1]);

    const reserve = await agent.post('/api/v1/registrations').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(reserve.status).toBe(201);
    expect(String(reserve.body.data.volunteerId)).toBe(vol.id);

    const token = await agent.post('/api/v1/attendance/token').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(token.status).toBe(200);

    const cancel = await agent.delete(`/api/v1/registrations/${reserve.body.data._id}`).set('X-CSRF-Token', csrf);
    expect(cancel.status).toBe(200);

    // The legacy query-string owner proof is ignored in favour of the session.
    const other = await Volunteer.create({ name: 'Other', email: `other-${Date.now()}@illinois.edu` });
    const reserve2 = await agent.post('/api/v1/registrations').set('X-CSRF-Token', csrf).send({ shiftId: shift.id });
    expect(reserve2.status).toBe(201);
    const spoofed = await agent.delete(`/api/v1/registrations/${reserve2.body.data._id}?volunteerId=${other.id}`).set('X-CSRF-Token', csrf);
    expect(spoofed.status).toBe(403);
    expect(spoofed.body.error).toBe('IDENTITY_MISMATCH');
  });
});
