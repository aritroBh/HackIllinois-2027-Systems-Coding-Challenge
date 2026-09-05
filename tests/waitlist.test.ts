import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';

describe('Autonomous FIFO Waitlist Cascade Engine', () => {
  it('automatically promotes the #1 waitlist candidate when a confirmed volunteer cancels', async () => {
    // 1. Create a shift with capacity = 1
    const shift = await Shift.create({
      title: 'Solo Hardware Monitor',
      description: 'Single monitor required',
      category: ShiftCategory.HARDWARE_LAB,
      location: 'ECEB',
      startTime: new Date(Date.now() + 3600000),
      endTime: new Date(Date.now() + 7200000),
      capacity: 1,
      filledSlots: 0,
      waitlistCount: 0,
    });

    const vol1 = await Volunteer.create({ name: 'Volunteer One', email: 'vol1@illinois.edu' });
    const vol2 = await Volunteer.create({ name: 'Volunteer Two', email: 'vol2@illinois.edu' });
    const vol3 = await Volunteer.create({ name: 'Volunteer Three', email: 'vol3@illinois.edu' });

    // 2. Vol1 claims the only slot -> CONFIRMED
    const res1 = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift._id.toString(), volunteerId: vol1._id.toString() });
    expect(res1.status).toBe(201);
    expect(res1.body.status).toBe(RegistrationStatus.CONFIRMED);
    const reg1Id = res1.body.data._id;

    // 3. Vol2 tries to register -> Shift is full -> WAITLISTED (Position 1)
    const res2 = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift._id.toString(), volunteerId: vol2._id.toString() });
    expect(res2.status).toBe(201);
    expect(res2.body.status).toBe(RegistrationStatus.WAITLISTED);
    expect(res2.body.waitlistPosition).toBe(1);

    // 4. Vol3 tries to register -> WAITLISTED (Position 2)
    const res3 = await request(app)
      .post('/api/v1/registrations')
      .send({ shiftId: shift._id.toString(), volunteerId: vol3._id.toString() });
    expect(res3.status).toBe(201);
    expect(res3.body.status).toBe(RegistrationStatus.WAITLISTED);
    expect(res3.body.waitlistPosition).toBe(2);

    // Verify shift counters
    let updatedShift = await Shift.findById(shift._id);
    expect(updatedShift?.filledSlots).toBe(1);
    expect(updatedShift?.waitlistCount).toBe(2);

    // 5. Vol1 cancels their confirmed registration
    const cancelRes = await request(app).delete(
      `/api/v1/registrations/${reg1Id}?volunteerId=${vol1._id.toString()}`
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.promoted).toBeDefined();

    // 6. Assert Vol2 was automatically promoted to CONFIRMED!
    const vol2Reg = await Registration.findOne({ volunteerId: vol2._id, shiftId: shift._id });
    expect(vol2Reg?.status).toBe(RegistrationStatus.CONFIRMED);
    expect(vol2Reg?.waitlistPosition).toBeNull();

    // 7. Assert Vol3 was reindexed from Position 2 down to Position 1!
    const vol3Reg = await Registration.findOne({ volunteerId: vol3._id, shiftId: shift._id });
    expect(vol3Reg?.status).toBe(RegistrationStatus.WAITLISTED);
    expect(vol3Reg?.waitlistPosition).toBe(1);

    // Shift counters must reflect exactly 1 filled, 1 waitlisted
    updatedShift = await Shift.findById(shift._id);
    expect(updatedShift?.filledSlots).toBe(1);
    expect(updatedShift?.waitlistCount).toBe(1);
  });
});
