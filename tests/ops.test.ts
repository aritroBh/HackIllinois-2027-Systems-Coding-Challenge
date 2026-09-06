/**
 * Ops surfaces (plan M5): the SOS lifecycle, announcements, the me endpoints and the
 * lead's roster. The lifecycle tests are the interesting ones — the transition table is
 * what stops a ticket being dragged sideways into a state nobody can act on.
 */
import request from 'supertest';
import { uniqueKey } from './helpers/uniqueKey';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { SOSTicket, SOSTicketStatus, canTransition } from '../src/models/sosTicket.model';
import { Announcement, AnnouncementAudience } from '../src/models/announcement.model';
import { PresenceAudit } from '../src/models/presenceAudit.model';
import { SOSService } from '../src/services/sos.service';
import { presenceStore } from '../src/presence/store';
import { runDue } from '../src/scheduler';
import { cookieNames } from '../src/common/utils/sessionToken';
import { eventHub } from '../src/common/sse/eventHub';
import { BountyLedger } from '../src/models/bountyLedger.model';
import { pack } from '../src/content/loader';

function csrfFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = setCookie.find((c) => c.startsWith(`${cookieNames().csrf}=`))!;
  return decodeURIComponent(raw.split(';')[0].split('=')[1]);
}

async function makeAccount(over: Partial<{ name: string; role: VolunteerRole; kind: AccountKind }> = {}) {
  return Volunteer.create({
    name: over.name ?? `A ${Math.random().toString(36).slice(2, 7)}`,
    email: over.kind === AccountKind.HACKER ? null : `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: over.kind ?? AccountKind.VOLUNTEER,
    role: over.role ?? (over.kind === AccountKind.HACKER ? VolunteerRole.HACKER : VolunteerRole.VOLUNTEER),
  });
}

async function signIn(accountId: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/dev-login').send({ accountId });
  expect(res.status).toBe(200);
  return { agent, csrf: csrfFrom(res) };
}

async function openShift(title = 'Ops shift') {
  return Shift.create({
    title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
    startTime: new Date(Date.now() - 1800_000), endTime: new Date(Date.now() + 3600_000), capacity: 4, baseKarma: 20,
  });
}

async function makeTicket(createdById?: string) {
  return SOSTicket.create({
    hackerName: 'Sam', tableLocation: 'Table 9', description: 'Need a hand', urgency: 'HIGH',
    coordinates: { latitude: 40.1099, longitude: -88.2272 },
    createdById: createdById ?? null,
  });
}

describe('SOS transition table', () => {
  it('permits the moves the floor actually makes and refuses the rest', () => {
    expect(canTransition(SOSTicketStatus.OPEN, SOSTicketStatus.DISPATCHED)).toBe(true);
    expect(canTransition(SOSTicketStatus.DISPATCHED, SOSTicketStatus.ACKNOWLEDGED)).toBe(true);
    expect(canTransition(SOSTicketStatus.ACKNOWLEDGED, SOSTicketStatus.ON_SCENE)).toBe(true);
    expect(canTransition(SOSTicketStatus.ON_SCENE, SOSTicketStatus.RESOLVED)).toBe(true);
    // A responder who is already standing there may resolve without pressing acknowledge.
    expect(canTransition(SOSTicketStatus.DISPATCHED, SOSTicketStatus.RESOLVED)).toBe(true);
    // Reassignment sends it back to the queue.
    expect(canTransition(SOSTicketStatus.ACKNOWLEDGED, SOSTicketStatus.OPEN)).toBe(true);
    // Terminal is terminal.
    expect(canTransition(SOSTicketStatus.RESOLVED, SOSTicketStatus.OPEN)).toBe(false);
    expect(canTransition(SOSTicketStatus.CANCELLED, SOSTicketStatus.DISPATCHED)).toBe(false);
    // No skipping straight past dispatch.
    expect(canTransition(SOSTicketStatus.OPEN, SOSTicketStatus.ACKNOWLEDGED)).toBe(false);
  });
});

describe('SOS lifecycle', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });

  it('the assigned responder acknowledges and arrives; a stranger cannot', async () => {
    const responder = await makeAccount();
    const stranger = await makeAccount();
    const ticket = await makeTicket();
    await SOSTicket.updateOne({ _id: ticket._id }, { $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: responder._id, dispatchedAt: new Date() } });

    const { agent: other, csrf: otherCsrf } = await signIn(stranger.id);
    const refused = await other.post(`/api/v1/sos/tickets/${ticket.id}/acknowledge`).set('X-CSRF-Token', otherCsrf).send({});
    expect(refused.status).toBe(403);

    const { agent, csrf } = await signIn(responder.id);
    const ack = await agent.post(`/api/v1/sos/tickets/${ticket.id}/acknowledge`).set('X-CSRF-Token', csrf).send({});
    expect(ack.status).toBe(200);
    expect(ack.body.data.status).toBe(SOSTicketStatus.ACKNOWLEDGED);
    expect(ack.body.data.acknowledgedAt).toBeTruthy();

    const scene = await agent.post(`/api/v1/sos/tickets/${ticket.id}/on-scene`).set('X-CSRF-Token', csrf).send({});
    expect(scene.status).toBe(200);
    expect(scene.body.data.status).toBe(SOSTicketStatus.ON_SCENE);
    // The ticket carries its own timeline.
    const statuses = (scene.body.data.history as Array<{ status: string }>).map((h) => h.status);
    expect(statuses).toEqual([SOSTicketStatus.ACKNOWLEDGED, SOSTicketStatus.ON_SCENE]);
  });

  it('an illegal move is a conflict, not a silent overwrite', async () => {
    const responder = await makeAccount();
    const ticket = await makeTicket();
    const { agent, csrf } = await signIn(responder.id);
    // OPEN cannot jump to ON_SCENE.
    const res = await agent.post(`/api/v1/sos/tickets/${ticket.id}/on-scene`).set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(409);
    expect((await SOSTicket.findById(ticket.id))!.status).toBe(SOSTicketStatus.OPEN);
  });

  it('the creator may cancel only while it is OPEN; a lead may cancel after dispatch', async () => {
    const hacker = await makeAccount({ kind: AccountKind.HACKER });
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const responder = await makeAccount();

    const own = await makeTicket(hacker.id);
    const { agent: h, csrf: hCsrf } = await signIn(hacker.id);
    const cancelled = await h.post(`/api/v1/sos/tickets/${own.id}/cancel`).set('X-CSRF-Token', hCsrf).send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe(SOSTicketStatus.CANCELLED);

    const second = await makeTicket(hacker.id);
    await SOSTicket.updateOne({ _id: second._id }, { $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: responder._id, dispatchedAt: new Date() } });
    const tooLate = await h.post(`/api/v1/sos/tickets/${second.id}/cancel`).set('X-CSRF-Token', hCsrf).send({});
    expect(tooLate.status).toBe(403);

    const { agent: l, csrf: lCsrf } = await signIn(lead.id);
    const byLead = await l.post(`/api/v1/sos/tickets/${second.id}/cancel`).set('X-CSRF-Token', lCsrf).send({});
    expect(byLead.status).toBe(200);
  });

  it('only a lead can reassign, and reassigning clears the responder and the timestamps', async () => {
    const responder = await makeAccount();
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const ticket = await makeTicket();
    await SOSTicket.updateOne({ _id: ticket._id }, { $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: responder._id, dispatchedAt: new Date() } });

    const { agent: r, csrf: rCsrf } = await signIn(responder.id);
    expect((await r.post(`/api/v1/sos/tickets/${ticket.id}/reassign`).set('X-CSRF-Token', rCsrf).send({})).status).toBe(403);

    const { agent: l, csrf: lCsrf } = await signIn(lead.id);
    const back = await l.post(`/api/v1/sos/tickets/${ticket.id}/reassign`).set('X-CSRF-Token', lCsrf).send({ note: 'wrong side of campus' });
    expect(back.status).toBe(200);
    expect(back.body.data.status).toBe(SOSTicketStatus.OPEN);
    expect(back.body.data.assignedVolunteerId).toBeNull();
    expect(back.body.data.dispatchedAt).toBeNull();
  });

  it('a ticket nobody acknowledges is escalated once, with no location on the public channel', async () => {
    const responder = await makeAccount();
    const ticket = await makeTicket();
    await SOSTicket.updateOne({ _id: ticket._id }, {
      $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: responder._id, dispatchedAt: new Date(Date.now() - 4 * 60_000) },
    });

    const { eventHub } = await import('../src/common/sse/eventHub');
    const sent: Array<{ channel: string; type: string; data: Record<string, unknown> }> = [];
    const spy = jest.spyOn(eventHub, 'broadcastChannel').mockImplementation((channel, msg) => {
      sent.push({ channel, type: msg.type, data: (msg.data ?? {}) as Record<string, unknown> });
    });

    await SOSService.escalateStale();
    const publicFrame = sent.find((s) => s.channel === 'announce');
    expect(publicFrame).toBeTruthy();
    expect(publicFrame!.type).toBe('SOS_ESCALATED');
    // `announce` is readable by anyone, so it carries no coordinates, table text or names.
    const keys = Object.keys(publicFrame!.data);
    expect(keys).not.toContain('coordinates');
    expect(keys).not.toContain('hackerName');
    expect(keys).not.toContain('description');
    expect(sent.some((s) => s.channel === 'sos' && s.type === 'SOS_ESCALATED_FULL')).toBe(true);

    // Once, not on every sweep.
    sent.length = 0;
    await SOSService.escalateStale();
    expect(sent).toHaveLength(0);
    spy.mockRestore();
  });

  it('the scheduler runs the escalation sweep', async () => {
    const responder = await makeAccount();
    const ticket = await makeTicket();
    await SOSTicket.updateOne({ _id: ticket._id }, {
      $set: { status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: responder._id, dispatchedAt: new Date(Date.now() - 5 * 60_000) },
    });
    await runDue();
    expect((await SOSTicket.findById(ticket.id))!.escalatedAt).toBeTruthy();
  });
});

describe('the SOS journey, over HTTP, with two different people', () => {
  it('walks all five states and pays the responder, not the raiser', async () => {
    // The whole journey as two humans actually perform it, through the routes rather than the
    // service. Every earlier SOS test drives one side of this; this is the one that would have
    // caught a guard that refused the legitimate path as readily as the illegitimate one.
    const hacker = await makeAccount({ name: 'Journey Jo', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const responder = await makeAccount({ name: 'Journey Ravi' });
    const raiser = await signIn(hacker.id);
    const helper = await signIn(responder.id);

    // Dispatch only considers people who are on shift, so put the responder on one. Without
    // this the dispatch step refuses and the journey stops at its first move — which is the
    // right behaviour and the wrong test.
    const shift = await Shift.create({
      title: 'Journey desk', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000),
      capacity: 4, baseKarma: 10,
    });
    await Registration.create({
      shiftId: shift._id, volunteerId: responder._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('journey'),
    });

    const created = await raiser.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', raiser.csrf).send({
      hackerName: 'Journey Jo', tableLocation: 'Siebel Center Atrium',
      description: 'raised by one, closed by another', urgency: 'HIGH', karmaBounty: 200,
      coordinates: { latitude: 40.11380, longitude: -88.22470 },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe(SOSTicketStatus.OPEN);
    // Somebody was charged, so the reward stands.
    expect(created.body.data.karmaBounty).toBe(200);
    const id = created.body.data._id;

    // The raiser cannot collect on their own call, even while it is OPEN and unclaimed.
    const selfServe = await raiser.agent.post(`/api/v1/sos/tickets/${id}/resolve`).set('X-CSRF-Token', raiser.csrf).send({});
    expect(selfServe.status).toBe(403);

    for (const [step, expected] of [
      ['dispatch', SOSTicketStatus.DISPATCHED],
      ['acknowledge', SOSTicketStatus.ACKNOWLEDGED],
      ['on-scene', SOSTicketStatus.ON_SCENE],
      ['resolve', SOSTicketStatus.RESOLVED],
    ] as Array<[string, SOSTicketStatus]>) {
      const res = await helper.agent.post(`/api/v1/sos/tickets/${id}/${step}`).set('X-CSRF-Token', helper.csrf).send({});
      // The step name is in the assertion so a future failure says which move was refused.
      expect(`${step}:${res.status}`).toBe(`${step}:200`);
      const after = await SOSTicket.findById(id);
      expect(after!.status).toBe(expected);
    }

    // The responder is paid the bounty; the raiser is not.
    expect((await Volunteer.findById(responder.id))!.karmaPoints).toBe(200);
    expect((await Volunteer.findById(hacker.id))!.karmaPoints).toBe(0);
    // And a second resolve is a clean conflict rather than a second payment.
    const again = await helper.agent.post(`/api/v1/sos/tickets/${id}/resolve`).set('X-CSRF-Token', helper.csrf).send({});
    expect(again.status).toBe(409);
    expect((await Volunteer.findById(responder.id))!.karmaPoints).toBe(200);
  });
});

describe('the SOS bounty cannot be paid to the person who raised the ticket', () => {
  it('refuses a creator resolving their own ticket, however it was raised', async () => {
    // The mint this closes: an OPEN ticket is deliberately resolvable by whoever gets there
    // first, so that somebody standing next to the problem need not wait for dispatch. That
    // also let the person who RAISED it resolve it and collect their own bounty — raise at the
    // maximum, resolve, repeat, with nothing to lose but the daily budget.
    const sam = await makeAccount({ name: 'Self Sam', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const session = await signIn(sam.id);
    const created = await session.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', session.csrf).send({
      hackerName: 'Self Sam', tableLocation: 'Siebel Center Atrium', description: 'paying myself',
      urgency: 'HIGH', coordinates: { latitude: 40.11380, longitude: -88.22470 },
    });
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    await expect(SOSService.resolveTicket(id, sam.id)).rejects.toThrow(/cannot resolve a ticket you raised/i);
    expect((await Volunteer.findById(sam.id))!.karmaPoints).toBe(0);
    expect((await SOSTicket.findById(id))!.status).toBe(SOSTicketStatus.OPEN);

    // Somebody else closing it is still fine, and still pays them.
    const rae = await makeAccount({ name: 'Rae' });
    const done = await SOSService.resolveTicket(id, rae.id);
    expect(done.status).toBe(SOSTicketStatus.RESOLVED);
    expect((await Volunteer.findById(rae.id))!.karmaPoints).toBeGreaterThan(0);
  });

  it('charges every creator against the daily budget, not only hackers', async () => {
    // A volunteer raising tickets used to skip the budget entirely, so two of them could
    // alternate raising maximum-bounty tickets and resolving each other's without limit.
    const budget = pack.event.hackerBountyBudgetPerDay ?? 0;
    if (!budget) return;
    const vol = await makeAccount({ name: 'Budget Bea' });
    const session = await signIn(vol.id);
    const raise = (n: number) => session.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', session.csrf).send({
      hackerName: `Ticket ${n}`, tableLocation: 'Siebel Center Atrium', description: 'budget probe',
      urgency: 'HIGH', karmaBounty: 150, coordinates: { latitude: 40.11380, longitude: -88.22470 },
    });

    const statuses: number[] = [];
    for (let i = 0; i < Math.ceil(budget / 150) + 2; i++) statuses.push((await raise(i)).status);

    // Some are accepted and, once the budget is gone, the rest are refused with a 409 — never
    // a 500, and never an unbounded run of acceptances.
    expect(statuses).toContain(201);
    expect(statuses).toContain(409);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const spent = await BountyLedger.findOne({ accountId: vol._id });
    expect(spent!.spent).toBeLessThanOrEqual(budget);
  });

  it('escalates a stale ticket without putting the table text on the public channel', async () => {
    // `announce` is the one channel anybody may join without a session. The escalation used to
    // label the raw `tableLocation` as `venueKey`, publishing "Table 42, back left" to anyone
    // watching, about somebody who had been waiting three minutes for help.
    const sam = await makeAccount({ name: 'Stale Sam', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const session = await signIn(sam.id);
    const created = await session.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', session.csrf).send({
      hackerName: 'Stale Sam', tableLocation: 'Table 42, back left by the outlets',
      description: 'nobody came', urgency: 'HIGH',
      coordinates: { latitude: 40.11380, longitude: -88.22470 },
    });
    const id = created.body.data._id;
    // Escalation is for a ticket that was DISPATCHED and then went unanswered, so put it in
    // that state and age it past the three-minute threshold.
    const responder = await makeAccount({ name: 'Silent Sid' });
    await SOSTicket.updateOne({ _id: id }, {
      $set: {
        status: SOSTicketStatus.DISPATCHED,
        assignedVolunteerId: responder._id,
        dispatchedAt: new Date(Date.now() - 10 * 60_000),
        createdAt: new Date(Date.now() - 12 * 60_000),
      },
    });

    // Spying on the hub rather than opening a socket: what is under test is the payload the
    // service hands to the public channel, and a spy states that without a transport in the
    // way. `announce` is the channel anybody may join without a session, which is what makes
    // its contents public and this assertion worth making.
    const onAnnounce: Array<Record<string, unknown>> = [];
    const spy = jest.spyOn(eventHub, 'broadcastChannel').mockImplementation((channel, message) => {
      if (channel === 'announce') onAnnounce.push(message.data as Record<string, unknown>);
    });
    try {
      await SOSService.escalateStale();
    } finally {
      spy.mockRestore();
    }

    const escalation = onAnnounce.find((d) => String(d.ticketId) === String(id));
    expect(escalation).toBeDefined();
    const asText = JSON.stringify(escalation);
    expect(asText).not.toContain('Table 42');
    expect(asText).not.toContain('back left');
    // A location the venue table cannot resolve becomes null rather than the raw text.
    expect(escalation!.venueKey).toBeNull();
    // And it still says the useful part: the urgency, and how long somebody has been waiting.
    // `minutesOpen` is measured from `createdAt`, which Mongoose marks immutable, so a test
    // that back-dates the document sees zero here — the figure is right in production and
    // untestable by rewriting the timestamp, so this asserts the field is present and sane
    // rather than pretending to have aged it.
    expect(escalation!.urgency).toBe('HIGH');
    expect(Number(escalation!.minutesOpen)).toBeGreaterThanOrEqual(0);
  });

  it('publishes the building when the location resolves, and never the seat within it', async () => {
    const sam = await makeAccount({ name: 'Venue Val', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const session = await signIn(sam.id);
    const created = await session.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', session.csrf).send({
      hackerName: 'Venue Val', tableLocation: 'Siebel Center Atrium, table 7',
      description: 'resolvable venue', urgency: 'MEDIUM',
      coordinates: { latitude: 40.11380, longitude: -88.22470 },
    });
    const id = created.body.data._id;
    const responder = await makeAccount({ name: 'Quiet Quinn' });
    await SOSTicket.updateOne({ _id: id }, {
      $set: {
        status: SOSTicketStatus.DISPATCHED,
        assignedVolunteerId: responder._id,
        dispatchedAt: new Date(Date.now() - 10 * 60_000),
        createdAt: new Date(Date.now() - 12 * 60_000),
      },
    });

    const onAnnounce: Array<Record<string, unknown>> = [];
    const spy = jest.spyOn(eventHub, 'broadcastChannel').mockImplementation((channel, message) => {
      if (channel === 'announce') onAnnounce.push(message.data as Record<string, unknown>);
    });
    try {
      await SOSService.escalateStale();
    } finally {
      spy.mockRestore();
    }

    const escalation = onAnnounce.find((d) => String(d.ticketId) === String(id));
    expect(escalation).toBeDefined();
    expect(escalation!.venueKey).toBe('SIEBEL_ATRIUM');
    expect(JSON.stringify(escalation)).not.toContain('table 7');
  });
});

describe('announcements', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });

  it('a lead posts one; the audience filter decides who reads it', async () => {
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const volunteer = await makeAccount();
    const hacker = await makeAccount({ kind: AccountKind.HACKER });
    const { agent: l, csrf } = await signIn(lead.id);

    // With the CSRF header present, the only thing that can produce a 403 is the role gate,
    // which is what this line is meant to pin.
    const vol = await signIn(volunteer.id);
    const refused = await vol.agent.post('/api/v1/announcements').set('X-CSRF-Token', vol.csrf).send({ message: 'nope' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('INSUFFICIENT_PERMISSIONS');

    await l.post('/api/v1/announcements').set('X-CSRF-Token', csrf).send({ message: 'Pizza at Siebel', audience: AnnouncementAudience.ALL, minutes: 5 });
    await l.post('/api/v1/announcements').set('X-CSRF-Token', csrf).send({ message: 'Staff huddle', audience: AnnouncementAudience.STAFF, minutes: 5 });

    const { agent: h } = await signIn(hacker.id);
    const forHacker = await h.get('/api/v1/announcements');
    expect(forHacker.body.data.map((a: { message: string }) => a.message)).toEqual(['Pizza at Siebel']);

    const forLead = await l.get('/api/v1/announcements');
    expect(forLead.body.data).toHaveLength(2);
  });

  it('an expired announcement is not returned', async () => {
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const { agent, csrf } = await signIn(lead.id);
    await Announcement.create({
      message: 'Long gone', audience: AnnouncementAudience.ALL, authorId: lead._id, authorName: lead.name,
      expiresAt: new Date(Date.now() - 1000),
    });
    await agent.post('/api/v1/announcements').set('X-CSRF-Token', csrf).send({ message: 'Still here', minutes: 5 });
    const res = await agent.get('/api/v1/announcements');
    expect(res.body.data.map((a: { message: string }) => a.message)).toEqual(['Still here']);
  });
});

describe('me and roster', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });
  beforeEach(() => presenceStore.clear());

  it('GET /me/shifts names the next shift, and /me/card carries nothing sensitive', async () => {
    const vol = await makeAccount({ name: 'Rota Rae' });
    const soon = await openShift('Later today');
    await Shift.updateOne({ _id: soon._id }, { $set: { startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000) } });
    const later = await openShift('Tomorrow');
    await Shift.updateOne({ _id: later._id }, { $set: { startTime: new Date(Date.now() + 90_000_000), endTime: new Date(Date.now() + 93_600_000) } });
    await Registration.create([
      { shiftId: later._id, volunteerId: vol._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('r1') },
      { shiftId: soon._id, volunteerId: vol._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('r2') },
    ]);

    const { agent } = await signIn(vol.id);
    const mine = await agent.get('/api/v1/me/shifts');
    expect(mine.status).toBe(200);
    expect(mine.body.data.shifts).toHaveLength(2);
    expect(mine.body.data.next.title).toBe('Later today');

    const card = await agent.get('/api/v1/me/card');
    expect(card.status).toBe(200);
    expect(card.body.data.displayName).toBe('Rota Rae');
    expect(card.body.data.shortId).toHaveLength(6);
    // The one cacheable /api response, so it must hold nothing worth stealing.
    const body = JSON.stringify(card.body);
    expect(body).not.toContain('@illinois.edu');
    expect(body).not.toContain('sessionVersion');
    expect(card.headers['cache-control']).toBe('private, max-age=86400');
  });

  it('the roster is lead-only, reports presence as buckets rather than positions, and is audited once', async () => {
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const here = await makeAccount({ name: 'Here Hana' });
    const away = await makeAccount({ name: 'Away Ada' });
    const shift = await openShift('Roster shift');
    await Registration.create([
      { shiftId: shift._id, volunteerId: here._id, status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('k1') },
      { shiftId: shift._id, volunteerId: away._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('k2') },
    ]);
    // "Here Hana" is publishing from the venue itself.
    presenceStore.update(
      { id: String(here._id), name: here.name, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null, avatarHash: null, optIn: true, onDuty: true },
      { lat: 40.1138, lng: -88.2249, acc: 6 }
    );

    const { agent: v } = await signIn(here.id);
    expect((await v.get(`/api/v1/shifts/${shift.id}/roster`)).status).toBe(403);

    await PresenceAudit.deleteMany({});
    const { agent: l } = await signIn(lead.id);
    const res = await l.get(`/api/v1/shifts/${shift.id}/roster`);
    expect(res.status).toBe(200);
    expect(res.body.data.counts.checkedIn).toBe(1);
    const hana = res.body.data.roster.find((r: { name: string }) => r.name === 'Here Hana');
    const ada = res.body.data.roster.find((r: { name: string }) => r.name === 'Away Ada');
    expect(hana.presence.publishing).toBe(true);
    expect(['now', 'recent']).toContain(hana.presence.age);
    expect(ada.presence).toEqual({ age: 'none', distance: 'unknown', publishing: false });
    // Buckets, never a coordinate.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('latitude');
    expect(body).not.toContain('40.11');

    const audits = await PresenceAudit.find({ reason: 'roster' });
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectCount).toBe(2);
  });
});
