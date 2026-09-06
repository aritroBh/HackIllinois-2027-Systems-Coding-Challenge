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
