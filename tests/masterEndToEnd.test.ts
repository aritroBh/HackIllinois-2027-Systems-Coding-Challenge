import request from 'supertest';
import { app } from '../src/app';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { Gym, Faction } from '../src/models/gym.model';
import { HackStop } from '../src/models/hackstop.model';
import { PowerUpInventory } from '../src/models/powerup.model';
import { SOSTicketCategory, SOSTicketUrgency, SOSTicketStatus } from '../src/models/sosTicket.model';
import { CheckInService } from '../src/services/checkin.service';
import { SOSService } from '../src/services/sos.service';
import { GymService } from '../src/services/gym.service';
import { HackStopService } from '../src/services/hackstop.service';
import { AdonixSyncService } from '../src/services/adonixSync.service';
import { HACKILLINOIS_VENUES } from '../src/common/utils/geo';

describe('WaveShift Nexus: 10-System Master Hackathon Operations Simulation', () => {
  it('executes the full hackathon operations lifecycle across all 10 subsystems end-to-end', async () => {
    const timestamp = Date.now();

    // =========================================================================
    // SYSTEM 1: LIVE ADONIX SYNC & SHIFT SYNTHESIS
    // =========================================================================
    const syncRes = await AdonixSyncService.syncOfficialEvents();
    expect(syncRes.syncedCount).toBeGreaterThan(0);

    const mealShift = await Shift.findOne({ category: ShiftCategory.FOOD });
    expect(mealShift).not.toBeNull();
    expect(mealShift!.capacity).toBeGreaterThanOrEqual(1);

    // =========================================================================
    // SYSTEM 2: VOLUNTEER ONBOARDING & REST BUFFER / FATIGUE CHECK
    // =========================================================================
    const volAda = await Volunteer.create({
      name: 'Ada Lovelace',
      email: `ada_${timestamp}@illinois.edu`,
      certifications: ['HARDWARE', 'FOOD_HANDLING', 'FIRST_AID'],
      karmaPoints: 100,
    });

    const volAlan = await Volunteer.create({
      name: 'Alan Turing',
      email: `alan_${timestamp}@illinois.edu`,
      certifications: ['HARDWARE', 'FOOD_HANDLING'],
      karmaPoints: 100,
    });

    // The shift is in progress, not upcoming. Check-in is only accepted within half an hour
    // either side of a shift (checkin.service.ts), and this simulation scans a token in the
    // same breath as it creates the shift — a fixture that starts an hour from now would be
    // refused for the time before the geofence it is actually testing ever ran.
    const shift1Start = new Date(timestamp - 600000);  // T-10m: started, still running
    const shift1End = new Date(timestamp + 3000000);   // T+50m

    const shiftConflictStart = new Date(timestamp + 3300000); // 5m after shift 1 ends (breaks the 30m buffer!)
    const shiftConflictEnd = new Date(timestamp + 6900000);

    const testShift1 = await Shift.create({
      title: 'Midnight Snack Distribution',
      description: 'Hand out Insomnia cookies and Red Bull',
      category: ShiftCategory.FOOD,
      location: 'SIEBEL_ATRIUM',
      startTime: shift1Start,
      endTime: shift1End,
      capacity: 1, // Only 1 spot!
      filledSlots: 0,
      waitlistCount: 0,
    });

    const testShiftConflict = await Shift.create({
      title: 'Post-Snack Logistics Clean',
      description: 'Clean atrium tables',
      category: ShiftCategory.LOGISTICS,
      location: 'SIEBEL_ATRIUM',
      startTime: shiftConflictStart,
      endTime: shiftConflictEnd,
      capacity: 2,
    });

    // Register Ada for Shift 1
    const regRes1 = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', `e2e_ada_shift1_${timestamp}`)
      .send({ shiftId: testShift1._id.toString(), volunteerId: volAda._id.toString() });
    expect(regRes1.status).toBe(201);
    expect(regRes1.body.status).toBe(RegistrationStatus.CONFIRMED);

    // Attempt to register Ada for conflicting Shift (must fail with 409 Buffer Conflict)
    const conflictRes = await request(app)
      .post('/api/v1/registrations')
      .set('idempotency-key', `e2e_ada_conflict_${timestamp}`)
      .send({ shiftId: testShiftConflict._id.toString(), volunteerId: volAda._id.toString() });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error).toBe('SCHEDULE_BUFFER_CONFLICT');

    // =========================================================================
    // SYSTEM 3: CONCURRENCY BOMB & ANTI-OVERSELLING CAS INVARIANT
    // =========================================================================
    // 20 concurrent volunteers hit a 1-slot shift (testShift1 already has Ada confirmed)
    const workerVolunteers = await Volunteer.insertMany(
      Array.from({ length: 19 }).map((_, i) => ({
        name: `E2E Worker ${i}`,
        email: `worker_${i}_${timestamp}@illinois.edu`,
        certifications: ['FOOD_HANDLING'],
        karmaPoints: 50,
      }))
    );

    const contenders = [volAlan, ...workerVolunteers];
    await Promise.all(
      contenders.map((v, i) =>
        request(app)
          .post('/api/v1/registrations')
          .set('idempotency-key', `bomb_${i}_${timestamp}`)
          .send({ shiftId: testShift1._id.toString(), volunteerId: v._id.toString() })
      )
    );

    // Assert strictly: 1 confirmed (Ada), 20 waitlisted, 0 oversold
    const confirmedCount = await Registration.countDocuments({
      shiftId: testShift1._id,
      status: RegistrationStatus.CONFIRMED,
    });
    const waitlistedCount = await Registration.countDocuments({
      shiftId: testShift1._id,
      status: RegistrationStatus.WAITLISTED,
    });

    expect(confirmedCount).toBe(1);
    expect(waitlistedCount).toBe(20);

    const refreshedShift1 = await Shift.findById(testShift1._id);
    expect(refreshedShift1?.filledSlots).toBe(1);
    expect(refreshedShift1?.waitlistCount).toBe(20);

    // =========================================================================
    // SYSTEM 4: DYNAMIC 30S HMAC-SHA256 ATTENDANCE TOKEN & ANTI-REPLAY
    // =========================================================================
    const tokenRes = await CheckInService.generateToken(
      volAda._id.toString(),
      testShift1._id.toString()
    );
    expect(tokenRes.token).toBeDefined();
    expect(tokenRes.token.split('.')).toHaveLength(2); // payload.signature
    expect(tokenRes.expiresInSeconds).toBeGreaterThan(0);

    // =========================================================================
    // SYSTEM 5: SPATIAL GEOFENCING & HAVERSINE CHECK-IN
    // =========================================================================
    // Check-in from Kenney Gym (>250m away from Siebel) -> MUST BE REJECTED
    await expect(
      CheckInService.verifyAndCheckIn(tokenRes.token, 'SCANNER_DESK_01', HACKILLINOIS_VENUES.KENNEY_GYM)
    ).rejects.toThrow(/Geofence Check-In Denied/i);

    // Generate a fresh dynamic token and check in at Siebel (<5m away)
    const freshTokenRes = await CheckInService.generateToken(
      volAda._id.toString(),
      testShift1._id.toString()
    );
    const siebelCoords = { latitude: 40.113815, longitude: -88.224935 };
    const checkInSuccess = await CheckInService.verifyAndCheckIn(
      freshTokenRes.token,
      'SCANNER_DESK_01',
      siebelCoords
    );
    expect(checkInSuccess.checkIn).toBeDefined();
    expect(checkInSuccess.geofenceStatus?.passed).toBe(true);

    const adaReg = await Registration.findById(regRes1.body.data._id);
    expect(adaReg?.status).toBe(RegistrationStatus.CHECKED_IN);

    // Attempt to replay the exact same token -> MUST BE REJECTED
    await expect(
      CheckInService.verifyAndCheckIn(freshTokenRes.token, 'SCANNER_DESK_01', siebelCoords)
    ).rejects.toThrow(/Token replay attack detected/i);

    // =========================================================================
    // SYSTEM 6: CANCELLATION & AUTONOMOUS FIFO WAITLIST CASCADE PROMOTION
    // =========================================================================
    // Head of waitlist candidate is Alan (waitlistPosition = 1)
    const headWaitlist = await Registration.findOne({
      shiftId: testShift1._id,
      status: RegistrationStatus.WAITLISTED,
      waitlistPosition: 1,
    });
    expect(headWaitlist).not.toBeNull();

    // Ada cancels her registration
    const cancelRes = await request(app).delete(
      `/api/v1/registrations/${adaReg!._id}?volunteerId=${volAda._id.toString()}`
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.promoted).not.toBeNull();
    expect(cancelRes.body.data.promoted.volunteerId.toString()).toBe(headWaitlist!.volunteerId.toString());

    // Verify candidate was promoted autonomously to CONFIRMED
    const promotedCandidate = await Registration.findById(headWaitlist!._id);
    expect(promotedCandidate?.status).toBe(RegistrationStatus.CONFIRMED);
    expect(promotedCandidate?.waitlistPosition).toBeNull();

    // Verify shift filled slots remain strictly 1
    const shiftAfterCascade = await Shift.findById(testShift1._id);
    expect(shiftAfterCascade?.filledSlots).toBe(1);
    expect(shiftAfterCascade?.waitlistCount).toBe(19);

    // =========================================================================
    // SYSTEM 7: BILATERAL SHIFT SWAP
    // =========================================================================
    const shift3 = await Shift.create({
      title: 'Mentor Help Desk',
      description: 'Assist hardware hackers',
      category: ShiftCategory.MENTOR_SUPPORT,
      location: 'SIEBEL_ATRIUM',
      startTime: new Date(timestamp + 14400000),
      endTime: new Date(timestamp + 18000000),
      capacity: 2,
      filledSlots: 1,
    });

    const adaRegShift3 = await Registration.create({
      shiftId: shift3._id,
      volunteerId: volAda._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: `swap_seed_ada_${timestamp}`,
    });

    const alanRegConflict = await Registration.create({
      shiftId: testShiftConflict._id,
      volunteerId: volAlan._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: `swap_seed_alan_${timestamp}`,
    });

    expect(adaRegShift3._id).toBeDefined();
    expect(alanRegConflict._id).toBeDefined();

    const swapRes = await request(app)
      .post('/api/v1/swaps')
      .send({
        proposerVolunteerId: volAda._id.toString(),
        proposerShiftId: shift3._id.toString(),
        targetVolunteerId: volAlan._id.toString(),
        targetShiftId: testShiftConflict._id.toString(),
      });
    expect(swapRes.status).toBe(201);
    expect(swapRes.body.data.status).toBe('PENDING');

    const acceptRes = await request(app)
      .post(`/api/v1/swaps/${swapRes.body.data._id}/accept`)
      .send({ targetVolunteerId: volAlan._id.toString() });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.data.status).toBe('EXECUTED');

    // =========================================================================
    // SYSTEM 8: HACKER SOS EMERGENCY SPATIAL DISPATCH & IDEMPOTENT RESOLUTION
    // =========================================================================
    // Hacker reports FPGA power failure at Siebel Basement Lab
    const ticket = await SOSService.createTicket({
      hackerName: 'Grace Hopper',
      tableLocation: 'Siebel Basement Lab 0220',
      coordinates: HACKILLINOIS_VENUES.SIEBEL_BASEMENT,
      category: SOSTicketCategory.HARDWARE_MALFUNCTION,
      description: 'FPGA development board power rail failure.',
      urgency: SOSTicketUrgency.CRITICAL,
      requiredSkill: 'HARDWARE',
      karmaBounty: 300,
    });
    expect(ticket.status).toBe(SOSTicketStatus.OPEN);

    // Spatial dispatch selects nearest candidate on duty with HARDWARE certification
    const dispatchRes = await SOSService.dispatchNearestVolunteer(ticket._id.toString());
    expect(dispatchRes.ticket.status).toBe(SOSTicketStatus.DISPATCHED);
    expect(dispatchRes.distanceMeters).toBeLessThan(100);

    // Resolve SOS ticket and award Karma bounty (assignee-bound: only the
    // dispatched volunteer may resolve — the old test resolved as a bystander).
    const assigneeId = dispatchRes.ticket.assignedVolunteerId!.toString();
    const resolvedTicket = await SOSService.resolveTicket(
      ticket._id.toString(),
      assigneeId
    );
    expect(resolvedTicket.status).toBe(SOSTicketStatus.RESOLVED);

    // Double resolution must be rejected idempotently
    await expect(
      SOSService.resolveTicket(ticket._id.toString(), assigneeId)
    ).rejects.toThrow(/already resolved/i);

    // =========================================================================
    // SYSTEM 9: POKÉSHIFT CAMPUS GYM TURF WARS (OCC Versioning Invariant)
    // =========================================================================
    const siebelGym = await Gym.create({
      name: 'Siebel Cyber Bastion',
      locationName: 'Siebel Center',
      latitude: HACKILLINOIS_VENUES.SIEBEL_ATRIUM.latitude,
      longitude: HACKILLINOIS_VENUES.SIEBEL_ATRIUM.longitude,
      controllingFaction: Faction.TEAM_KERNEL,
      controlPoints: 100,
      maxControlPoints: 1000,
      version: 0,
    });

    // Ada attacks for TEAM_TENSOR with 150 power -> Overthrows and captures the gym!
    const battleRes = await GymService.battleOrContribute(
      siebelGym._id.toString(),
      volAda._id.toString(),
      Faction.TEAM_TENSOR,
      150,
      HACKILLINOIS_VENUES.SIEBEL_ATRIUM
    );
    expect(battleRes.action).toBe('CAPTURED');
    expect(battleRes.controllingFaction).toBe(Faction.TEAM_TENSOR);
    expect(battleRes.leaderName).toBe(volAda.name);

    const gymInDb = await Gym.findById(siebelGym._id);
    expect(gymInDb?.controllingFaction).toBe(Faction.TEAM_TENSOR);
    expect(gymInDb?.version).toBeGreaterThan(0); // OCC version incremented!

    // =========================================================================
    // SYSTEM 10: HACKSTOP BEACON SPINS & POWER-UP CAS INVENTORY CONSUMPTION
    // =========================================================================
    const hackStop = await HackStop.create({
      beaconId: `BEACON_MASTER_${timestamp}`,
      name: 'ACM Student Chapter Supply Terminal',
      locationName: 'Siebel 1100',
      latitude: HACKILLINOIS_VENUES.SIEBEL_ATRIUM.latitude,
      longitude: HACKILLINOIS_VENUES.SIEBEL_ATRIUM.longitude,
      cooldownSeconds: 300,
      geofenceRadiusMeters: 75,
    });

    // 1st Spin within 75m -> Success
    const spinRes = await HackStopService.spinBeacon(
      hackStop.beaconId,
      volAda._id.toString(),
      HACKILLINOIS_VENUES.SIEBEL_ATRIUM
    );
    expect(spinRes.awardedKarma).toBeGreaterThan(0);
    expect(spinRes.awardedPowerUp).toBeDefined();

    // 2nd Immediate Spin -> Cooldown Rejection
    await expect(
      HackStopService.spinBeacon(
        hackStop.beaconId,
        volAda._id.toString(),
        HACKILLINOIS_VENUES.SIEBEL_ATRIUM
      )
    ).rejects.toThrow(/cooling down/i);

    // Consume Power-Up from Inventory (Atomic CAS Decrement)
    const invItem = await PowerUpInventory.findOne({
      volunteerId: volAda._id,
      itemType: spinRes.awardedPowerUp,
    });
    expect(invItem?.quantity).toBe(1);

    const useRes = await HackStopService.usePowerUp(
      volAda._id.toString(),
      spinRes.awardedPowerUp,
      ['OVERCLOCK_SOLDER_CORE', 'INSOMNIA_COOKIE_SHIELD'].includes(spinRes.awardedPowerUp)
        ? siebelGym._id.toString()
        : undefined
    );
    expect(useRes.remainingQuantity).toBe(0);

    const emptyInv = await PowerUpInventory.findOne({
      volunteerId: volAda._id,
      itemType: spinRes.awardedPowerUp,
    });
    expect(emptyInv?.quantity).toBe(0);

    // Attempting to consume again must fail
    await expect(
      HackStopService.usePowerUp(
        volAda._id.toString(),
        spinRes.awardedPowerUp,
        ['OVERCLOCK_SOLDER_CORE', 'INSOMNIA_COOKIE_SHIELD'].includes(spinRes.awardedPowerUp)
          ? siebelGym._id.toString()
          : undefined
      )
    ).rejects.toThrow(/Insufficient inventory/i);
  }, 45000);
});
