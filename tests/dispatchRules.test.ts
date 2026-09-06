/**
 * Who dispatch will send, whether it can shout twice, and what it says was paid.
 *
 * Dispatch is the one path in this system where being wrong has a person waiting at the
 * other end of it. Each rule below reads as an obvious detail until you follow it to three
 * in the morning: a candidate pool with no clock in it sends the ticket to somebody asleep;
 * an escalation that can only fire once means a reassigned ticket is never shouted about
 * again; a payout announced at its advertised price instead of its granted one turns a
 * capped responder into a support ticket.
 */
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { SOSTicket, SOSTicketStatus } from '../src/models/sosTicket.model';
import { PresenceAudit } from '../src/models/presenceAudit.model';
import { KarmaLedger, eventDay } from '../src/models/karmaLedger.model';
import { SOSService } from '../src/services/sos.service';
import { eventHub } from '../src/common/sse/eventHub';
import { pack } from '../src/content/loader';
import { uniqueKey } from './helpers/uniqueKey';

async function volunteerAccount(name: string, role = VolunteerRole.VOLUNTEER) {
  return Volunteer.create({
    name, email: `dr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: AccountKind.VOLUNTEER, role,
  });
}

/** A shift with an explicit window, so "is this person still on duty" is a decided question. */
async function shiftFrom(startOffsetMs: number, endOffsetMs: number, title = 'Dispatch pool') {
  return Shift.create({
    title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
    startTime: new Date(Date.now() + startOffsetMs), endTime: new Date(Date.now() + endOffsetMs),
    capacity: 4, baseKarma: 20,
  });
}

async function ticket(createdById?: string) {
  return SOSTicket.create({
    hackerName: 'Sam', tableLocation: 'Table 9', description: 'Need a hand', urgency: 'HIGH',
    coordinates: { latitude: 40.1099, longitude: -88.2272 },
    createdById: createdById ?? null,
  });
}

describe('the on-duty pool has a clock in it', () => {
  it('will not dispatch to a volunteer whose shift ended hours ago', async () => {
    // Check-out is a thing volunteers forget, and the pool was every registration in a
    // CHECKED_IN state with no time filter at all — so a row from yesterday's afternoon
    // shift stayed a candidate for ever. At three in the morning the "nearest on-duty
    // volunteer" was somebody who went to bed at nine; the ticket was marked DISPATCHED,
    // which stops anybody else looking at it, and the person in distress waited for a
    // responder who was asleep.
    const asleep = await volunteerAccount('Dozy Dana');
    const finished = await shiftFrom(-8 * 3600_000, -4 * 3600_000, 'Yesterday afternoon');
    await Registration.create({
      shiftId: finished._id, volunteerId: asleep._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('stale'),
    });

    const t = await ticket();
    await expect(SOSService.dispatchNearestVolunteer(String(t._id))).rejects.toThrow(
      /No on-duty volunteers available/i
    );

    // The same person, on a shift that is actually running, is dispatched — so the rule is
    // about the clock and not about them.
    const running = await shiftFrom(-1800_000, 3600_000, 'Right now');
    await Registration.create({
      shiftId: running._id, volunteerId: asleep._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('live'),
    });
    const sent = await SOSService.dispatchNearestVolunteer(String(t._id));
    expect(String(sent.dispatchedVolunteer._id)).toBe(String(asleep._id));
  });
});

describe('the on-duty pool has both ends of the window', () => {
  it('will not fall back to a volunteer whose shift has not started yet', async () => {
    // The CONFIRMED tier exists for the hours when nobody has scanned in. Checking only that
    // a shift had not *ended* left the other half of the window open: a volunteer confirmed
    // for tomorrow afternoon has an `endTime` comfortably in the future, so at half past
    // three in the morning the ticket went to somebody who is not at the event — and was
    // marked DISPATCHED, which stops anybody else looking at it.
    const tomorrow = await volunteerAccount('Tomorrow Tam');
    const later = await shiftFrom(20 * 3600_000, 24 * 3600_000, 'Tomorrow afternoon');
    await Registration.create({
      shiftId: later._id, volunteerId: tomorrow._id,
      status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('future'),
    });

    const t = await ticket();
    await expect(SOSService.dispatchNearestVolunteer(String(t._id))).rejects.toThrow(
      /No on-duty volunteers available/i
    );

    // A volunteer whose shift starts within the grace is on duty — turning up early is the
    // normal case, and the rule must not refuse somebody standing in the room.
    const soon = await volunteerAccount('Soon Sol');
    const starting = await shiftFrom(10 * 60_000, 4 * 3600_000, 'Starting shortly');
    await Registration.create({
      shiftId: starting._id, volunteerId: soon._id,
      status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('soon'),
    });
    const sent = await SOSService.dispatchNearestVolunteer(String(t._id));
    expect(String(sent.dispatchedVolunteer._id)).toBe(String(soon._id));
  });
});

describe('a reassigned ticket can be escalated again', () => {
  it('clears the escalation stamp, so the second silence is shouted about too', async () => {
    // The sweep looks for `{ status: DISPATCHED, escalatedAt: null }`. Reassignment cleared
    // the assignee and all three progress timestamps and left `escalatedAt` behind, so a
    // ticket that escalated once, was handed to somebody else, and was then ignored all over
    // again could never escalate a second time. Reassignment exists precisely because the
    // first responder did not come.
    const lead = await volunteerAccount('Lena Lead', VolunteerRole.SHIFT_LEAD);
    const first = await volunteerAccount('First Fay');
    const t = await ticket();
    await SOSTicket.updateOne({ _id: t._id }, {
      $set: {
        status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: first._id,
        dispatchedAt: new Date(Date.now() - 4 * 60_000),
      },
    });

    const spy = jest.spyOn(eventHub, 'broadcastChannel').mockImplementation(() => {});
    expect(await SOSService.escalateStale()).toBe(1);
    expect((await SOSTicket.findById(t._id))!.escalatedAt).toBeTruthy();

    await SOSService.reassign(String(t._id), { id: lead.id, role: 'SHIFT_LEAD' });
    const reopened = await SOSTicket.findById(t._id);
    expect(reopened!.status).toBe(SOSTicketStatus.OPEN);
    expect(reopened!.escalatedAt).toBeFalsy();

    // Dispatched again, ignored again, shouted about again.
    const second = await volunteerAccount('Second Sid');
    await SOSTicket.updateOne({ _id: t._id }, {
      $set: {
        status: SOSTicketStatus.DISPATCHED, assignedVolunteerId: second._id,
        dispatchedAt: new Date(Date.now() - 4 * 60_000),
      },
    });
    expect(await SOSService.escalateStale()).toBe(1);
    spy.mockRestore();
  });
});

describe('the wire reports what was granted', () => {
  it('announces zero when the daily SOS cap is spent, not the ticket bounty', async () => {
    // Every other payout in the system propagates the granted figure; SOS resolution
    // broadcast `resolved.karmaBounty` regardless. A responder past their cap was told they
    // had earned the bounty while their balance did not move — a wire that disagrees with
    // the ledger, which is how a support queue fills up on the night.
    const responder = await volunteerAccount('Capped Cass');
    const running = await shiftFrom(-1800_000, 3600_000, 'Cap desk');
    await Registration.create({
      shiftId: running._id, volunteerId: responder._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('cap'),
    });

    // Spend the day's SOS allowance outright.
    const cap = pack.event.karmaCaps.SOS;
    await KarmaLedger.create({ accountId: responder._id, source: 'SOS', day: eventDay(), amount: cap });

    const t = await ticket();
    await SOSService.dispatchNearestVolunteer(String(t._id));
    await SOSService.acknowledge(String(t._id), { id: String(responder._id), role: 'VOLUNTEER' });

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const spy = jest.spyOn(eventHub, 'broadcast').mockImplementation((msg) => {
      frames.push({ type: msg.type, data: (msg.data ?? {}) as Record<string, unknown> });
    });
    const before = (await Volunteer.findById(responder._id))!.karmaPoints;
    await SOSService.resolveTicket(String(t._id), String(responder._id), 'VOLUNTEER');
    spy.mockRestore();

    const after = (await Volunteer.findById(responder._id))!.karmaPoints;
    expect(after).toBe(before);
    const resolvedFrame = frames.find((f) => f.type === 'SOS_TICKET_RESOLVED');
    expect(resolvedFrame).toBeTruthy();
    expect(resolvedFrame!.data.karmaAwarded).toBe(0);
    // The bounty is still reported, so a reader can see the difference rather than guess at it.
    expect(resolvedFrame!.data.karmaBounty).toBeGreaterThan(0);
  });
});

describe('the dispatch audit names the reader', () => {
  it('records the account that dispatched, not the literal string "dispatch"', async () => {
    // `docs/PRESENCE.md` promises the log answers "who read whom and why". A literal
    // `readerId: 'dispatch'` answers the second half only: every dispatch in the event
    // collapsed onto one indistinguishable reader, so the log could not tell an ordinary
    // night from one volunteer dispatching tickets at chosen coordinates all evening.
    const caller = await volunteerAccount('Dee Dispatcher');
    const responder = await volunteerAccount('Rae Responder');
    const running = await shiftFrom(-1800_000, 3600_000, 'Audit desk');
    await Registration.create({
      shiftId: running._id, volunteerId: responder._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('audit'),
    });

    const t = await ticket();
    await SOSService.dispatchNearestVolunteer(String(t._id), { id: String(caller._id), role: 'VOLUNTEER' });

    const rows = await PresenceAudit.find({ reason: 'dispatch' });
    expect(rows).toHaveLength(1);
    expect(rows[0].readerId).toBe(String(caller._id));
  });
});
