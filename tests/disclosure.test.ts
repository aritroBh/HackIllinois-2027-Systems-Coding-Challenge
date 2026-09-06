/**
 * Who is allowed to learn who else is here.
 *
 * Every route in this file returns something perfectly ordinary — a shift, a directory —
 * and the question is only which fields come back for which caller. That makes these the
 * easiest rules in the system to lose: a populate added for the lead console, a role check
 * written against `role` instead of a proved session, and a thousand attendee accounts are
 * enumerable by anybody who can reach the endpoint. Nothing throws, nothing is slow, and no
 * test that only checks status codes notices.
 */
import request from 'supertest';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { signIn } from './helpers/session';
import { uniqueKey } from './helpers/uniqueKey';

async function account(over: Partial<{ name: string; kind: AccountKind; role: VolunteerRole }> = {}) {
  const kind = over.kind ?? AccountKind.VOLUNTEER;
  return Volunteer.create({
    name: over.name ?? `D ${Math.random().toString(36).slice(2, 7)}`,
    email: kind === AccountKind.HACKER ? null : `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind,
    role: over.role ?? (kind === AccountKind.HACKER ? VolunteerRole.HACKER : VolunteerRole.VOLUNTEER),
  });
}

describe('the shift detail page is not a back door to the roster', () => {
  it('gives a hacker the headcount and a volunteer the names', async () => {
    // `GET /shifts/:id/roster` is lead-only, session-only and audited, and
    // `GET /registrations` is staff-only on the stated grounds that who is working which
    // shift is staff information. `GET /shifts/:id` populated the same people — name,
    // certifications, karma, prestige — behind no middleware at all, so the gate was one
    // path segment wide. The dashboard's shift card only ever reads `.length` off these
    // arrays, which is why nobody noticed the rest of the document was going out with it.
    const worker = await account({ name: 'Wanda Worker' });
    const shift = await Shift.create({
      title: 'Roster desk', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000),
      capacity: 4, baseKarma: 50,
    });
    await Registration.create({
      shiftId: shift._id, volunteerId: worker._id,
      status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('disc'),
    });

    const hacker = await account({ name: 'Hank Hacker', kind: AccountKind.HACKER });
    const { agent: asHacker } = await signIn(hacker.id);
    const seen = await asHacker.get(`/api/v1/shifts/${shift._id}`);
    expect(seen.status).toBe(200);
    // The count is public — it is already on the shift document as `filledSlots`.
    expect(seen.body.data.confirmedVolunteers).toHaveLength(1);
    expect(JSON.stringify(seen.body.data)).not.toContain('Wanda Worker');

    const staff = await account({ name: 'Vera Volunteer' });
    const { agent: asStaff } = await signIn(staff.id);
    const roster = await asStaff.get(`/api/v1/shifts/${shift._id}`);
    expect(roster.status).toBe(200);
    expect(JSON.stringify(roster.body.data)).toContain('Wanda Worker');
  });
});

describe('the attendee directory needs a proved lead, not a claimed one', () => {
  it('refuses ?kind=ALL to a legacy caller naming a lead id, and allows it to a lead session', async () => {
    // In legacy mode an identity can be asserted with a query parameter, and account ids are
    // public — they are in every roster payload. `isLeadOrAbove(req.account)` reads the role
    // off whatever identity was attached, claimed or proved, so naming any lead's id widened
    // the directory to every hacker account. `projectionFor` on the same handler already
    // checks `source === 'session'`; this line did not, and the two disagreed.
    const lead = await account({ name: 'Lena Lead', role: VolunteerRole.SHIFT_LEAD });
    await account({ name: 'Hidden Hacker', kind: AccountKind.HACKER });

    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app).get(`/api/v1/volunteers?kind=ALL&volunteerId=${lead.id}`);
      expect(claimed.status).toBe(200);
      expect(JSON.stringify(claimed.body.data)).not.toContain('Hidden Hacker');
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }

    const { agent } = await signIn(lead.id);
    const proved = await agent.get('/api/v1/volunteers?kind=ALL');
    expect(proved.status).toBe(200);
    expect(JSON.stringify(proved.body.data)).toContain('Hidden Hacker');
  });
});
