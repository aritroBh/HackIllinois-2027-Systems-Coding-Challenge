import { GeoEngine, HACKILLINOIS_VENUES } from '../src/common/utils/geo';
import { SOSService } from '../src/services/sos.service';
import { SOSTicketCategory, SOSTicketUrgency, SOSTicketStatus } from '../src/models/sosTicket.model';
import { Volunteer } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { CheckInService } from '../src/services/checkin.service';
import { AdonixSyncService } from '../src/services/adonixSync.service';


describe('Spatial Geofencing & Haversine Distance Engine', () => {
  it('correctly calculates Haversine distance between Siebel Center and ECEB', () => {
    const siebel = HACKILLINOIS_VENUES.SIEBEL_ATRIUM;
    const eceb = HACKILLINOIS_VENUES.ECEB_LOBBY;

    const distance = GeoEngine.haversineDistanceMeters(siebel, eceb);
    // Siebel Atrium to ECEB Lobby is ~280-290 meters
    expect(distance).toBeGreaterThan(250);
    expect(distance).toBeLessThan(320);
  });

  it('enforces 75-meter geofence radius boundary correctly', () => {
    const siebel = HACKILLINOIS_VENUES.SIEBEL_ATRIUM;
    const insideCoords = { latitude: 40.113820, longitude: -88.224930 }; // ~2 meters away
    const outsideCoords = HACKILLINOIS_VENUES.KENNEY_GYM; // ~270 meters away

    const insideCheck = GeoEngine.isWithinGeofence(insideCoords, siebel, 75);
    expect(insideCheck.allowed).toBe(true);
    expect(insideCheck.distanceMeters).toBeLessThan(10);

    const outsideCheck = GeoEngine.isWithinGeofence(outsideCoords, siebel, 75);
    expect(outsideCheck.allowed).toBe(false);
    expect(outsideCheck.distanceMeters).toBeGreaterThan(75);
  });

  it('rejects check-in if volunteer is outside the geofence perimeter', async () => {
    const vol = await Volunteer.create({
      name: 'Drifting Volunteer',
      email: 'drift@illinois.edu',
      role: 'VOLUNTEER',
      certifications: ['FIRST_AID'],
    });

    const shift = await Shift.create({
      title: 'Siebel Welcome Desk',
      description: 'Front desk operations',
      category: ShiftCategory.INFO_DESK,
      location: 'SIEBEL_ATRIUM',
      startTime: new Date(Date.now() - 1000 * 60 * 10),
      endTime: new Date(Date.now() + 1000 * 60 * 60),
      capacity: 3,
      filledSlots: 1,
    });

    await Registration.create({
      volunteerId: vol._id,
      shiftId: shift._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'drift_reg_01',
    });

    const { token } = await CheckInService.generateToken(vol._id.toString(), shift._id.toString());

    // Check-in from Kenney Gym (outside 75m geofence for SIEBEL_ATRIUM)
    await expect(
      CheckInService.verifyAndCheckIn(token, 'SCANNER_01', HACKILLINOIS_VENUES.KENNEY_GYM)
    ).rejects.toThrow(/Geofence Check-In Denied/);

    // Generate a fresh token (each dynamic HMAC token is single-use to prevent replay attacks)
    const freshTokenRes = await CheckInService.generateToken(vol._id.toString(), shift._id.toString());

    // Check-in with valid coordinates near Siebel
    const validCoords = { latitude: 40.113815, longitude: -88.224935 };
    const success = await CheckInService.verifyAndCheckIn(freshTokenRes.token, 'SCANNER_01', validCoords);
    expect(success.checkIn).toBeDefined();
    expect(success.geofenceStatus?.passed).toBe(true);
  });
});

