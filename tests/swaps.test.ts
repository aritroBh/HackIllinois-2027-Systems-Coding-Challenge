import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { ShiftSwap, SwapStatus } from '../src/models/swap.model';

describe('Shift Swap & Tarjan Multi-Party Cyclic Trade Engine', () => {
  it('executes a bilateral 1-to-1 swap atomically', async () => {
    const volA = await Volunteer.create({ name: 'Alice', email: 'alice_swap@illinois.edu' });
    const volB = await Volunteer.create({ name: 'Bob', email: 'bob_swap@illinois.edu' });

    const shift1 = await Shift.create({
      title: 'Shift Morning',
      description: 'Morning',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel',
      startTime: new Date('2027-02-27T08:00:00Z'),
      endTime: new Date('2027-02-27T10:00:00Z'),
      capacity: 1,
    });

    const shift2 = await Shift.create({
      title: 'Shift Evening',
      description: 'Evening',
      category: ShiftCategory.LOGISTICS,
      location: 'ECEB',
      startTime: new Date('2027-02-27T18:00:00Z'),
      endTime: new Date('2027-02-27T20:00:00Z'),
      capacity: 1,
    });

    // VolA holds Shift 1; VolB holds Shift 2
    await Registration.create({
      shiftId: shift1._id,
      volunteerId: volA._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'swap_reg_1',
    });
    await Registration.create({
      shiftId: shift2._id,
      volunteerId: volB._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'swap_reg_2',
    });

    // 1. VolA proposes swap to VolB
    const proposeRes = await request(app)
      .post('/api/v1/swaps')
      .send({
        proposerVolunteerId: volA._id.toString(),
        proposerShiftId: shift1._id.toString(),
        targetVolunteerId: volB._id.toString(),
        targetShiftId: shift2._id.toString(),
      });
    expect(proposeRes.status).toBe(201);
    const swapId = proposeRes.body.data._id;

    // 2. VolB accepts swap
    const acceptRes = await request(app)
      .post(`/api/v1/swaps/${swapId}/accept`)
      .send({ targetVolunteerId: volB._id.toString() });

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.data.status).toBe(SwapStatus.EXECUTED);

    // 3. Verify ownerships swapped in registrations
    const newOwner1 = await Registration.findOne({ shiftId: shift1._id });
    const newOwner2 = await Registration.findOne({ shiftId: shift2._id });

    expect(newOwner1?.volunteerId.toString()).toBe(volB._id.toString());
    expect(newOwner2?.volunteerId.toString()).toBe(volA._id.toString());
  });

  it('detects and executes a 3-way circular trade (Alice -> Bob -> Charlie -> Alice)', async () => {
    const volA = await Volunteer.create({ name: 'Alice Cycle', email: 'alice_c@illinois.edu' });
    const volB = await Volunteer.create({ name: 'Bob Cycle', email: 'bob_c@illinois.edu' });
    const volC = await Volunteer.create({ name: 'Charlie Cycle', email: 'charlie_c@illinois.edu' });

    const s1 = await Shift.create({
      title: 'Shift 1',
      description: 'S1',
      category: ShiftCategory.LOGISTICS,
      location: 'L1',
      startTime: new Date('2027-02-27T08:00:00Z'),
      endTime: new Date('2027-02-27T10:00:00Z'),
      capacity: 1,
    });
    const s2 = await Shift.create({
      title: 'Shift 2',
      description: 'S2',
      category: ShiftCategory.FOOD,
      location: 'L2',
      startTime: new Date('2027-02-27T12:00:00Z'),
      endTime: new Date('2027-02-27T14:00:00Z'),
      capacity: 1,
    });
    const s3 = await Shift.create({
      title: 'Shift 3',
      description: 'S3',
      category: ShiftCategory.INFO_DESK,
      location: 'L3',
      startTime: new Date('2027-02-27T16:00:00Z'),
      endTime: new Date('2027-02-27T18:00:00Z'),
      capacity: 1,
    });

    // Assign: A holds S1, B holds S2, C holds S3
    await Registration.create({ shiftId: s1._id, volunteerId: volA._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: 'c1' });
    await Registration.create({ shiftId: s2._id, volunteerId: volB._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: 'c2' });
    await Registration.create({ shiftId: s3._id, volunteerId: volC._id, status: RegistrationStatus.CONFIRMED, idempotencyKey: 'c3' });

    // Trade Desires:
    // A wants S2
    // B wants S3
    // C wants S1
    await ShiftSwap.create([
      { proposerVolunteerId: volA._id, proposerShiftId: s1._id, targetShiftId: s2._id, desiredShiftIds: [s2._id], status: SwapStatus.PENDING },
      { proposerVolunteerId: volB._id, proposerShiftId: s2._id, targetShiftId: s3._id, desiredShiftIds: [s3._id], status: SwapStatus.PENDING },
      { proposerVolunteerId: volC._id, proposerShiftId: s3._id, targetShiftId: s1._id, desiredShiftIds: [s1._id], status: SwapStatus.PENDING },
    ]);

    // Trigger cycle resolution endpoint
    const res = await request(app).post('/api/v1/swaps/cycles/resolve');
    expect(res.status).toBe(200);
    expect(res.body.data.discoveredCycles.length).toBeGreaterThan(0);
    expect(res.body.data.executedCount).toBe(1);

    // Verify all 3 registrations rotated:
    // S1 should now be held by C (who wanted S1)
    // S2 should now be held by A (who wanted S2)
    // S3 should now be held by B (who wanted S3)
    const regS1 = await Registration.findOne({ shiftId: s1._id });
    const regS2 = await Registration.findOne({ shiftId: s2._id });
    const regS3 = await Registration.findOne({ shiftId: s3._id });

    expect(regS1?.volunteerId.toString()).toBe(volC._id.toString());
    expect(regS2?.volunteerId.toString()).toBe(volA._id.toString());
    expect(regS3?.volunteerId.toString()).toBe(volB._id.toString());
  });
});
