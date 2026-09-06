/**
 * The seeded demo is a deliverable, and it was never tested.
 *
 * `npm run demo` is the first thing anybody runs and the only thing most people will ever
 * see. Its scenario is hand-written data, and hand-written data drifts out of agreement
 * with the rules the services enforce without anything failing — the unit suites build
 * their own fixtures, so they keep passing while the demo quietly stops demonstrating.
 *
 * That is not hypothetical. The headline three-way trade ring (Alice wants Bob's shift,
 * Bob wants Charlie's, Charlie wants Alice's) was seeded so that two of its three legs
 * handed a volunteer a shift they were not certified for. Cycle detection found the ring
 * on every run and then correctly refused every leg, so `executedCount` was always 0 and
 * the feature the README leads with did nothing. Every swap test passed throughout.
 *
 * These tests assert the properties the demo is supposed to show, against the real seed.
 */
import { seedDatabase } from '../src/seed/seedData';
import { SwapService } from '../src/services/swap.service';
import { Volunteer } from '../src/models/volunteer.model';
import { Shift } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { ShiftSwap, SwapStatus } from '../src/models/swap.model';

describe('the seeded demo scenario', () => {
  // Per test, not once: the global `afterEach` in tests/setup.ts empties every collection
  // between tests, so a single `beforeAll` seed would leave every case after the first
  // asserting against an empty database — and passing, vacuously, which is exactly the
  // shape of test that let the broken ring survive in the first place.
  beforeEach(async () => {
    await seedDatabase();
  }, 60000);

  it('seeds a three-way trade ring whose every leg is actually executable', async () => {
    // The property that broke: each proposer must hold the certifications required by the
    // shift they are asking to receive. Asserted from the data rather than from the
    // resolver, so a failure names the leg rather than reporting "executedCount was 0".
    const swaps = await ShiftSwap.find({ status: SwapStatus.PENDING });
    expect(swaps.length).toBeGreaterThanOrEqual(3);

    for (const swap of swaps) {
      const [proposer, wanted] = await Promise.all([
        Volunteer.findById(swap.proposerVolunteerId),
        Shift.findById(swap.targetShiftId),
      ]);
      expect(proposer).not.toBeNull();
      expect(wanted).not.toBeNull();
      const missing = (wanted!.requiredSkills ?? []).filter(
        (skill) => !proposer!.certifications.includes(skill)
      );
      expect({ who: proposer!.name, wants: wanted!.title, missing }).toEqual({
        who: proposer!.name,
        wants: wanted!.title,
        missing: [],
      });
    }
  });

  it('resolves that ring into a real rotation, not a discovery with nothing behind it', async () => {
    // Holders per shift, as a set: the contested shift carries two, so "who holds this
    // shift" is not a single id.
    const holdersBefore = new Map<string, Set<string>>();
    for (const reg of await Registration.find({ status: RegistrationStatus.CONFIRMED })) {
      const key = String(reg.shiftId);
      if (!holdersBefore.has(key)) holdersBefore.set(key, new Set());
      holdersBefore.get(key)!.add(String(reg.volunteerId));
    }

    const result = await SwapService.discoverAndResolveCycles();

    // Finding the cycle was never the problem; executing it was.
    expect(result.discoveredCycles.length).toBeGreaterThanOrEqual(1);
    expect(result.executedCount).toBeGreaterThanOrEqual(1);

    const executed = await ShiftSwap.find({ status: SwapStatus.EXECUTED });
    expect(executed.length).toBeGreaterThanOrEqual(3);
    expect(await ShiftSwap.countDocuments({ status: SwapStatus.FAILED })).toBe(0);

    // And the rotation moved real seats. A rotation rewrites `volunteerId` in place, so
    // occupancy per shift must be unchanged while the holders differ — that pair is what
    // separates a real trade from a half-applied one.
    let movedShifts = 0;
    for (const [shiftId, before] of holdersBefore) {
      const now = await Registration.find({ shiftId, status: RegistrationStatus.CONFIRMED });
      expect({ shift: shiftId, holders: now.length }).toEqual({ shift: shiftId, holders: before.size });
      const after = new Set(now.map((r) => String(r.volunteerId)));
      if ([...after].some((id) => !before.has(id))) movedShifts += 1;
    }
    expect(movedShifts).toBeGreaterThanOrEqual(3);

    // Nobody was duplicated or dropped by the rotation: the multiset of holders across the
    // whole event is the same people it started with.
    const stillHolding = await Registration.find({ status: RegistrationStatus.CONFIRMED });
    expect(stillHolding.length).toBe([...holdersBefore.values()].reduce((n, s) => n + s.size, 0));
  });

  it('seeds a contested shift that is genuinely full with somebody waiting', async () => {
    const contested = await Shift.findOne({ waitlistCount: { $gt: 0 } });
    expect(contested).not.toBeNull();
    expect(contested!.filledSlots).toBe(contested!.capacity);
    const waiting = await Registration.countDocuments({
      shiftId: contested!._id,
      status: RegistrationStatus.WAITLISTED,
    });
    expect(waiting).toBe(contested!.waitlistCount);
  });

  it('never seeds a shift that is already oversold', async () => {
    for (const shift of await Shift.find({})) {
      expect(shift.filledSlots).toBeLessThanOrEqual(shift.capacity);
      const occupying = await Registration.countDocuments({
        shiftId: shift._id,
        status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
      });
      expect({ shift: shift.title, filled: shift.filledSlots }).toEqual({
        shift: shift.title,
        filled: occupying,
      });
    }
  });
});
