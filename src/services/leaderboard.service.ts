import { Volunteer } from '../models/volunteer.model';
import { Shift } from '../models/shift.model';
import { Registration, RegistrationStatus } from '../models/registration.model';

export interface ILeaderboardEntry {
  rank: number;
  volunteerId: string;
  name: string;
  karmaPoints: number;
  hoursServed: number;
  prestigeTier: string;
  badges: string[];
}

export interface IOperationsStats {
  totalVolunteers: number;
  totalShifts: number;
  totalHoursServed: number;
  totalKarmaAwarded: number;
  overallFillRatePercent: number;
  activeCheckedInCount: number;
}

export class LeaderboardService {
  /**
   * Retrieves top volunteers ranked by Karma Points.
   */
  public static async getLeaderboard(limit = 20): Promise<ILeaderboardEntry[]> {
    const volunteers = await Volunteer.find({})
      .sort({ karmaPoints: -1, hoursServed: -1 })
      .limit(limit);

    return volunteers.map((v, index) => ({
      rank: index + 1,
      volunteerId: v._id.toString(),
      name: v.name,
      karmaPoints: v.karmaPoints,
      hoursServed: v.hoursServed,
      prestigeTier: v.prestigeTier,
      badges: v.badges,
    }));
  }

  /**
   * Retrieves operational telemetry metrics for HackIllinois organizers.
   */
  public static async getOperationsStats(): Promise<IOperationsStats> {
    const [totalVolunteers, shifts, totalCheckedIn] = await Promise.all([
      Volunteer.countDocuments(),
      Shift.find({ isActive: true }),
      Registration.countDocuments({ status: RegistrationStatus.CHECKED_IN }),
    ]);

    let totalCapacity = 0;
    let totalFilled = 0;

    for (const shift of shifts) {
      totalCapacity += shift.capacity;
      totalFilled += shift.filledSlots;
    }

    const overallFillRatePercent = totalCapacity > 0
      ? parseFloat(((totalFilled / totalCapacity) * 100).toFixed(1))
      : 0;

    // Aggregate total hours and karma
    const volunteers = await Volunteer.find({});
    const totalHoursServed = volunteers.reduce((acc, v) => acc + (v.hoursServed || 0), 0);
    const totalKarmaAwarded = volunteers.reduce((acc, v) => acc + (v.karmaPoints || 0), 0);

    return {
      totalVolunteers,
      totalShifts: shifts.length,
      totalHoursServed: parseFloat(totalHoursServed.toFixed(1)),
      totalKarmaAwarded,
      overallFillRatePercent,
      activeCheckedInCount: totalCheckedIn,
    };
  }
}
