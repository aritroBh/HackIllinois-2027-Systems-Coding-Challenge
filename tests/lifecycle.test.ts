/**
 * The registration lifecycle is a state machine, and it has to behave like one.
 *
 * `registration.model.ts` documents it as forward-only:
 *
 *     CONFIRMED ──check-in──> CHECKED_IN ──check-out──> COMPLETED
 *         │                        │
 *         └──────cancel────────────┴──> CANCELLED
 *
 * Two transitions did not respect that. Check-out wrote `COMPLETED` with
 * `findByIdAndUpdate` and no precondition on the status it was leaving, and check-in set
 * the status with a plain read-modify-save twenty lines from a cancel path that is careful
 * to compare-and-set. Both let a row move backwards or sideways, and because `COMPLETED`
 * and `CHECKED_IN` both occupy a seat while `CANCELLED` does not, a row that moved wrongly
 * put two people in one seat — the exact corruption the reservation path exists to prevent.
 */
import { CheckInService } from '../src/services/checkin.service';
import { RegistrationService } from '../src/services/registration.service';
import { Volunteer } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { CheckIn } from '../src/models/checkin.model';
import { uniqueKey } from './helpers/uniqueKey';

/** A shift at the seeded HQ, so `resolveVenue` matches and the geofence has a centre. */
async function makeShift(capacity: number) {
  const start = new Date(Date.now() - 30 * 60 * 1000);
  return Shift.create({
    title: 'Lifecycle Shift',
    description: 'A shift for lifecycle assertions',
    category: ShiftCategory.LOGISTICS,
    location: 'Siebel Center Atrium',
    startTime: start,
    endTime: new Date(start.getTime() + 4 * 3600 * 1000),
    capacity,
    requiredSkills: [],
  });
}

async function makeVolunteer(name: string) {
  return Volunteer.create({ name, email: `${uniqueKey(name.toLowerCase())}@illinois.edu` });
}

/** Seats an account holds against a shift, counting every seat-occupying state. */
async function occupants(shiftId: unknown): Promise<number> {
  return Registration.countDocuments({
    shiftId,
    status: {
      $in: [
        RegistrationStatus.CONFIRMED,
        RegistrationStatus.CHECKED_IN,
        RegistrationStatus.COMPLETED,
      ],
    },
  });
}

describe('the registration lifecycle only moves forward', () => {
  it('check-out cannot resurrect a registration that was cancelled while checked in', async () => {
    const shift = await makeShift(1);
    const alice = await makeVolunteer('Alice');
    const bob = await makeVolunteer('Bob');

    const aliceRes = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(alice._id),
      idempotencyKey: uniqueKey('alice'),
    });
    expect(aliceRes.status).toBe(RegistrationStatus.CONFIRMED);
    const aliceReg = aliceRes.registration;

    const bobRes = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(bob._id),
      idempotencyKey: uniqueKey('bob'),
    });
    expect(bobRes.status).toBe(RegistrationStatus.WAITLISTED);
    const bobReg = bobRes.registration;

    // Alice turns up and is checked in.
    await Registration.updateOne(
      { _id: aliceReg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: new Date() } }
    );
    const checkIn = await CheckIn.create({
      registrationId: aliceReg._id,
      volunteerId: alice._id,
      shiftId: shift._id,
      checkInTime: new Date(Date.now() - 60 * 60 * 1000),
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    // Alice then cancels. The seat is handed to Bob by the waitlist cascade.
    await RegistrationService.cancelRegistration(String(aliceReg._id), String(alice._id));
    expect((await Registration.findById(bobReg._id))!.status).toBe(RegistrationStatus.CONFIRMED);
    expect((await Shift.findById(shift._id))!.filledSlots).toBe(1);

    // Alice's phone completes the check-out it started. It must not put her back in a seat
    // that now belongs to Bob.
    await CheckInService.checkOut(String(checkIn._id), String(alice._id)).catch(() => undefined);

    const aliceAfter = await Registration.findById(aliceReg._id);
    expect(aliceAfter!.status).toBe(RegistrationStatus.CANCELLED);
    expect(await occupants(shift._id)).toBe(1);
    expect((await Shift.findById(shift._id))!.filledSlots).toBe(1);
  });

  it('check-in cannot silently clobber a cancellation that committed first', async () => {
    const shift = await makeShift(1);
    const carol = await makeVolunteer('Carol');

    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(carol._id),
      idempotencyKey: uniqueKey('carol'),
    });
    await RegistrationService.cancelRegistration(String(reg._id), String(carol._id));

    // Whatever the check-in path does, it must not move a CANCELLED row into a state that
    // occupies a seat.
    await Registration.updateOne(
      { _id: reg._id, status: RegistrationStatus.CONFIRMED },
      { $set: { status: RegistrationStatus.CHECKED_IN } }
    );
    expect((await Registration.findById(reg._id))!.status).toBe(RegistrationStatus.CANCELLED);
    expect(await occupants(shift._id)).toBe(0);
  });

  it('a completed registration cannot be cancelled back out of its seat', async () => {
    const shift = await makeShift(1);
    const dave = await makeVolunteer('Dave');

    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(dave._id),
      idempotencyKey: uniqueKey('dave'),
    });
    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.COMPLETED, earnedKarma: 100 } }
    );

    // COMPLETED still occupies a seat, so cancelling it takes neither branch of the cancel
    // path: the seat is never released and the row walks backwards through the lifecycle
    // while `filledSlots` goes on counting it.
    await expect(
      RegistrationService.cancelRegistration(String(reg._id), String(dave._id))
    ).rejects.toThrow();

    expect((await Registration.findById(reg._id))!.status).toBe(RegistrationStatus.COMPLETED);
    expect((await Shift.findById(shift._id))!.filledSlots).toBe(1);
  });
});

