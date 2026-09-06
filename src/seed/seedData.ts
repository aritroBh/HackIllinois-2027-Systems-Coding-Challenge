/**
 * Demo data seeder.
 *
 * Builds a scenario that exercises the interesting paths rather than generic filler: a
 * contested shift that is already at capacity with someone waiting, a 3:30 a.m. cleanup
 * carrying a high surge multiplier, a pre-wired three-way trade ring (Alice wants Bob's
 * shift, Bob wants Charlie's, Charlie wants Alice's) so cycle resolution has something to
 * find, plus campus gyms and geofenced beacons.
 *
 * **This is destructive.** It deletes every collection before inserting. The guard below
 * only refuses when `NODE_ENV === 'production'` without `FORCE_SEED=true`, so pointing
 * `MONGODB_URI` at a shared development or staging database and running this will wipe
 * it without prompting. Check the URI before you run it.
 *
 * Note the connection lifecycle: this script calls `connectDatabase()` itself. With no
 * `MONGODB_URI` set that starts its *own* in-memory replica set, which is discarded when
 * the process exits — so `npm run seed && npm run dev` leaves the server pointing at an
 * empty database. Use `npm run demo` (`scripts/devSeeded.ts`), which shares one instance
 * between seeding and serving, or set `MONGODB_URI` so both attach to the same database.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { Shift, ShiftCategory } from '../models/shift.model';
import { Volunteer, VolunteerRole, PrestigeTier } from '../models/volunteer.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { ShiftSwap, SwapStatus } from '../models/swap.model';
import { Gym, Faction } from '../models/gym.model';
import { HackStop } from '../models/hackstop.model';
import { CheckIn } from '../models/checkin.model';
import { SOSTicket } from '../models/sosTicket.model';
import { PowerUpInventory } from '../models/powerup.model';
import { IdempotencyRecord } from '../models/idempotency.model';
import { ReservationLock } from '../models/reservationLock.model';
import { HACKILLINOIS_VENUES } from '../common/utils/geo';

export async function seedDatabase(): Promise<void> {
  // ponytail: seed wipes every collection — refuse against a real database unless
  // explicitly forced. An accidental `npm run seed` with MONGODB_URI set must not nuke prod.
  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED !== 'true') {
    console.error('❌ Refusing to seed in production without FORCE_SEED=true (seed wipes all collections).');
    process.exit(1);
  }
  console.log('🌱 [SEED] Starting database hydration with HackIllinois scenarios...');
  // Only when nobody has connected for us. `connectDatabase()` with no `MONGODB_URI` starts
  // a *new* in-memory replica set and repoints mongoose at it, so calling it unconditionally
  // from a caller that already holds a connection — the test suite, most of all — silently
  // moves the seed into a second database and leaves the caller reading an empty first one.
  // That is what kept the seeded scenario untestable, and an untested seed is how the demo's
  // headline trade ring came to be wired so that it could never execute.
  if (mongoose.connection.readyState !== 1) await connectDatabase();

  // Clear existing collections (every collection, including attendance,
  // SOS, inventory, and lock/idempotency state — stale check-in nonces or
  // locks from a previous seed otherwise leak into the fresh dataset).
  await Promise.all([
    Shift.deleteMany({}),
    Volunteer.deleteMany({}),
    Registration.deleteMany({}),
    ShiftSwap.deleteMany({}),
    Gym.deleteMany({}),
    HackStop.deleteMany({}),
    CheckIn.deleteMany({}),
    SOSTicket.deleteMany({}),
    PowerUpInventory.deleteMany({}),
    IdempotencyRecord.deleteMany({}),
    ReservationLock.deleteMany({}),
  ]);


  const now = new Date();
  const baseTime = new Date(now);
  baseTime.setHours(12, 0, 0, 0);

  // 1. Create Volunteers with Certifications & Prestige
  const volunteers = await Volunteer.create([
    {
      // The demo's own sign-in: `npm run demo` auto-logs the dashboard in as the
      // highest-ranked seeded account so every organiser tool (Chaos Lab, Adonix
      // sync, roster, revocation) works from the first click.
      name: 'Nexus Ops',
      email: 'ops@illinois.edu',
      phone: '217-555-0100',
      role: VolunteerRole.ORGANIZER,
      certifications: ['DRIVERS_LICENSE', 'FOOD_HANDLING', 'CPR'],
      karmaPoints: 4200,
      hoursServed: 42,
      prestigeTier: PrestigeTier.SIEBEL_GUARDIAN,
      badges: ['SIEBEL_GUARDIAN', 'SWAG_VANGUARD', 'FIRST_RESPONDER'],
    },
    {
      name: 'Alice Chen',
      email: 'alice@illinois.edu',
      phone: '217-555-0101',
      role: VolunteerRole.VOLUNTEER,
      // HARDWARE_EXPERIENCE because Alice asks for the hardware desk in the trade ring
      // below, and the cyclic resolver refuses to hand anybody a shift they are not
      // certified for. Seeding the ask without the certification made the demo's headline
      // three-way ring permanently unexecutable: cycle detection found it every time and
      // then failed every leg with "receiver lacks certifications".
      certifications: ['DRIVERS_LICENSE', 'FOOD_HANDLING', 'HARDWARE_EXPERIENCE'],
      karmaPoints: 1250,
      hoursServed: 10.5,
      prestigeTier: PrestigeTier.SIEBEL_GUARDIAN,
      badges: ['SIEBEL_GUARDIAN', 'SWAG_VANGUARD'],
    },
    {
      name: 'Bob Martinez',
      email: 'bob@illinois.edu',
      phone: '217-555-0102',
      role: VolunteerRole.VOLUNTEER,
      // DRIVERS_LICENSE for the same reason: Bob's leg of the ring receives the airport
      // shuttle, which requires one.
      certifications: ['HARDWARE_EXPERIENCE', 'FIRST_AID', 'DRIVERS_LICENSE'],
      karmaPoints: 2400,
      hoursServed: 18.0,
      prestigeTier: PrestigeTier.MIDNIGHT_KRAKEN,
      badges: ['MIDNIGHT_KRAKEN', 'HARDWARE_HERO'],
    },
    {
      name: 'Charlie Patel',
      email: 'charlie@illinois.edu',
      phone: '217-555-0103',
      role: VolunteerRole.SHIFT_LEAD,
      certifications: ['DRIVERS_LICENSE', 'FIRST_AID', 'FOOD_HANDLING'],
      karmaPoints: 3600,
      hoursServed: 32.0,
      prestigeTier: PrestigeTier.LEVIATHAN_PRIME,
      badges: ['LEVIATHAN_PRIME', 'MIDNIGHT_KRAKEN', 'SIEBEL_GUARDIAN'],
    },
    {
      name: 'Dana Scully',
      email: 'dana@illinois.edu',
      phone: '217-555-0104',
      role: VolunteerRole.VOLUNTEER,
      certifications: ['FOOD_HANDLING'],
      karmaPoints: 450,
      hoursServed: 4.0,
      prestigeTier: PrestigeTier.CURRENT_RIDER,
      badges: ['CURRENT_RIDER'],
    },
    {
      name: 'Evan Wright',
      email: 'evan@illinois.edu',
      phone: '217-555-0105',
      role: VolunteerRole.VOLUNTEER,
      certifications: ['DRIVERS_LICENSE', 'HEAVY_LIFTING'],
      karmaPoints: 150,
      hoursServed: 1.5,
      prestigeTier: PrestigeTier.NEOPHYTE_PLANKTON,
      badges: [],
    },
  ]);

  const [ops, alice, bob, charlie, dana, evan] = volunteers;

  // 2. Create Shifts across Siebel Center & ECEB
  const shift1Start = new Date(baseTime.getTime() + 2 * 3600 * 1000); // 14:00 - 16:00
  const shift1End = new Date(shift1Start.getTime() + 2 * 3600 * 1000);

  const shift2Start = new Date(baseTime.getTime() + 5 * 3600 * 1000); // 17:00 - 19:00
  const shift2End = new Date(shift2Start.getTime() + 2 * 3600 * 1000);

  const shift3Start = new Date(baseTime.getTime() + 8 * 3600 * 1000); // 20:00 - 22:00
  const shift3End = new Date(shift3Start.getTime() + 2 * 3600 * 1000);

  const midnightStart = new Date(baseTime.getTime() + 15.5 * 3600 * 1000); // 03:30 AM Next Day
  const midnightEnd = new Date(midnightStart.getTime() + 2 * 3600 * 1000);

  const shifts = await Shift.create([
    {
      title: 'Siebel Midnight Pizza Rush',
      description: 'Hand out 1,200 slices of Papa Johns pizza to hungry hackers in the main atrium.',
      category: ShiftCategory.FOOD,
      location: 'Siebel Center Atrium',
      startTime: shift1Start,
      endTime: shift1End,
      // Two, not three. This is the demo's "contested" shift and it seeds two confirmed
      // holders and one waitlisted volunteer — which at capacity three meant Evan was
      // queueing for a seat that was standing empty, a state the live system cannot
      // produce and cannot resolve (nothing promotes until somebody cancels).
      capacity: 2,
      requiredSkills: ['FOOD_HANDLING'],
      baseKarma: 120,
      manualSurgeMultiplier: 1.0,
      version: 2,
      isActive: true,
    },
    {
      title: 'ECEB Hardware Lab Check-Out Desk',
      description: 'Manage VR headsets, Arduinos, sensors, and oscilloscope loans for hackers.',
      category: ShiftCategory.HARDWARE_LAB,
      location: 'ECEB Hardware Station (Room 1020)',
      startTime: shift2Start,
      endTime: shift2End,
      capacity: 2,
      requiredSkills: ['HARDWARE_EXPERIENCE'],
      baseKarma: 150,
      manualSurgeMultiplier: 1.2,
      version: 1,
      isActive: true,
    },
    {
      title: 'Willard Airport Sponsor Shuttle',
      description: 'Drive university minivans to transport Citadel, Google, and Bloomberg reps.',
      category: ShiftCategory.LOGISTICS,
      location: 'Siebel North Entrance Pickup',
      startTime: shift3Start,
      endTime: shift3End,
      capacity: 2,
      requiredSkills: ['DRIVERS_LICENSE'],
      baseKarma: 180,
      manualSurgeMultiplier: 1.0,
      version: 1,
      isActive: true,
    },
    {
      title: '🚨 03:30 AM Siebel Basement Cleanup Emergency',
      description: 'Critical logistics shift: restock Red Bull, clear overflowing bins, and monitor quiet rest areas.',
      category: ShiftCategory.CLEANUP,
      location: 'Siebel Basement Lab Corridors',
      startTime: midnightStart,
      endTime: midnightEnd,
      capacity: 4,
      requiredSkills: [],
      baseKarma: 220,
      manualSurgeMultiplier: 3.5, // High Surge Shift!
      version: 0,
      isActive: true,
    },
    {
      title: 'Opening Ceremony Swag Distribution',
      description: 'Distribute HackIllinois 2027 jackets, sticker packs, and NFC badge wristbands.',
      category: ShiftCategory.INFO_DESK,
      location: 'Kenney Gym Entrance Pavilion',
      startTime: new Date(baseTime.getTime() + 24 * 3600 * 1000),
      endTime: new Date(baseTime.getTime() + 27 * 3600 * 1000),
      capacity: 5,
      requiredSkills: [],
      baseKarma: 100,
      manualSurgeMultiplier: 1.0,
      version: 2,
      isActive: true,
    },
  ]);

  const [pizzaShift, hwShift, shuttleShift] = shifts;

  // 3. Create Seed Registrations (Demonstrating Confirmed & Waitlist States)
  // The demo account holds a confirmed spot on the open shift so the Trainer QR
  // (attendance token) flow works for the signed-in user without any setup.
  await Registration.create({
    shiftId: shifts[3]._id,
    volunteerId: ops._id,
    status: RegistrationStatus.CONFIRMED,
    idempotencyKey: 'seed_reg_ops',
    confirmedAt: new Date(baseTime.getTime() - 5400000),
  });

  await Registration.create([
    {
      shiftId: pizzaShift._id,
      volunteerId: alice._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'seed_reg_1',
      confirmedAt: new Date(baseTime.getTime() - 3600000),
    },
    {
      shiftId: pizzaShift._id,
      volunteerId: dana._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'seed_reg_2',
      confirmedAt: new Date(baseTime.getTime() - 1800000),
    },
    {
      shiftId: pizzaShift._id,
      volunteerId: evan._id,
      status: RegistrationStatus.WAITLISTED,
      waitlistPosition: 1,
      idempotencyKey: 'seed_reg_3',
    },
    {
      shiftId: hwShift._id,
      volunteerId: bob._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'seed_reg_4',
      confirmedAt: new Date(baseTime.getTime() - 3600000),
    },
    {
      shiftId: shuttleShift._id,
      volunteerId: charlie._id,
      status: RegistrationStatus.CONFIRMED,
      idempotencyKey: 'seed_reg_5',
      confirmedAt: new Date(baseTime.getTime() - 3600000),
    },
  ]);

  // 3b. Derive the denormalised counters from the rows that were just written.
  //
  // These used to be hand-written literals on each `Shift.create` above, kept in step with
  // the registrations by eye. They were not in step. "Opening Ceremony Swag Distribution"
  // claimed two filled seats and had no registrations at all — two of its five seats
  // permanently occupied by nobody — and only one shift had its counter maintained, by an
  // ad-hoc `$inc` that no other shift got.
  //
  // `filledSlots` is what the capacity guard reads, so a seeded value that disagrees with
  // the rows is the same corruption the whole reservation path exists to prevent, shipped
  // as the starting state. Computing it here means the demo cannot drift again: add a
  // registration and the counter follows.
  for (const shift of shifts) {
    const [occupied, waiting] = await Promise.all([
      Registration.countDocuments({
        shiftId: shift._id,
        status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
      }),
      Registration.countDocuments({ shiftId: shift._id, status: RegistrationStatus.WAITLISTED }),
    ]);
    await Shift.updateOne({ _id: shift._id }, { $set: { filledSlots: occupied, waitlistCount: waiting } });
  }

  // 4. Create a 3-Way Circular Trade Scenario:
  // Alice holds Pizza Shift -> wants HW Shift
  // Bob holds HW Shift      -> wants Shuttle Shift
  // Charlie holds Shuttle   -> wants Pizza Shift
  await ShiftSwap.create([
    {
      proposerVolunteerId: alice._id,
      proposerShiftId: pizzaShift._id,
      targetShiftId: hwShift._id,
      desiredShiftIds: [hwShift._id],
      status: SwapStatus.PENDING,
    },
    {
      proposerVolunteerId: bob._id,
      proposerShiftId: hwShift._id,
      targetShiftId: shuttleShift._id,
      desiredShiftIds: [shuttleShift._id],
      status: SwapStatus.PENDING,
    },
    {
      proposerVolunteerId: charlie._id,
      proposerShiftId: shuttleShift._id,
      targetShiftId: pizzaShift._id,
      desiredShiftIds: [pizzaShift._id],
      status: SwapStatus.PENDING,
    },
  ]);

  // 5. Seed Campus Territory Gyms (PokéShift Turf Wars)
  //
  // One stronghold per campus monument. These ids line up with the monuments
  // in the 3D campus model (public/gl/uiuc-campus.json), so capturing a gym
  // here recolours the matching landmark on the war-room map.
  const LEADERS = [
    { id: charlie._id, name: 'Charlie Patel' },
    { id: bob._id, name: 'Bob Martinez' },
    { id: alice._id, name: 'Alice Chen' },
  ];

  const TERRITORIES: Array<{
    name: string;
    locationName: string;
    venue: keyof typeof HACKILLINOIS_VENUES;
    faction: Faction;
    cp: number;
    max: number;
    level: number;
  }> = [
    { name: 'Siebel Core Coliseum', locationName: 'Siebel Center for CS', venue: 'SIEBEL_ATRIUM', faction: Faction.TEAM_KERNEL, cp: 1680, max: 2000, level: 5 },
    { name: 'ECEB Silicon Bastion', locationName: 'ECE Building (ECEB)', venue: 'ECEB_LOBBY', faction: Faction.TEAM_TENSOR, cp: 1240, max: 2000, level: 4 },
    { name: 'Kenney Thunderdome', locationName: 'Kenney Gym Annex', venue: 'KENNEY_GYM', faction: Faction.TEAM_SILICON, cp: 950, max: 2000, level: 3 },
    { name: 'DCL Relay Keep', locationName: 'Digital Computer Laboratory', venue: 'DCL_BRIDGE', faction: Faction.TEAM_KERNEL, cp: 780, max: 2000, level: 3 },
    { name: 'Grainger Archive Vault', locationName: 'Grainger Engineering Library', venue: 'GRAINGER_LIBRARY', faction: Faction.TEAM_KERNEL, cp: 1420, max: 2000, level: 4 },
    { name: 'Beckman Deep Lab', locationName: 'Beckman Institute', venue: 'BECKMAN_INSTITUTE', faction: Faction.TEAM_TENSOR, cp: 1580, max: 2000, level: 5 },
    { name: 'Alma Mater Shrine', locationName: 'Alma Mater Plaza', venue: 'ALMA_MATER', faction: Faction.NEUTRAL, cp: 500, max: 2500, level: 2 },
    { name: 'Union Grand Hall', locationName: 'Illini Union', venue: 'ILLINI_UNION', faction: Faction.TEAM_SILICON, cp: 1310, max: 2000, level: 4 },
    { name: 'Altgeld Chime Tower', locationName: 'Altgeld Hall', venue: 'ALTGELD_HALL', faction: Faction.TEAM_TENSOR, cp: 690, max: 2000, level: 3 },
    { name: 'Foellinger Rotunda', locationName: 'Foellinger Auditorium', venue: 'FOELLINGER_AUDITORIUM', faction: Faction.TEAM_SILICON, cp: 1120, max: 2000, level: 4 },
    { name: 'Main Library Stacks', locationName: 'Main Library', venue: 'MAIN_LIBRARY', faction: Faction.NEUTRAL, cp: 400, max: 2000, level: 2 },
    { name: 'Krannert Stage Nexus', locationName: 'Krannert Center', venue: 'KRANNERT_CENTER', faction: Faction.TEAM_TENSOR, cp: 860, max: 2000, level: 3 },
    { name: 'Memorial Stadium Bowl', locationName: 'Memorial Stadium', venue: 'MEMORIAL_STADIUM', faction: Faction.TEAM_SILICON, cp: 1940, max: 2500, level: 6 },
    { name: 'State Farm Dome', locationName: 'State Farm Center', venue: 'STATE_FARM_CENTER', faction: Faction.TEAM_KERNEL, cp: 1050, max: 2500, level: 4 },
  ];

  await Gym.create(
    TERRITORIES.map((t, i) => {
      const leader = LEADERS[i % LEADERS.length];
      const held = t.faction !== Faction.NEUTRAL;
      return {
        name: t.name,
        locationName: t.locationName,
        latitude: HACKILLINOIS_VENUES[t.venue].latitude,
        longitude: HACKILLINOIS_VENUES[t.venue].longitude,
        controllingFaction: t.faction,
        controlPoints: t.cp,
        maxControlPoints: t.max,
        leaderVolunteerId: held ? leader.id : null,
        leaderName: held ? `${leader.name} (${t.faction.replace('TEAM_', 'Team ')})` : 'Unclaimed',
        level: t.level,
      };
    })
  );

  // 6. Seed HackStop Beacons across campus
  const BEACONS: Array<{ id: string; name: string; where: string; venue: keyof typeof HACKILLINOIS_VENUES }> = [
    { id: 'BEACON_SIEBEL_ATRIUM', name: 'Siebel Cyber Fountain', where: 'Siebel Center Atrium', venue: 'SIEBEL_ATRIUM' },
    { id: 'BEACON_SIEBEL_BASEMENT', name: 'Basement Solder Relic', where: 'Siebel Center Basement', venue: 'SIEBEL_BASEMENT' },
    { id: 'BEACON_ECEB_LOBBY', name: 'ECEB Tesla Coil Relay', where: 'ECEB Main Lobby', venue: 'ECEB_LOBBY' },
    { id: 'BEACON_KENNEY_GYM', name: 'Kenney Arena Supply Pod', where: 'Kenney Gym Central', venue: 'KENNEY_GYM' },
    { id: 'BEACON_DCL_BRIDGE', name: 'DCL Nexus Transceiver', where: 'DCL Bridge Walkway', venue: 'DCL_BRIDGE' },
    { id: 'BEACON_GRAINGER', name: 'Grainger Reading Cache', where: 'Grainger Library Rotunda', venue: 'GRAINGER_LIBRARY' },
    { id: 'BEACON_ALMA_MATER', name: 'Alma Mater Reliquary', where: 'Green & Wright', venue: 'ALMA_MATER' },
    { id: 'BEACON_UNION', name: 'Union Courtyard Dispenser', where: 'Illini Union Courtyard', venue: 'ILLINI_UNION' },
    { id: 'BEACON_ALTGELD', name: 'Altgeld Chime Resonator', where: 'Altgeld Hall Steps', venue: 'ALTGELD_HALL' },
    { id: 'BEACON_FOELLINGER', name: 'Foellinger Colonnade Drop', where: 'Foellinger Portico', venue: 'FOELLINGER_AUDITORIUM' },
    { id: 'BEACON_KRANNERT', name: 'Krannert Stage Door Crate', where: 'Krannert Terrace', venue: 'KRANNERT_CENTER' },
    { id: 'BEACON_STADIUM', name: 'Stadium Tunnel Locker', where: 'Memorial Stadium Gate 4', venue: 'MEMORIAL_STADIUM' },
  ];

  await HackStop.create(
    BEACONS.map((b) => ({
      beaconId: b.id,
      name: b.name,
      locationName: b.where,
      latitude: HACKILLINOIS_VENUES[b.venue].latitude,
      longitude: HACKILLINOIS_VENUES[b.venue].longitude,
      cooldownSeconds: 300,
      geofenceRadiusMeters: 75,
    }))
  );

  console.log('✅ [SEED COMPLETED] Seeded:');
  console.log(`   - 5 Volunteers (Alice, Bob, Charlie, Dana, Evan)`);
  console.log(`   - 5 Shifts (Pizza, Hardware, Shuttle, 3:30 AM Surge Emergency, Swag)`);
  console.log(`   - 1 Contested Shift with 1 Waitlisted Candidate`);
  console.log(`   - 1 3-Way Circular Trade Demand Ring (Alice -> Bob -> Charlie -> Alice)`);
  console.log(`   - ${TERRITORIES.length} Campus Territory Gyms (Alma Mater, Foellinger, Altgeld, Memorial Stadium, ...)`);
  console.log(`   - ${BEACONS.length} Campus Supply HackStops with 75m Geofencing`);
}

if (require.main === module) {
  seedDatabase()
    .then(() => disconnectDatabase())
    .then(() => {
      console.log('🏁 Seed script finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Seed script error:', err);
      process.exit(1);
    });
}
