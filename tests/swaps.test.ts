import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { ShiftSwap, SwapStatus } from '../src/models/swap.model';

describe('Shift Swap & Multi-Party Cyclic Trade Engine', () => {
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

describe('a volunteer may have more than one shift on the table', () => {
  /**
   * The trade graph used to be keyed by volunteer, but the thing being traded is an
   * *offer* — a volunteer together with the shift they are putting up. A volunteer holding
   * two shifts with a pending proposal against each is two separate things to trade, with
   * different counterparties.
   *
   * Collapsing them onto one node lost exactly the fact the executor needed. Building the
   * adjacency list wrote `adj.set(volunteerId, …)` once per proposal, so the first
   * proposal's edges were silently overwritten by the second's; execution then resolved
   * that volunteer's shift with `pendingSwaps.find(...)`, which returns the **first**
   * match. The edge that formed the ring and the shift that got rotated came from different
   * proposals, so somebody could be moved off a shift they had only ever offered in
   * exchange for something else — and the proposal that actually got what it asked for
   * stayed PENDING and could be resolved again.
   */
  async function shiftAt(title: string, hourOffset: number) {
    const start = new Date(Date.UTC(2027, 1, 27, 8 + hourOffset, 0, 0));
    return Shift.create({
      title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: start, endTime: new Date(start.getTime() + 2 * 3600_000), capacity: 1,
    });
  }

  it('rotates the shift the ring was actually formed on, not whichever proposal came first', async () => {
    const vera = await Volunteer.create({ name: 'Vera', email: 'vera_two@illinois.edu' });
    const wes = await Volunteer.create({ name: 'Wes', email: 'wes_two@illinois.edu' });

    // Vera holds two shifts far enough apart that holding both is legal.
    const veraMorning = await shiftAt('Vera Morning', 0);   // 08:00
    const veraEvening = await shiftAt('Vera Evening', 9);   // 17:00
    const wesMidday = await shiftAt('Wes Midday', 4);       // 12:00

    for (const [shift, vol, key] of [
      [veraMorning, vera, 'two_1'], [veraEvening, vera, 'two_2'], [wesMidday, wes, 'two_3'],
    ] as const) {
      await Registration.create({
        shiftId: shift._id, volunteerId: vol._id,
        status: RegistrationStatus.CONFIRMED, idempotencyKey: key,
      });
    }

    // Vera's FIRST proposal offers her morning shift for something nobody holds, so it can
    // form no ring. Her SECOND offers her evening shift for Wes's midday, and Wes wants her
    // evening back — that pair is the only real ring here.
    const orphan = await shiftAt('Nobody Holds This', 20);
    await ShiftSwap.create([
      { proposerVolunteerId: vera._id, proposerShiftId: veraMorning._id, targetShiftId: orphan._id, desiredShiftIds: [orphan._id], status: SwapStatus.PENDING },
      { proposerVolunteerId: vera._id, proposerShiftId: veraEvening._id, targetShiftId: wesMidday._id, desiredShiftIds: [wesMidday._id], status: SwapStatus.PENDING },
      { proposerVolunteerId: wes._id, proposerShiftId: wesMidday._id, targetShiftId: veraEvening._id, desiredShiftIds: [veraEvening._id], status: SwapStatus.PENDING },
    ]);

    const res = await request(app).post('/api/v1/swaps/cycles/resolve').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.executedCount).toBe(1);

    // The ring was Vera's *evening* shift for Wes's midday. Her morning shift must not have
    // moved — that is the one the old code rotated.
    const morning = await Registration.findOne({ shiftId: veraMorning._id, status: RegistrationStatus.CONFIRMED });
    expect(String(morning!.volunteerId)).toBe(String(vera._id));

    const evening = await Registration.findOne({ shiftId: veraEvening._id, status: RegistrationStatus.CONFIRMED });
    expect(String(evening!.volunteerId)).toBe(String(wes._id));

    const midday = await Registration.findOne({ shiftId: wesMidday._id, status: RegistrationStatus.CONFIRMED });
    expect(String(midday!.volunteerId)).toBe(String(vera._id));

    // And the proposal that was satisfied is the one marked EXECUTED, not the other one.
    const executed = await ShiftSwap.find({ status: SwapStatus.EXECUTED });
    expect(executed).toHaveLength(2);
    expect(executed.map((e) => String(e.proposerShiftId)).sort()).toEqual(
      [String(veraEvening._id), String(wesMidday._id)].sort()
    );
    const stillPending = await ShiftSwap.findOne({ status: SwapStatus.PENDING });
    expect(String(stillPending!.proposerShiftId)).toBe(String(veraMorning._id));
  });
});