describe('a refused scan does not spend the token', () => {
  /**
   * `verifyToken` used to mark the nonce consumed as part of verifying it, and four
   * separate refusals sit downstream of that: a cancelled registration, missing
   * coordinates, an unresolvable venue, and the geofence. So a volunteer who scanned a few
   * metres too far from the desk got a geofence refusal *and* a spent token, and their next
   * honest scan — at the desk, seconds later, well inside the token's window — came back
   * `REPLAY_ATTACK_DETECTED`. They had to mint a new one to check in.
   *
   * The nonce is now spent at the point the check-in is actually going to happen.
   */
  it('a geofence refusal leaves the token usable at the desk', async () => {
    const shift = await makeShift(2);
    const erin = await makeVolunteer('Erin');
    await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(erin._id),
      idempotencyKey: uniqueKey('erin'),
    });

    const { token } = await CheckInService.generateToken(String(erin._id), String(shift._id));

    // Two hundred metres away: outside the 75 m geofence.
    await expect(
      CheckInService.verifyAndCheckIn(token, 'TEST_DESK', { latitude: 40.1155, longitude: -88.2249 })
    ).rejects.toThrow(/Geofence/);

    // The same token, at the desk. This is the scan that used to report a replay attack.
    const desk = { latitude: 40.113725, longitude: -88.224905 };
    const { checkIn } = await CheckInService.verifyAndCheckIn(token, 'TEST_DESK', desk);
    expect(checkIn).toBeTruthy();
    expect((await Registration.findById(
      (await Registration.findOne({ shiftId: shift._id, volunteerId: erin._id }))!._id
    ))!.status).toBe(RegistrationStatus.CHECKED_IN);

    // And single use still means single use: the successful scan did spend it.
    await expect(
      CheckInService.verifyAndCheckIn(token, 'TEST_DESK', desk)
    ).rejects.toThrow(/replay/i);
  });
});

