import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer, VolunteerRole } from '../src/models/volunteer.model';

describe('Registration Invariants, Rest Buffers & Fatigue Limits', () => {
  it('enforces mandatory 30-minute rest buffer between consecutive shifts', async () => {
    const vol = await Volunteer.create({
      name: 'Jordan Lee',
      email: 'jordan@illinois.edu',
      role: VolunteerRole.VOLUNTEER,
    });

    // Shift 1: 10:00 - 12:00
    const start1 = new Date('2027-02-27T10:00:00Z');
    const end1 = new Date('2027-02-27T12:00:00Z');
    const shift1 = await Shift.create({
      title: 'Morning Setup',
      description: 'Setup tables and power strips',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center',
      startTime: start1,
      endTime: end1,
      capacity: 2,
    });

    // Shift 2: 12:15 - 14:00 (Only 15 minutes after Shift 1, violates 30-minute buffer!)
    const start2 = new Date('2027-02-27T12:15:00Z');
    const end2 = new Date('2027-02-27T14:00:00Z');
    const shift2 = await Shift.create({
      title: 'Afternoon Mentoring Check-in',
      description: 'Check in sponsors and mentors',
      category: ShiftCategory.INFO_DESK,
      location: 'Siebel Center',
      startTime: start2,
      endTime: end2,
      capacity: 2,
    });

    // First booking succeeds
    const res1 = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift1._id.toString(), volunteerId: vol._id.toString() });
    expect(res1.status).toBe(201);
    expect(res1.body.status).toBe('CONFIRMED');

    // Second booking must be rejected with 409 Conflict due to rest buffer!
    const res2 = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift2._id.toString(), volunteerId: vol._id.toString() });

    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe('SCHEDULE_BUFFER_CONFLICT');
    expect(res2.body.message).toContain('Needs at least 30-minute rest buffer');
  });

  it('enforces 8-hour max daily fatigue limit', async () => {
    const vol = await Volunteer.create({
      name: 'Taylor Swift',
      email: 'taylor@illinois.edu',
      role: VolunteerRole.VOLUNTEER,
    });

    // Book a 7-hour shift: 09:00 - 16:00
    const shiftA = await Shift.create({
      title: 'Long Shift A',
      description: 'Morning shift',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center',
      startTime: new Date('2027-02-27T09:00:00Z'),
      endTime: new Date('2027-02-27T16:00:00Z'),
      capacity: 2,
    });

    // Book another 2-hour shift on the same day: 17:00 - 19:00 (Total = 9 hours > 8 hours!)
    const shiftB = await Shift.create({
      title: 'Overtime Shift B',
      description: 'Evening shift',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center',
      startTime: new Date('2027-02-27T17:00:00Z'),
      endTime: new Date('2027-02-27T19:00:00Z'),
      capacity: 2,
    });

    const resA = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shiftA._id.toString(), volunteerId: vol._id.toString() });
    expect(resA.status).toBe(201);

    const resB = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shiftB._id.toString(), volunteerId: vol._id.toString() });

    expect(resB.status).toBe(409);
    expect(resB.body.error).toBe('DAILY_FATIGUE_EXCEEDED');
    expect(resB.body.message).toContain('Daily fatigue limit exceeded');
  });

  it('rejects registration if volunteer lacks required skill certification', async () => {
    const vol = await Volunteer.create({
      name: 'Sam Smith',
      email: 'sam@illinois.edu',
      certifications: ['FOOD_HANDLING'], // Missing DRIVERS_LICENSE
    });

    const shift = await Shift.create({
      title: 'Airport Van Driver',
      description: 'Shuttle VIP judges from Willard Airport',
      category: ShiftCategory.LOGISTICS,
      location: 'Willard Airport',
      startTime: new Date('2027-02-27T14:00:00Z'),
      endTime: new Date('2027-02-27T16:00:00Z'),
      capacity: 2,
      requiredSkills: ['DRIVERS_LICENSE'],
    });

    const res = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift._id.toString(), volunteerId: vol._id.toString() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('MISSING_SKILL_CERTIFICATION');
  });

  it('handles idempotency keys to prevent duplicate registration on network retries', async () => {
    const vol = await Volunteer.create({
      name: 'Casey Quinn',
      email: 'casey@illinois.edu',
    });

    const shift = await Shift.create({
      title: 'Idempotency Shift',
      description: 'Testing idempotent replays',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center',
      startTime: new Date('2027-02-27T14:00:00Z'),
      endTime: new Date('2027-02-27T16:00:00Z'),
      capacity: 5,
    });

    const idemKey = 'unique_idempotency_key_12345';

    // First call: succeeds
    const res1 = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', idemKey)
      .send({ shiftId: shift._id.toString(), volunteerId: vol._id.toString() });

    expect(res1.status).toBe(201);
    expect(res1.body.cached).toBe(false);

    // Second call with same idempotency-key: returns cached response without duplicate registration
    const res2 = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', idemKey)
      .send({ shiftId: shift._id.toString(), volunteerId: vol._id.toString() });

    expect(res2.status).toBe(200);
    expect(res2.body.cached).toBe(true);
    expect(res2.headers['x-cache-lookup']).toBe('HIT-IDEMPOTENT');

    // Verify shift slots incremented only once
    const updatedShift = await Shift.findById(shift._id);
    expect(updatedShift?.filledSlots).toBe(1);
  });

  it('rejects cross-user cancellation (IDOR) and strips client-supplied roles', async () => {
    const owner = await Volunteer.create({ name: 'Owner', email: 'owner@illinois.edu' });
    const stranger = await Volunteer.create({ name: 'Stranger', email: 'stranger@illinois.edu' });

    // Privilege escalation attempt: role is server-forced to VOLUNTEER.
    const promoRes = await request(app)
      .post('/api/v1/volunteers')
      .send({ name: 'Mallory', email: 'mallory@illinois.edu', role: 'ADMIN' });
    expect(promoRes.status).toBe(201);
    expect(promoRes.body.data.role).toBe(VolunteerRole.VOLUNTEER);

    const shift = await Shift.create({
      title: 'IDOR Guard Shift',
      description: 'Ownership proof required',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel Center',
      startTime: new Date('2027-02-27T14:00:00Z'),
      endTime: new Date('2027-02-27T16:00:00Z'),
      capacity: 5,
    });

    const regRes = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift._id.toString(), volunteerId: owner._id.toString() });
    expect(regRes.status).toBe(201);
    const regId = regRes.body.data._id;

    // Anonymous cancel (no owner proof) -> 400; stranger cancel -> 403.
    const anonRes = await request(app).delete(`/api/v1/registrations/${regId}`);
    expect(anonRes.status).toBe(400);
    const strangerRes = await request(app)
      .delete(`/api/v1/registrations/${regId}`)
      .send({ volunteerId: stranger._id.toString() });
    expect(strangerRes.status).toBe(403);

    // Owner cancel still works.
    const ownerRes = await request(app)
      .delete(`/api/v1/registrations/${regId}`)
      .send({ volunteerId: owner._id.toString() });
    expect(ownerRes.status).toBe(200);
  });
});
