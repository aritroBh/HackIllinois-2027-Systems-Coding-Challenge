import request from 'supertest';
import { uniqueKey } from './helpers/uniqueKey';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';

describe('High-Concurrency Stress Test & Anti-Overselling Guard', () => {
  it('guarantees ZERO overbooking when 50 concurrent requests hit a 2-spot shift', async () => {
    // 1. Create 50 distinct volunteers
    const volunteerDocs = [];
    for (let i = 0; i < 50; i++) {
      volunteerDocs.push({
        name: `Volunteer Hacker ${i}`,
        email: `hacker_${i}@illinois.edu`,
        certifications: [],
        karmaPoints: 0,
      });
    }
    const volunteers = await Volunteer.insertMany(volunteerDocs);

    // 2. Create a shift with capacity = 2
    const startTime = new Date(Date.now() + 3600000);
    const endTime = new Date(startTime.getTime() + 7200000);

    const shift = await Shift.create({
      title: 'Contested Pizza Distribution',
      description: 'Only 2 spots available for 50 hungry volunteers',
      category: ShiftCategory.FOOD,
      location: 'Siebel Atrium Center',
      startTime,
      endTime,
      capacity: 2,
      filledSlots: 0,
      waitlistCount: 0,
      baseKarma: 150,
      version: 0,
      isActive: true,
    });

    // 3. Fire 50 simultaneous parallel reservation requests
    const promises = volunteers.map((vol, idx) =>
      request(app)
        .post('/api/v1/registrations')
        .set('idempotency-key', uniqueKey(`stress_test_worker_${idx}`))
        .send({
          shiftId: shift._id.toString(),
          volunteerId: vol._id.toString(),
        })
    );

    const responses = await Promise.all(promises);

    // 4. Assertions on HTTP status codes
    const successes = responses.filter((r) => r.status === 201);
    expect(successes).toHaveLength(50); // All 50 succeed in registering (2 confirmed, 48 waitlisted)

    // 5. Query MongoDB for exact counts
    const confirmedCount = await Registration.countDocuments({
      shiftId: shift._id,
      status: RegistrationStatus.CONFIRMED,
    });
    const waitlistedCount = await Registration.countDocuments({
      shiftId: shift._id,
      status: RegistrationStatus.WAITLISTED,
    });

    // Verify Invariant I1: Capacity bound strictly respected!
    expect(confirmedCount).toBe(2);
    expect(waitlistedCount).toBe(48);

    // Verify Shift document atomic counter consistency
    const updatedShift = await Shift.findById(shift._id);
    expect(updatedShift?.filledSlots).toBe(2);
    expect(updatedShift?.waitlistCount).toBe(48);
  }, 30000);

  it('does not oversell when a cancellation cascade races a fresh reservation', async () => {
    // Regression test for the window between freeing a seat and refilling it.
    //
    // Cancelling a CONFIRMED registration used to decrement `filledSlots` immediately and
    // increment it back only after the waitlist cascade had found, vetted and promoted a
    // candidate. Several awaits sat in between. A reservation arriving inside that window
    // saw a free seat, passed the `$expr` capacity guard, and took it — and then the
    // promotion took it too. The shift finished at capacity + 1.
    //
    // The seat is now held across the cascade and only released if nobody is promoted, so
    // it is never briefly claimable. This test fires the racing reservation concurrently
    // with the cancellation and asserts the shift never exceeds capacity.
    const CAP = 2;
    const vols = await Volunteer.insertMany(
      Array.from({ length: 18 }, (_, i) => ({
        name: `Cascade Racer ${i}`,
        email: `cascade_racer_${i}@illinois.edu`,
        certifications: [],
        karmaPoints: 0,
      }))
    );

    const startTime = new Date(Date.now() + 3600000);
    const shift = await Shift.create({
      title: 'Cascade Race Station',
      description: 'Cancellation cascade racing a concurrent reservation',
      category: ShiftCategory.FOOD,
      location: 'Siebel Atrium Center',
      startTime,
      endTime: new Date(startTime.getTime() + 7200000),
      capacity: CAP,
      filledSlots: 0,
      waitlistCount: 0,
      baseKarma: 150,
      version: 0,
      isActive: true,
    });

    // Fill the shift and build a waitlist behind it, sequentially so ordering is known.
    const reservations = [];
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/v1/registrations')
        .set('idempotency-key', uniqueKey(`cascade_seed_${i}`))
        .send({ shiftId: shift._id.toString(), volunteerId: vols[i]._id.toString() });
      reservations.push(res);
    }

    const seeded = await Shift.findById(shift._id);
    expect(seeded?.filledSlots).toBe(CAP);
    expect(seeded?.waitlistCount).toBe(10 - CAP);

    // The registration to cancel — one of the confirmed holders.
    const confirmed = await Registration.find({
      shiftId: shift._id,
      status: RegistrationStatus.CONFIRMED,
    });
    expect(confirmed).toHaveLength(CAP);
    const victim = confirmed[0];

    // Race: cancel (which triggers the promotion cascade) against brand-new reservations
    // from volunteers not yet on this shift at all.
    //
    // Fired as a burst rather than a single pair. One race only reproduces the old bug
    // when the reservation's `$expr` check happens to land inside the cascade's window;
    // a scheduling order that puts it entirely before or after passes on broken code by
    // luck. Several concurrent claimants make hitting the window near-certain, which is
    // what turns this from a coin flip into a regression guard.
    const latecomers = vols.slice(10);
    const raceResults = await Promise.all([
      request(app)
        .delete(`/api/v1/registrations/${victim._id.toString()}`)
        .send({ volunteerId: victim.volunteerId.toString() }),
      ...latecomers.map((v, i) =>
        request(app)
          .post('/api/v1/registrations')
          .set('idempotency-key', uniqueKey(`cascade_racer_${i}`))
          .send({ shiftId: shift._id.toString(), volunteerId: v._id.toString() })
      ),
    ]);

    // Every reservation is accepted — as confirmed or waitlisted, the engine decides.
    for (const r of raceResults.slice(1)) {
      expect(r.status).toBe(201);
    }

    // The invariant: occupancy never exceeds capacity, by either measure.
    const finalShift = await Shift.findById(shift._id);
    const finalConfirmed = await Registration.countDocuments({
      shiftId: shift._id,
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
    });

    expect(finalConfirmed).toBeLessThanOrEqual(CAP);
    expect(finalShift!.filledSlots).toBeLessThanOrEqual(CAP);
    // And the denormalised counter still agrees with the rows it caches.
    expect(finalShift!.filledSlots).toBe(finalConfirmed);
  }, 30000);
});
