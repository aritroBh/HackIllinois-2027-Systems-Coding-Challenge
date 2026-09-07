import { GeoEngine, VENUE_COORDINATES, resolveVenue } from '../src/common/utils/geo';
import { uniqueKey } from './helpers/uniqueKey';
import { SOSService } from '../src/services/sos.service';
import { SOSTicketCategory, SOSTicketUrgency, SOSTicketStatus } from '../src/models/sosTicket.model';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { CheckInService } from '../src/services/checkin.service';
import { AdonixSyncService } from '../src/services/adonixSync.service';


describe('Campus venue resolution', () => {
  // Resolution scores by hint specificity rather than table order. Under the
  // old first-match rule these two resolved to a building over a kilometre
  // away ("ATRIUM" -> Siebel, "MAIN STAGE" -> Kenney), which silently
  // geofenced check-ins and SOS dispatch against the wrong coordinates.
  it.each([
    ['Main Library Atrium', 'MAIN_LIBRARY'],
    ['State Farm Center Main Stage', 'STATE_FARM_CENTER'],
    ['Siebel Center Atrium', 'SIEBEL_ATRIUM'],
    ['Siebel Center Basement Lab', 'SIEBEL_BASEMENT'],
    ['Kenney Gym bleachers', 'KENNEY_GYM'],
    ['Memorial Stadium Gate 4', 'MEMORIAL_STADIUM'],
    ['Foellinger Auditorium stage left', 'FOELLINGER_AUDITORIUM'],
    ['Illini Union South Lounge', 'ILLINI_UNION'],
    ['Grainger Library Rotunda', 'GRAINGER_LIBRARY'],
    ['Altgeld Hall Steps', 'ALTGELD_HALL'],
    ['ECEB Main Lobby', 'ECEB_LOBBY'],
    ['DCL Bridge Walkway', 'DCL_BRIDGE'],
  ])('resolves %s to %s', (location, expectedKey) => {
    const resolved = resolveVenue(location);
    expect(resolved.matched).toBe(true);
    expect(resolved.key).toBe(expectedKey);
  });

  it('no venue hint is shadowed by a longer hint belonging to another venue', () => {
    // Every venue must be reachable by its own most specific name.
    for (const key of Object.keys(VENUE_COORDINATES)) {
      const humanised = key.replace(/_/g, ' ');
      expect(resolveVenue(humanised).matched).toBe(true);
    }
  });

  it('fails closed for an unknown location', () => {
    expect(resolveVenue('Somewhere In Chicago').matched).toBe(false);
  });
});

