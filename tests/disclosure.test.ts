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
import { HackStop } from '../src/models/hackstop.model';
import { Avatar, AvatarStatus } from '../src/models/avatar.model';
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

describe('a beacon list is not a movement log', () => {
  it('hides everybody else\'s cooldown and reports only the caller\'s own', async () => {
    // `lastSpunUsers` maps a volunteer id to the moment they last spun this beacon. It is
    // bookkeeping for one conditional update, and it went out on an unauthenticated list
    // route on every document — so polling `GET /pokeshift/hackstops` every few minutes built
    // a who-was-at-which-beacon-when timeline for the whole event, joined against ids that
    // are public by design. The presence layer fuzzes positions to twenty metres and audits
    // every exact read; this was a movement history in a JSON list, with no audit row.
    const me = await account({ name: 'Spinner Sam' });
    const other = await account({ name: 'Spinner Sid' });
    const spunAt = new Date(Date.now() - 60_000);
    await HackStop.create({
      beaconId: 'bx-1', name: 'Bench Beacon', locationName: 'Siebel Center Atrium',
      latitude: 40.11380, longitude: -88.22470, cooldownSeconds: 300,
      lastSpunUsers: new Map([[String(me._id), spunAt], [String(other._id), spunAt]]),
      totalSpins: 2,
    });

    const { agent } = await signIn(me.id);
    const res = await agent.get('/api/v1/pokeshift/hackstops');
    expect(res.status).toBe(200);
    const beacon = (res.body.data as Array<Record<string, unknown>>).find((b) => b.beaconId === 'bx-1')!;

    // Nobody's ledger, not even a redacted one.
    expect(beacon.lastSpunUsers).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(String(other._id));

    // The caller's own cooldown survives, because that is what the button needs.
    expect(new Date(beacon.yourLastSpinAt as string).getTime()).toBe(spunAt.getTime());
    expect(new Date(beacon.yourNextSpinAt as string).getTime()).toBe(spunAt.getTime() + 300_000);
  });
});

describe('flagging an avatar is a moderation action', () => {
  it('refuses a claimed lead identity, so one request cannot censor an attendee', async () => {
    // A lead's flag unpublishes on its own and three ordinary ones do, so the endpoint is a
    // takedown button. It was gated on having *an* identity rather than a proved one, and in
    // legacy mode an identity is a query parameter — so `?volunteerId=<any lead id>` censored
    // any attendee's avatar in one unauthenticated request, and rotating the claimed id also
    // walked past the per-reporter hourly cap.
    const lead = await account({ name: 'Lena Lead 2', role: VolunteerRole.SHIFT_LEAD });
    const owner = await account({ name: 'Owner Ola' });
    await Avatar.create({
      hash: 'a'.repeat(64), bytes: Buffer.from([1, 2, 3]), width: 32, height: 32,
      ownerId: owner._id, status: AvatarStatus.APPROVED, flags: [],
    });

    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'legacy';
    try {
      const claimed = await request(app)
        .post(`/api/v1/avatars/${'a'.repeat(64)}/flag?volunteerId=${lead.id}`)
        .send({ reason: 'inappropriate', ownerId: String(owner._id) });
      expect(claimed.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
    expect((await Avatar.findOne({ hash: 'a'.repeat(64) }))!.status).toBe(AvatarStatus.APPROVED);
  });
});
