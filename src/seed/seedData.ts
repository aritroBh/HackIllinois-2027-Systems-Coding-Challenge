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
// Registers every model, so the wipe below covers all of them rather than only the ones this
// file happens to import. `tests/setup.ts` imports it for the same reason.
import '../models';
import { connectDatabase, disconnectDatabase } from '../config/database';
import { Shift, ShiftCategory } from '../models/shift.model';
import { Volunteer, VolunteerRole, computePrestigeTier } from '../models/volunteer.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { ShiftSwap, SwapStatus } from '../models/swap.model';
import { Gym, Faction } from '../models/gym.model';
import { HackStop } from '../models/hackstop.model';
import { pack } from '../content/loader';
import { geofenceMetersFor } from '../common/utils/geofence';

export async function seedDatabase(): Promise<void> {
  // ponytail: seed wipes every collection — refuse against a real database unless
  // explicitly forced. An accidental `npm run seed` with MONGODB_URI set must not nuke prod.
  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED !== 'true') {
    console.error('❌ Refusing to seed in production without FORCE_SEED=true (seed wipes all collections).');
    process.exit(1);
  }
  console.log(`🌱 [SEED] Hydrating from content pack "${pack.event.id}" (${pack.event.name})...`);
  // Only when nobody has connected for us. `connectDatabase()` with no `MONGODB_URI` starts
  // a *new* in-memory replica set and repoints mongoose at it, so calling it unconditionally
  // from a caller that already holds a connection — the test suite, most of all — silently
  // moves the seed into a second database and leaves the caller reading an empty first one.
  // That is what kept the seeded scenario untestable, and an untested seed is how the demo's
  // headline trade ring came to be wired so that it could never execute.
  if (mongoose.connection.readyState !== 1) await connectDatabase();

  // Every collection, and this time actually every collection.
  //
  // The list used to name eleven models while the comment claimed all of them, and the ones
  // it missed are precisely the ones that make a second run behave differently from the
  // first: `BoothScan` is a once-ever guard, so re-seeding left every sponsor booth already
  // scanned and answering 409; `QuestProgress` left quests pre-completed; `KarmaLedger`,
  // `BountyLedger` and `StickerLedger` left part of the day's caps already spent, so the
  // demo's economy started somewhere in the middle of a day nobody had played.
  //
  // Enumerated from `mongoose.models` rather than by hand, because a hand-written list is a
  // thing that goes stale silently — which is exactly what happened. A model added tomorrow
  // is wiped tomorrow without anybody remembering to come back here.
  const collections = Object.values(mongoose.models);
  await Promise.all(collections.map((model) => model.deleteMany({})));


  const now = new Date();
  const baseTime = new Date(now);
  baseTime.setHours(12, 0, 0, 0);

  // 1. Create Volunteers with Certifications & Prestige
  // `prestigeTier` is NOT written here. It is a projection of `karmaPoints`
  // (`computePrestigeTier`), and typing it by hand let the two disagree: the demo's own
  // sign-in, Nexus Ops, sat on 4,200 karma wearing SIEBEL_GUARDIAN — the band for
  // 1,000-1,999 — so the leaderboard showed rank 1 with a *lower* tier than rank 2, who had
  // 600 fewer points. Deriving it below means the seed cannot restate the rule and get it
  // wrong; there is only one place the rule lives.
  const volunteerSeeds = [
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
      badges: [],
    },
  ];

  const volunteers = await Volunteer.create(
    volunteerSeeds.map((v) => ({ ...v, prestigeTier: computePrestigeTier(v.karmaPoints) })),
  );

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
    {
      // Anchored to *now*, not to the event day, and the only shift here that is.
      //
      // Every other shift hangs off `baseTime` (today at noon), so whether any of them is
      // currently running depends on what time you started the demo. Check-in refuses a
      // shift that is not happening — a token for tomorrow's shift used to be redeemable
      // today, which is karma for work nobody did — so the demo account needs one shift it
      // can genuinely check in to, whenever the demo is run. This is it.
      title: 'Siebel Atrium Info Desk',
      description: 'Point lost hackers at the right room, hand out badges, keep the coffee going.',
      category: ShiftCategory.INFO_DESK,
      location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 60 * 60 * 1000),
      endTime: new Date(Date.now() + 3 * 60 * 60 * 1000),
      capacity: 4,
      requiredSkills: [],
      baseKarma: 110,
      manualSurgeMultiplier: 1.0,
      version: 0,
      isActive: true,
    },
  ]);

  const [pizzaShift, hwShift, shuttleShift] = shifts;

  // 3. Create Seed Registrations (Demonstrating Confirmed & Waitlist States)
  //
  // The demo account holds a confirmed spot on the shift that is running *now* (index 5),
  // so the Trainer QR flow works for the signed-in user without any setup. It used to hold
  // the 3:30 a.m. cleanup, which is fifteen hours away from the seeded day — fine while
  // check-in ignored the clock, and a dead end once it stopped.
  await Registration.create({
    shiftId: shifts[5]._id,
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
  // in the 3D campus model (the tiles under content/<pack>/campus/), so capturing a gym
  // here recolours the matching landmark on the war-room map.
  const LEADERS = [
    { id: charlie._id, name: 'Charlie Patel' },
    { id: bob._id, name: 'Bob Martinez' },
    { id: alice._id, name: 'Alice Chen' },
  ];

  /*
   * Territories come from the pack, not from this file.
   *
   * There used to be a fourteen-entry literal here, and `content/<pack>/territories.json`
   * held the same fourteen entries with the same names, factions, control points and levels.
   * The pack's copy was parsed, cross-validated and served to browsers, and read by nothing —
   * so a fork could edit `territories.json`, watch it validate, and get HackIllinois's gyms.
   * `territories.json`'s own `_about` said "Read by src/seed/seedData.ts". It was not.
   *
   * `crossValidate` already refuses a pack whose territory names an unknown venue, an unknown
   * monument, an unknown faction, or `cp` above `max`, so nothing below needs to re-check any
   * of that: a pack that reaches this line has been checked.
   */
  const TERRITORIES = pack.territories;

  await Gym.create(
    TERRITORIES.map((t, i) => {
      const leader = LEADERS[i % LEADERS.length];
      const held = t.faction !== Faction.NEUTRAL;
      return {
        name: t.name,
        locationName: t.locationName,
        latitude: pack.venues[t.venue].latitude,
        longitude: pack.venues[t.venue].longitude,
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
  /*
   * Beacons likewise. `beacons.json` was the other dead pack file: validated at boot, unique
   * ids enforced, venue keys checked — and never read, while this file built twelve beacons of
   * its own from the same data.
   *
   * `cooldownSeconds` and `geofenceRadiusMeters` keep their defaults here rather than moving
   * into the pack schema, because both are already per-beacon columns on the model and
   * `spinBeacon` reads them off the document. Making them pack fields is a schema change worth
   * doing deliberately, not a side effect of this one.
   */
  const BEACONS = pack.beacons;

  await HackStop.create(
    BEACONS.map((b) => ({
      beaconId: b.id,
      name: b.name,
      locationName: b.where,
      latitude: pack.venues[b.venue].latitude,
      longitude: pack.venues[b.venue].longitude,
      cooldownSeconds: 300,
      // The beacon's own radius, then its venue's, then the campus default.
      //
      // `beacons.json`'s `_about` has promised "the pack's geofence radius unless overridden"
      // since it was written, and there was no override path: this line was a literal 75, so a
      // fork widening a beacon for a large atrium got refusals from players standing inside the
      // radius it had set. `spinBeacon` already reads this column off the document — the column
      // was simply never given the pack's number.
      geofenceRadiusMeters: b.radiusMeters ?? geofenceMetersFor(b.venue),
    }))
  );

  console.log('✅ [SEED COMPLETED] Seeded:');
  console.log(`   - 6 Volunteers (Nexus Ops, Alice, Bob, Charlie, Dana, Evan)`);
  console.log(`   - 6 Shifts (Pizza, Hardware, Shuttle, 3:30 AM Surge Emergency, Swag, Info Desk running now)`);
  console.log(`   - 1 Contested Shift with 1 Waitlisted Candidate`);
  console.log(`   - 1 3-Way Circular Trade Demand Ring (Alice -> Bob -> Charlie -> Alice)`);
  // Named from the pack, not from a literal.
  //
  // These two lines used to end "(Alma Mater, Foellinger, Altgeld, Memorial Stadium, ...)"
  // beside a count that was already `TERRITORIES.length`. Once the territories came from the
  // pack, that made the seed report a fork's one territory and then name four buildings in
  // Urbana it had not created — a false line in the first output a fork ever sees from this
  // system. Three examples and an ellipsis, taken from whatever was actually inserted.
  const sample = (names: string[]): string =>
    names.length === 0 ? '' : ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''})`;
  console.log(`   - ${TERRITORIES.length} Campus Territory Gyms${sample(TERRITORIES.map((t) => t.name))}`);
  console.log(`   - ${BEACONS.length} Campus Supply HackStops${sample(BEACONS.map((b) => b.name))}`);
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
