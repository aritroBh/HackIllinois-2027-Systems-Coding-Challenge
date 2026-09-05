import request from 'supertest';
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
        .set('idempotency-key', `stress_test_worker_${idx}_${Date.now()}`)
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
});