describe('a shift has to be happening', () => {
  /**
   * The token binds a volunteer to a shift and to a thirty-second slice of clock, and the
   * geofence binds the scan to a place — but nothing tied any of it to the shift actually
   * taking place. A volunteer confirmed for tomorrow could mint a token today, stand at the
   * venue, check in, and check out an hour later for the full surge award, having worked
   * nothing. `CHECKOUT` was one of the three uncapped karma sources at the time, so the
   * payout had no daily ceiling either.
   */
  async function shiftAt(offsetMs: number, durationMs = 2 * 3600_000) {
    const start = new Date(Date.now() + offsetMs);
    return Shift.create({
      title: 'Window Shift',
      description: 'A shift for time-window assertions',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: start,
      endTime: new Date(start.getTime() + durationMs),
      capacity: 4,
      requiredSkills: [],
    });
  }

  const desk = { latitude: 40.113725, longitude: -88.224905 };

  async function tokenFor(shiftId: string, volunteerId: string) {
    await RegistrationService.reserveShift({
      shiftId,
      volunteerId,
      idempotencyKey: uniqueKey('window'),
    });
    return (await CheckInService.generateToken(volunteerId, shiftId)).token;
  }

  it('refuses a check-in for a shift that has not started', async () => {
    const shift = await shiftAt(24 * 3600_000); // tomorrow
    const frank = await makeVolunteer('Frank');
    const token = await tokenFor(String(shift._id), String(frank._id));
    await expect(
      CheckInService.verifyAndCheckIn(token, 'TEST_DESK', desk)
    ).rejects.toThrow(/has not started yet/);
  });

  it('refuses a check-in for a shift that is long over', async () => {
    const shift = await shiftAt(-24 * 3600_000);
    const gina = await makeVolunteer('Gina');
    const token = await tokenFor(String(shift._id), String(gina._id));
    await expect(
      CheckInService.verifyAndCheckIn(token, 'TEST_DESK', desk)
    ).rejects.toThrow(/is over/);
  });

  it('accepts a volunteer who turns up early, and one whose shift has just overrun', async () => {
    // Twenty minutes before it starts: inside the grace, because people turn up early and
    // refusing them would make this rule the reason attendance goes unrecorded.
    const soon = await shiftAt(20 * 60_000);
    const hana = await makeVolunteer('Hana');
    const earlyToken = await tokenFor(String(soon._id), String(hana._id));
    await expect(
      CheckInService.verifyAndCheckIn(earlyToken, 'TEST_DESK', desk)
    ).resolves.toBeTruthy();

    // Ended twenty minutes ago: still inside the grace, because shifts overrun.
    const justEnded = await shiftAt(-2 * 3600_000 - 20 * 60_000);
    const ivan = await makeVolunteer('Ivan');
    const lateToken = await tokenFor(String(justEnded._id), String(ivan._id));
    await expect(
      CheckInService.verifyAndCheckIn(lateToken, 'TEST_DESK', desk)
    ).resolves.toBeTruthy();
  });
});

describe('what is recorded is what was paid', () => {
  /**
   * `CheckIn.karmaAwarded` and `Registration.earnedKarma` are what a disputed balance is
   * reconstructed from, and both were written with the *advertised* figure — computed from
   * the surge multiplier — while the ledger, the balance and the broadcast all carried the
   * figure the daily cap actually allowed. A volunteer past their CHECKOUT cap therefore had
   * two rows saying they were paid one number against a ledger saying another, permanently.
   *
   * Every sibling path was already corrected to *report* the granted figure. This one has to
   * persist it too.
   */
  it('a capped check-out records the granted karma, not the offered karma', async () => {
    const { KarmaService } = await import('../src/services/karma.service');
    const { pack } = await import('../src/content/loader');
    const cap = pack.event.karmaCaps.CHECKOUT;

    const shift = await makeShift(2);
    const jo = await makeVolunteer('Jo');
    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(jo._id),
      idempotencyKey: uniqueKey('jo'),
    });

    // Spend the whole day's CHECKOUT allowance before the shift is closed.
    await KarmaService.awardKarma(String(jo._id), cap, 'CHECKOUT', { reason: 'pre-spent' });

    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: new Date() } }
    );
    const checkIn = await CheckIn.create({
      registrationId: reg._id,
      volunteerId: jo._id,
      shiftId: shift._id,
      checkInTime: new Date(Date.now() - 60 * 60 * 1000),
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    const closed = await CheckInService.checkOut(String(checkIn._id), String(jo._id));

    // Nothing was granted — the cap was already exhausted — so nothing is what both rows say.
    expect(closed.karmaAwarded).toBe(0);
    expect((await CheckIn.findById(checkIn._id))!.karmaAwarded).toBe(0);
    expect((await Registration.findById(reg._id))!.earnedKarma).toBe(0);
  });
});

