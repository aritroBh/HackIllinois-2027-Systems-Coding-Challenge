/**
 * The scheduling rules that protect a volunteer from the schedule, and the event from a
 * volunteer being paid twice for one shift.
 *
 * These are read-then-act rules over rows the volunteer already holds, which makes them the
 * easiest place in the system to be quietly wrong: every one of them passes for the ordinary
 * case, and each failure below is a shape somebody will produce by accident on the night.
 */
import request from 'supertest';
import { app } from '../src/app';
import { Volunteer } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { RegistrationService } from '../src/services/registration.service';
import { CheckInService } from '../src/services/checkin.service';
import { uniqueKey } from './helpers/uniqueKey';

async function volunteer(name = 'Rules Rita') {
  return Volunteer.create({
    name, email: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    certifications: [], karmaPoints: 0,
  });
}

/**
 * A shift that is running right now, for the tests that check somebody in. Check-in is only
 * accepted within half an hour either side of a shift, so a fixed future date would be
 * refused before the rule under test was reached.
 */
async function shiftNow(hours: number, title = 'Rules desk') {
  const startTime = new Date(Date.now() - 10 * 60_000);
  return Shift.create({
    title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
    startTime, endTime: new Date(startTime.getTime() + hours * 3600_000),
    capacity: 10, baseKarma: 100,
  });
}

/** A shift at a fixed wall-clock time, so the day-boundary maths is deliberate rather than lucky. */
async function shiftAt(startIso: string, hours: number, title = 'Rules desk') {
  const startTime = new Date(startIso);
  return Shift.create({
    title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
    startTime, endTime: new Date(startTime.getTime() + hours * 3600_000),
    capacity: 10, baseKarma: 100,
  });
}