describe('Hacker SOS Emergency Ticket & Spatial Dispatch Engine', () => {
  it('dispatches the nearest on-duty volunteer with matching skill certification', async () => {
    // 1. Volunteer A: at Kenney Gym with HARDWARE certification
    const volA = await Volunteer.create({
      name: 'Far Hardware Expert',
      email: 'vol_far@illinois.edu',
      certifications: ['HARDWARE'],
      karmaPoints: 100,
    });

    // 2. Volunteer B: at Siebel Atrium with HARDWARE certification (Closer!)
    const volB = await Volunteer.create({
      name: 'Close Hardware Expert',
      email: 'vol_close@illinois.edu',
      certifications: ['HARDWARE'],
      karmaPoints: 200,
    });

    // 3. Volunteer C: at Siebel Atrium but NO hardware certification
    const volC = await Volunteer.create({
      name: 'Close No Skill',
      email: 'vol_noskill@illinois.edu',
      certifications: ['CROWD_CONTROL'],
      karmaPoints: 500,
    });

    const shiftSiebel = await Shift.create({
      title: 'Siebel Atrium Logistics',
      description: 'Atrium desk',
      category: ShiftCategory.LOGISTICS,
      location: 'SIEBEL_ATRIUM',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      capacity: 5,
    });

    const shiftKenney = await Shift.create({
      title: 'Kenney Swag Dist',
      description: 'Kenney Gym',
      category: ShiftCategory.LOGISTICS,
      location: 'KENNEY_GYM',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      capacity: 5,
    });

    // Mark all three checked-in
    await Registration.create({
      volunteerId: volA._id,
      shiftId: shiftKenney._id,
      status: RegistrationStatus.CHECKED_IN,
      idempotencyKey: 'reg_kenney_a',
    });
    await Registration.create({
      volunteerId: volB._id,
      shiftId: shiftSiebel._id,
      status: RegistrationStatus.CHECKED_IN,
      idempotencyKey: 'reg_siebel_b',
    });
    await Registration.create({
      volunteerId: volC._id,
      shiftId: shiftSiebel._id,
      status: RegistrationStatus.CHECKED_IN,
      idempotencyKey: 'reg_siebel_c',
    });

    // Create SOS Ticket in Siebel Atrium needing HARDWARE
    const ticket = await SOSService.createTicket({
      hackerName: 'Stuck Hacker',
      tableLocation: 'Table 42 (Siebel Basement)',
      coordinates: HACKILLINOIS_VENUES.SIEBEL_BASEMENT,
      category: SOSTicketCategory.HARDWARE_MALFUNCTION,
      description: 'Soldering iron shorted out, need backup ESP32 board immediately.',
      urgency: SOSTicketUrgency.HIGH,
      requiredSkill: 'HARDWARE',
      karmaBounty: 250,
    });

    expect(ticket.status).toBe(SOSTicketStatus.OPEN);

    // Dispatch nearest volunteer
    const dispatchResult = await SOSService.dispatchNearestVolunteer(ticket._id.toString());
    expect(dispatchResult.ticket.status).toBe(SOSTicketStatus.DISPATCHED);
    // Vol B should be selected because Vol B is at Siebel (closer than Kenney) and has HARDWARE (unlike Vol C)
    expect((dispatchResult.dispatchedVolunteer as any)._id.toString()).toBe(volB._id.toString());
    expect(dispatchResult.distanceMeters).toBeLessThan(50);

    // Resolve ticket and award karma bounty
    const resolvedTicket = await SOSService.resolveTicket(ticket._id.toString(), volB._id.toString());
    expect(resolvedTicket.status).toBe(SOSTicketStatus.RESOLVED);

    const updatedVolB = await Volunteer.findById(volB._id);
    expect(updatedVolB?.karmaPoints).toBe(200 + 250);
    expect(updatedVolB?.badges).toContain('FIRST_RESPONDER');
  });
});

describe('HackIllinois Official Adonix Sync Integration', () => {
  it('synchronizes official HackIllinois events and synthesizes volunteer shifts', async () => {
    const result = await AdonixSyncService.syncOfficialEvents();
    expect(result.syncedCount).toBeGreaterThan(0);
    expect(result.events.length).toBe(result.syncedCount);

    const openingShift = await Shift.findOne({ title: /Opening Ceremony/i });
    expect(openingShift).toBeDefined();
    expect(openingShift?.capacity).toBeGreaterThanOrEqual(2);

    const mealShift = await Shift.findOne({ title: /Cookies|Dinner|Meal/i });
    expect(mealShift).toBeDefined();
    expect(mealShift?.category).toBe(ShiftCategory.FOOD);
  });
});
