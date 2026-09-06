/**
 * Attendance payment invariants.
 *
 * Check-in and check-out are the only place the system pays for time rather than for an
 * action, so they are the only place where doing the same thing twice can mint karma out of
 * nothing. The rest of the economy is guarded by a unique index on the thing being claimed;
 * time has no such natural key, which is why these need saying out loud.
 *
 * Three questions, each of which a real person will ask of the system by accident:
 *   - What happens when the check-out button is pressed twice, or ten times at once, because
 *     the network was slow and the phone was impatient?
 *   - What happens when somebody checks out for a break and comes back?
 *   - What does a one-minute presence pay, given that a full shift and a one-minute stint
 *     both end with a check-out?
 *
 * `tests/checkin.test.ts` covers the token itself — rotation, replay, tampering, the
 * geofence. This file is only about the money.
 */
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { CheckIn } from '../src/models/checkin.model';
import { KarmaLedger } from '../src/models/karmaLedger.model';
import { CheckInService } from '../src/services/checkin.service';
import { uniqueKey } from './helpers/uniqueKey';

async function scene(overrides: { baseKarma?: number } = {}) {
  const vol = await Volunteer.create({
    name: `Att ${Math.random().toString(36).slice(2, 7)}`,
    email: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
  });
  const startTime = new Date(Date.now() - 30 * 60_000);
  const shift = await Shift.create({
    title: 'Attendance Desk', description: 'x', category: ShiftCategory.LOGISTICS,
    location: 'Siebel Center Atrium',
    startTime, endTime: new Date(startTime.getTime() + 4 * 3600_000),
    capacity: 5, filledSlots: 1, baseKarma: overrides.baseKarma ?? 120,
  });
  const reg = await Registration.create({
    shiftId: shift._id, volunteerId: vol._id,
    status: RegistrationStatus.CONFIRMED, idempotencyKey: uniqueKey('att'),
  });
  return { vol, shift, reg };
}

/** Check in through the real token path, so nothing here bypasses a guard. */
async function checkIn(volId: string, shiftId: string) {
  const { token } = await CheckInService.generateToken(volId, shiftId);
  const res = await CheckInService.verifyAndCheckIn(token, 'TEST_SCANNER', {
    latitude: 40.11380, longitude: -88.22470,
  });
  return res.checkIn;
}

const karmaOf = async (id: string) => (await Volunteer.findById(id))!.karmaPoints;

describe('check-out pays exactly once', () => {
  it('is idempotent when pressed twice: the second call settles, it does not settle again', async () => {
    const { vol, shift } = await scene();
    const ci = await checkIn(vol.id, String(shift._id));

    const before = await karmaOf(vol.id);
    const first = await CheckInService.checkOut(String(ci._id), vol.id);
    const afterFirst = await karmaOf(vol.id);
    const second = await CheckInService.checkOut(String(ci._id), vol.id);
    const afterSecond = await karmaOf(vol.id);

    expect(afterFirst).toBeGreaterThan(before);
    // The second call is a replay of the same settled record, not a second settlement.
    expect(afterSecond).toBe(afterFirst);
    expect(String(second._id)).toBe(String(first._id));
    expect(second.checkOutTime?.getTime()).toBe(first.checkOutTime?.getTime());
    expect(second.karmaAwarded).toBe(first.karmaAwarded);
  });

  it('pays once when ten requests arrive together, which is what an impatient phone sends', async () => {
    const { vol, shift } = await scene();
    const ci = await checkIn(vol.id, String(shift._id));
    const before = await karmaOf(vol.id);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => CheckInService.checkOut(String(ci._id), vol.id).then(() => 'ok').catch((e) => String(e.statusCode ?? 'err')))
    );

    const after = await karmaOf(vol.id);
    const settled = await CheckIn.findById(ci._id);
    // Whatever mixture of settlements and replays the ten produced, the ledger is the
    // arbiter: one award, and the balance moved by exactly that.
    const rows = await KarmaLedger.find({ accountId: vol._id });
    const paid = rows.reduce((s, r) => s + r.amount, 0);
    expect(after - before).toBe(settled!.karmaAwarded);
    expect(paid).toBe(after - before);
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(0);
    expect(await CheckIn.countDocuments({ _id: ci._id, checkOutTime: { $exists: true } })).toBe(1);
  });

  it('refuses somebody else’s check-out', async () => {
    const { vol, shift } = await scene();
    const ci = await checkIn(vol.id, String(shift._id));
    const stranger = await Volunteer.create({
      name: 'Stranger', email: `s-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    await expect(CheckInService.checkOut(String(ci._id), stranger.id)).rejects.toThrow(/only the checked-in volunteer/i);
    expect(await karmaOf(stranger.id)).toBe(0);
  });
});

describe('time is what is paid for, not the act of arriving', () => {
  it('a one-minute presence earns a sixtieth of the shift, not half of it', async () => {
    const { vol, shift } = await scene({ baseKarma: 600 });
    const ci = await checkIn(vol.id, String(shift._id));
    const before = await karmaOf(vol.id);
    const done = await CheckInService.checkOut(String(ci._id), vol.id);
    const after = await karmaOf(vol.id);

    // Instant in, instant out. The duration floor records one minute; the payout is pro-rata
    // against an hour, so this must be a small fraction of a full shift's award rather than
    // the old flat half — which made check-in/check-out farming worth more than working.
    expect(done.durationMinutes).toBe(1);
    expect(after - before).toBe(done.karmaAwarded);
    expect(done.karmaAwarded).toBeLessThan(60);
    expect(done.karmaAwarded).toBeGreaterThan(0);
  });

  it('cannot be re-entered after check-out: one registration is one visit, ever', async () => {
    const { vol, shift } = await scene({ baseKarma: 600 });

    const first = await checkIn(vol.id, String(shift._id));
    const done = await CheckInService.checkOut(String(first._id), vol.id);
    const total = await karmaOf(vol.id);

    // Check-out moves the registration to CHECKED_OUT, and a token is only minted against a
    // CONFIRMED one. So a volunteer who steps out for coffee and scans back in is refused.
    //
    // That is the current rule and it is worth stating rather than discovering. It closes the
    // obvious farm — check in, check out, repeat, collecting a floor payment each time — at
    // the price of a real inconvenience: somebody who genuinely leaves and returns has to be
    // put back by a lead rather than scanning themselves in. The pro-rata payout above
    // already makes the farm nearly worthless, so if this is ever relaxed, the payout rule is
    // what has to hold, not this one.
    await expect(checkIn(vol.id, String(shift._id))).rejects.toThrow(/does not hold a confirmed spot/i);

    const ledger = await KarmaLedger.find({ accountId: vol._id });
    expect(ledger.reduce((s, r) => s + r.amount, 0)).toBe(total);
    expect(total).toBe(done.karmaAwarded);
    expect(await CheckIn.countDocuments({ volunteerId: vol._id })).toBe(1);
  });

});
