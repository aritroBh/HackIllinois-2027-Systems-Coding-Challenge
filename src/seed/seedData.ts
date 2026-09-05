import { connectDatabase, disconnectDatabase } from '../config/database';
import { Shift, ShiftCategory } from '../models/shift.model';
import { Volunteer, VolunteerRole, PrestigeTier } from '../models/volunteer.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { ShiftSwap, SwapStatus } from '../models/swap.model';

export async function seedDatabase(): Promise<void> {
  console.log('🌱 [SEED] Starting database hydration with HackIllinois scenarios...');
  await connectDatabase();

  // Clear existing collections
  await Promise.all([
    Shift.deleteMany({}),
    Volunteer.deleteMany({}),
    Registration.deleteMany({}),
    ShiftSwap.deleteMany({}),
  ]);

  const now = new Date();
  const baseTime = new Date(now);
  baseTime.setHours(12, 0, 0, 0);

  // 1. Create Volunteers with Certifications & Prestige
  const volunteers = await Volunteer.create([
    {
      name: 'Alice Chen',
      email: 'alice@illinois.edu',
      phone: '217-555-0101',
      role: VolunteerRole.VOLUNTEER,
      certifications: ['DRIVERS_LICENSE', 'FOOD_HANDLING'],
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
      certifications: ['HARDWARE_EXPERIENCE', 'FIRST_AID'],
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

  const [alice, bob, charlie, dana, evan] = volunteers;

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
      capacity: 3,
      filledSlots: 2,
      waitlistCount: 1,
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
      filledSlots: 1,
      waitlistCount: 0,
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
      filledSlots: 1,
      waitlistCount: 0,
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
      filledSlots: 0,
      waitlistCount: 0,
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
      filledSlots: 2,
      waitlistCount: 0,
      requiredSkills: [],
      baseKarma: 100,
      manualSurgeMultiplier: 1.0,
      version: 2,
      isActive: true,
    },
  ]);

  const [pizzaShift, hwShift, shuttleShift] = shifts;

  // 3. Create Seed Registrations (Demonstrating Confirmed & Waitlist States)
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

  console.log('✅ [SEED COMPLETED] Seeded:');
  console.log(`   - 5 Volunteers (Alice, Bob, Charlie, Dana, Evan)`);
  console.log(`   - 5 Shifts (Pizza, Hardware, Shuttle, 3:30 AM Surge Emergency, Swag)`);
  console.log(`   - 1 Contested Shift with 1 Waitlisted Candidate`);
  console.log(`   - 1 3-Way Circular Trade Demand Ring (Alice -> Bob -> Charlie -> Alice)`);
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