describe('Spatial Geofencing & Haversine Distance Engine', () => {
  it('correctly calculates Haversine distance between Siebel Center and ECEB', () => {
    const siebel = VENUE_COORDINATES.SIEBEL_ATRIUM;
    const eceb = VENUE_COORDINATES.ECEB_LOBBY;

    const distance = GeoEngine.haversineDistanceMeters(siebel, eceb);
    // Siebel Atrium to ECEB Lobby is ~280-290 meters
    expect(distance).toBeGreaterThan(250);
    expect(distance).toBeLessThan(320);
  });

  it('enforces 75-meter geofence radius boundary correctly', () => {
    const siebel = VENUE_COORDINATES.SIEBEL_ATRIUM;
    const insideCoords = { latitude: 40.113820, longitude: -88.224930 }; // ~2 meters away
    const outsideCoords = VENUE_COORDINATES.KENNEY_GYM; // ~270 meters away

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
      CheckInService.verifyAndCheckIn(token, 'SCANNER_01', VENUE_COORDINATES.KENNEY_GYM)
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
    const hacker = await Volunteer.create({
      name: 'Stuck Hacker', email: null, kind: AccountKind.HACKER, role: VolunteerRole.HACKER,
    });
    const ticket = await SOSService.createTicket({
      hackerName: 'Stuck Hacker',
      tableLocation: 'Table 42 (Siebel Basement)',
      coordinates: VENUE_COORDINATES.SIEBEL_BASEMENT,
      category: SOSTicketCategory.HARDWARE_MALFUNCTION,
      description: 'Soldering iron shorted out, need backup ESP32 board immediately.',
      urgency: SOSTicketUrgency.HIGH,
      requiredSkill: 'HARDWARE',
      karmaBounty: 250,
    }, { id: String(hacker._id), kind: 'HACKER' });

    expect(ticket.status).toBe(SOSTicketStatus.OPEN);
    // The bounty survives because somebody was charged for it. A ticket raised with no
    // recorded creator carries no reward — see the case below.
    expect(ticket.karmaBounty).toBe(250);

    // Dispatch nearest volunteer
    const dispatchResult = await SOSService.dispatchNearestVolunteer(ticket._id.toString());
    expect(dispatchResult.ticket.status).toBe(SOSTicketStatus.DISPATCHED);
    // Vol B should be selected because Vol B is at Siebel (closer than Kenney) and has HARDWARE (unlike Vol C)
    expect((dispatchResult.dispatchedVolunteer as any)._id.toString()).toBe(volB._id.toString());
    expect(dispatchResult.distanceMeters).toBeLessThan(50);

    // Resolve ticket and award karma bounty
    const resolvedTicket = await SOSService.resolveTicket(ticket._id.toString(), volB._id.toString());
    expect(resolvedTicket.status).toBe(SOSTicketStatus.RESOLVED);

    // A bystander resolving someone else's dispatched ticket is bounty theft -> forbidden.
    const ticket2 = await SOSService.createTicket({
      hackerName: 'Second Hacker',
      tableLocation: 'Table 43 (Siebel Basement)',
      coordinates: VENUE_COORDINATES.SIEBEL_BASEMENT,
      category: SOSTicketCategory.HARDWARE_MALFUNCTION,
      description: 'Need a USB-C cable.',
      urgency: SOSTicketUrgency.MEDIUM,
      requiredSkill: 'HARDWARE',
    });
    await SOSService.dispatchNearestVolunteer(ticket2._id.toString());
    await expect(
      SOSService.resolveTicket(ticket2._id.toString(), volC._id.toString())
    ).rejects.toThrow(/only the dispatched volunteer/i);

    const updatedVolB = await Volunteer.findById(volB._id);
    expect(updatedVolB?.karmaPoints).toBe(200 + 250);
    expect(updatedVolB?.badges).toContain('FIRST_RESPONDER');
  });

  it('a ticket nobody was charged for pays no bounty, and still resolves', async () => {
    // The mint this closes: a bounty is drawn from its creator's daily budget, so a ticket
    // with no recorded creator has nobody to charge — and paying it out anyway makes karma
    // from nothing. Only reachable in legacy mode, where the route admits an anonymous
    // caller, and through a direct service call like this one.
    //
    // The ticket is still filed and still resolves. Refusing to record a distress call
    // because of an accounting rule would be optimising the wrong thing.
    const responder = await Volunteer.create({
      name: 'Unpaid Ursula', email: `u-${Date.now()}@illinois.edu`,
      certifications: ['HARDWARE'], karmaPoints: 0,
    });
    const shift = await Shift.create({
      title: 'Unpaid desk', description: 'x', category: ShiftCategory.LOGISTICS,
      location: 'Siebel Basement Lab Corridors',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000),
      capacity: 2, baseKarma: 10,
    });
    await Registration.create({
      shiftId: shift._id, volunteerId: responder._id,
      status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('unpaid'),
    });

    const ticket = await SOSService.createTicket({
      hackerName: 'Anonymous Ada',
      tableLocation: 'Table 44 (Siebel Basement)',
      coordinates: VENUE_COORDINATES.SIEBEL_BASEMENT,
      category: SOSTicketCategory.HARDWARE_MALFUNCTION,
      description: 'No creator on this one.',
      urgency: SOSTicketUrgency.HIGH,
      karmaBounty: 400,
    });
    expect(ticket.karmaBounty).toBe(0);

    await SOSService.dispatchNearestVolunteer(ticket._id.toString());
    const resolved = await SOSService.resolveTicket(ticket._id.toString(), responder._id.toString());
    expect(resolved.status).toBe(SOSTicketStatus.RESOLVED);

    const after = await Volunteer.findById(responder._id);
    expect(after?.karmaPoints).toBe(0);
    // The work was done, so the badge is earned even though no reward could be attached.
    expect(after?.badges).toContain('FIRST_RESPONDER');
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