describe('a shift already worked cannot be worked again', () => {
  it('refuses a second registration for a completed shift, and does not consume a second seat', async () => {
    // The farm this closes: work a shift, be paid, then sign up for the same shift again while
    // it is still open, mint a fresh token, check in and check out for a second payment. Each
    // round also took a seat somebody else could have had, permanently, because check-out does
    // not give it back.
    const vol = await volunteer();
    const shift = await shiftNow(2);

    await RegistrationService.reserveShift({ shiftId: String(shift._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('first') });
    const { token } = await CheckInService.generateToken(String(vol._id), String(shift._id));
    const { checkIn } = await CheckInService.verifyAndCheckIn(token, 'TEST', { latitude: 40.11380, longitude: -88.22470 });
    const paid = await CheckInService.checkOut(String(checkIn._id), String(vol._id));
    expect(paid.karmaAwarded).toBeGreaterThan(0);

    const reg = await Registration.findOne({ shiftId: shift._id, volunteerId: vol._id });
    expect(reg!.status).toBe(RegistrationStatus.COMPLETED);
    const seatsAfterFirst = (await Shift.findById(shift._id))!.filledSlots;

    await expect(
      RegistrationService.reserveShift({ shiftId: String(shift._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('second') })
    ).rejects.toThrow(/already worked this shift/i);

    expect(await Registration.countDocuments({ shiftId: shift._id, volunteerId: vol._id })).toBe(1);
    expect((await Shift.findById(shift._id))!.filledSlots).toBe(seatsAfterFirst);
    expect((await Volunteer.findById(vol._id))!.karmaPoints).toBe(paid.karmaAwarded);
  });

  it('still lets somebody re-register a shift they cancelled', async () => {
    // The behaviour the exclusion exists for, which must survive the fix above: withdrawing is
    // a change of mind, and changing it back is allowed.
    const vol = await volunteer();
    const shift = await shiftAt('2027-02-27T18:00:00Z', 2);
    const first = await RegistrationService.reserveShift({ shiftId: String(shift._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('c1') });
    await RegistrationService.cancelRegistration(String(first.registration._id), String(vol._id));
    const again = await RegistrationService.reserveShift({ shiftId: String(shift._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('c2') });
    expect(again.registration.status).toBe(RegistrationStatus.CONFIRMED);
  });
});

describe('the daily fatigue limit counts every day a shift touches', () => {
  it('refuses an overnight shift whose morning hours would breach the following day', async () => {
    // 22:00 to 06:00 spans two local days. Six of those hours fall on the second, and only the
    // first day used to be weighed — so a volunteer with seven hours already booked on the
    // second day could add this and work thirteen, from a rule whose whole purpose is to stop
    // exactly that.
    const vol = await volunteer('Overnight Ola');

    // Seven hours on the Sunday, in local time (Chicago is UTC-6 in February).
    const sunday = await shiftAt('2027-02-28T15:00:00Z', 7, 'Sunday long day');
    await RegistrationService.reserveShift({ shiftId: String(sunday._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('day') });

    // Saturday 22:00 to Sunday 06:00 local = Sunday 04:00 to 12:00 UTC.
    const overnight = await shiftAt('2027-02-28T04:00:00Z', 8, 'Overnight watch');
    await expect(
      RegistrationService.reserveShift({ shiftId: String(overnight._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('night') })
    ).rejects.toThrow(/fatigue/i);
  });

  it('allows an overnight shift when neither day it touches is over the limit', async () => {
    const vol = await volunteer('Reasonable Rai');
    const overnight = await shiftAt('2027-02-28T04:00:00Z', 6, 'Short overnight');
    const res = await RegistrationService.reserveShift({ shiftId: String(overnight._id), volunteerId: String(vol._id), idempotencyKey: uniqueKey('ok') });
    expect(res.registration.status).toBe(RegistrationStatus.CONFIRMED);
  });
});

describe('confirm-or-fail is reachable', () => {
  it('answers SHIFT_FULL instead of a queue place when the caller asked not to be queued', async () => {
    // `allowWaitlist` and the `SHIFT_FULL` branch have both been in the service from the
    // start, and no HTTP caller could reach either: the Zod schema did not accept the field
    // and the controller never forwarded it, so every request took the `true` default. A
    // volunteer who wants the shift or nothing was given a queue place they did not ask for,
    // and a documented 409 was unreachable code.
    const holder = await volunteer('Holder Hal');
    const asker = await volunteer('Asker Ada');
    const shift = await Shift.create({
      title: 'One seat', description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000),
      capacity: 1, baseKarma: 10,
    });
    await RegistrationService.reserveShift({
      shiftId: String(shift._id), volunteerId: String(holder._id), idempotencyKey: uniqueKey('hold'),
    });

    const refused = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', uniqueKey('noq'))
      .send({ shiftId: String(shift._id), volunteerId: String(asker._id), allowWaitlist: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('SHIFT_FULL');
    expect(await Registration.countDocuments({ shiftId: shift._id, volunteerId: asker._id })).toBe(0);

    // The default is unchanged: a caller who says nothing is still queued.
    const queued = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', uniqueKey('q'))
      .send({ shiftId: String(shift._id), volunteerId: String(asker._id) });
    expect(queued.status).toBe(201);
    expect(queued.body.data.status).toBe(RegistrationStatus.WAITLISTED);
  });
});

describe('the waitlist cascade tells a conflict apart from a failure', () => {
  it('does not skip the head of the queue because the database blinked', async () => {
    // The candidate probe caught everything and read every failure as "this person is busy".
    // A replica-set stepdown, a dropped socket or a query timeout silently passed over the
    // head of the queue — no log, no retry — and handed the seat to whoever was behind them.
    // The person skipped never learns, and neither does anybody else, because the cascade
    // then reports a perfectly ordinary promotion.
    const leaver = await volunteer('Leaver Lou');
    const first = await volunteer('First Fern');
    const shift = await Shift.create({
      title: 'Cascade desk', description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000),
      capacity: 1, baseKarma: 10,
    });
    const held = await RegistrationService.reserveShift({
      shiftId: String(shift._id), volunteerId: String(leaver._id), idempotencyKey: uniqueKey('lv'),
    });
    await RegistrationService.reserveShift({
      shiftId: String(shift._id), volunteerId: String(first._id), idempotencyKey: uniqueKey('ft'),
    });

    const blip = jest
      .spyOn(RegistrationService, 'assertNoScheduleConflicts')
      .mockRejectedValue(new Error('connection 3 to 127.0.0.1:27017 closed'));

    await expect(
      RegistrationService.cancelRegistration(String(held.registration._id), String(leaver._id)),
    ).rejects.toThrow(/connection 3/);
    blip.mockRestore();

    // The queue is intact — nobody was quietly passed over — and the seat went back to the
    // shift rather than to the wrong volunteer.
    const stillQueued = await Registration.findOne({ shiftId: shift._id, volunteerId: first._id });
    expect(stillQueued!.status).toBe(RegistrationStatus.WAITLISTED);
    expect((await Shift.findById(shift._id))!.filledSlots).toBe(0);
  });
});