describe('a check-in that already happened stays answerable', () => {
  /**
   * The idempotent "you are already checked in" answer sat below the shift window, the
   * coordinate requirement and the geofence — so a *successful* check-in became
   * un-returnable the moment any of those stopped holding. A desk retrying after a restart,
   * at 18:35, for a shift that ended at 18:00, was told the shift was over rather than being
   * handed the attendance it had already recorded.
   */
  it('returns the existing record even once the shift window has closed', async () => {
    const start = new Date(Date.now() - 3 * 3600_000);
    const shift = await Shift.create({
      title: 'Window Closed Shift',
      description: 'Ended two hours ago',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: start,
      endTime: new Date(start.getTime() + 3600_000),
      capacity: 2,
      requiredSkills: [],
    });
    const kim = await makeVolunteer('Kim');
    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(kim._id),
      idempotencyKey: uniqueKey('kim'),
    });

    // Kim checked in while the shift was running.
    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: start } }
    );
    const existing = await CheckIn.create({
      registrationId: reg._id,
      volunteerId: kim._id,
      shiftId: shift._id,
      checkInTime: start,
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    // The desk retries now, long after the window closed, with a fresh token.
    const { token } = await CheckInService.generateToken(String(kim._id), String(shift._id));
    const { checkIn } = await CheckInService.verifyAndCheckIn(token, 'TEST_DESK', {
      latitude: 40.113725,
      longitude: -88.224905,
    });
    expect(String(checkIn._id)).toBe(String(existing._id));
  });
});

describe('the paid interval is the shift, not the visit', () => {
  /**
   * Check-in opens thirty minutes before a shift starts, deliberately — volunteers turn up
   * early and a desk should be able to scan them. The clamp added with the check-out fix
   * capped the *end* of the paid interval and left the start wherever the scan happened, so
   * arriving early was paid as work. `timeFactor` saturates at one hour, so it bites hardest
   * on short visits: half an hour early plus five minutes present reads as thirty-five
   * minutes and pays 0.58 of the award instead of 0.08.
   */
  it('does not pay for the half hour before the shift started', async () => {
    const start = new Date(Date.now() + 5 * 60_000); // starts in five minutes
    const shift = await Shift.create({
      title: 'Early Bird Shift',
      description: 'Two hours, scanned early',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: start,
      endTime: new Date(start.getTime() + 2 * 3600_000),
      capacity: 2,
      requiredSkills: [],
    });
    const early = await makeVolunteer('Early Erin');
    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(early._id),
      idempotencyKey: uniqueKey('early'),
    });
    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: new Date() } }
    );
    // Scanned twenty-five minutes before the shift starts, and checks out now.
    const checkIn = await CheckIn.create({
      registrationId: reg._id,
      volunteerId: early._id,
      shiftId: shift._id,
      checkInTime: new Date(start.getTime() - 25 * 60_000),
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    const closed = await CheckInService.checkOut(String(checkIn._id), String(early._id));

    // Nothing of the shift has happened yet, so the floor is one minute — not the
    // twenty-five that elapsed in the queue before the doors opened.
    expect(closed.durationMinutes).toBe(1);
    expect((await Volunteer.findById(early._id))!.hoursServed).toBeLessThan(0.1);
  });
});

describe('the idempotent answer is not a remote oracle', () => {
  /**
   * The "you are already checked in" short-circuit exists so a desk retrying after a restart,
   * past the end of the shift, is handed the attendance it already recorded rather than told
   * the shift is over. Returning a 200 and an attendance row is also a *disclosure* — it says
   * this person is checked in right now — so it sits above the shift window and below the two
   * gates that establish the caller is a desk at the venue with a GPS fix.
   */
  it('still refuses when no coordinates are sent, even for a checked-in volunteer', async () => {
    const start = new Date(Date.now() - 3 * 3600_000);
    const shift = await Shift.create({
      title: 'Oracle Shift',
      description: 'Ended two hours ago',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center Atrium',
      startTime: start,
      endTime: new Date(start.getTime() + 3600_000),
      capacity: 2,
      requiredSkills: [],
    });
    const sam = await makeVolunteer('Sam');
    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(sam._id),
      idempotencyKey: uniqueKey('sam'),
    });
    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: start } }
    );
    await CheckIn.create({
      registrationId: reg._id,
      volunteerId: sam._id,
      shiftId: shift._id,
      checkInTime: start,
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    const { token } = await CheckInService.generateToken(String(sam._id), String(shift._id));
    // No coordinates: the caller has not shown they are anywhere near the desk.
    await expect(CheckInService.verifyAndCheckIn(token, 'TEST_DESK')).rejects.toThrow(
      /GPS coordinates are required/
    );

    // And one far from the venue is refused by the geofence rather than answered.
    const { token: second } = await CheckInService.generateToken(String(sam._id), String(shift._id));
    await expect(
      CheckInService.verifyAndCheckIn(second, 'TEST_DESK', { latitude: 41.8781, longitude: -87.6298 })
    ).rejects.toThrow(/Geofence/);
  });
});

describe('a check-out that claims nothing pays nothing', () => {
  /**
   * The `CHECKED_IN -> COMPLETED` CAS had its return value discarded while the hours `$inc`
   * and `KarmaService.awardKarma` ran unconditionally underneath it. The status pre-check
   * above narrows the window but cannot close it: a cancellation committing between the
   * pre-check and the CAS hands the seat to a waitlister, the CAS matches nothing — and the
   * volunteer who cancelled was still credited the hours and paid, while the promoted
   * volunteer is paid for the same seat later. One seat, two payouts.
   */
  it('refuses, pays nothing, and leaves the check-in retryable when the seat has moved on', async () => {
    const shift = await makeShift(2);
    const pat = await makeVolunteer('Pat');
    const { registration: reg } = await RegistrationService.reserveShift({
      shiftId: String(shift._id),
      volunteerId: String(pat._id),
      idempotencyKey: uniqueKey('pat'),
    });
    await Registration.updateOne(
      { _id: reg._id },
      { $set: { status: RegistrationStatus.CHECKED_IN, checkInTime: new Date() } }
    );
    const checkIn = await CheckIn.create({
      registrationId: reg._id,
      volunteerId: pat._id,
      shiftId: shift._id,
      checkInTime: new Date(Date.now() - 60 * 60 * 1000),
      nonce: uniqueKey('nonce'),
      verifiedBy: 'TEST_DESK',
    });

    const before = (await Volunteer.findById(pat._id))!;

    // The interleaving: the seat is handed to a waitlister after the pre-check has read the
    // row and before the CAS runs. Reported to the pre-check as still CHECKED_IN while the
    // stored row is CANCELLED is precisely that window, and it is the only way to stand in
    // it deterministically without two processes.
    await Registration.updateOne({ _id: reg._id }, { $set: { status: RegistrationStatus.CANCELLED } });
    jest
      .spyOn(Registration, 'findById')
      .mockReturnValueOnce({ select: () => Promise.resolve({ status: RegistrationStatus.CHECKED_IN }) } as never);

    await expect(CheckInService.checkOut(String(checkIn._id), String(pat._id))).rejects.toThrow(
      /changed while the check-out was in flight/
    );
    jest.restoreAllMocks();

    // Nothing was paid, and nothing was credited.
    const after = (await Volunteer.findById(pat._id))!;
    expect(after.karmaPoints).toBe(before.karmaPoints);
    expect(after.hoursServed).toBe(before.hoursServed);
    // And the check-in is still open, so a retry can observe the settled state rather than
    // being told it already checked out.
    const reread = await CheckIn.findById(checkIn._id);
    expect(reread!.checkOutTime).toBeUndefined();
  });
});
