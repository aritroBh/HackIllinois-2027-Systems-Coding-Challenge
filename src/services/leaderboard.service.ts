/**
 * Read-only aggregation for the war room: volunteer rankings and event-wide vitals.
 *
 * This service owns no invariants and mutates nothing. It exists so the dashboard has a
 * single place to ask "how is the event going?" rather than assembling the answer from
 * four endpoints client-side.
 *
 * **A scaling note worth being honest about.** `getOperationsStats` loads every volunteer
 * and every active shift into memory and reduces over them in JavaScript. At the size of
 * one hackathon — hundreds of volunteers, dozens of shifts — that is a few milliseconds
 * and far simpler to read than the equivalent pipeline. It is also the first thing that
 * should become a `$group` aggregation if this ever runs against a season of events,
 * because the cost grows linearly with the collection while a server-side aggregation
 * would not ship the documents over the wire at all.
 *
 * Ranking is by karma, then hours as a tiebreak, so two volunteers on equal karma order
 * deterministically instead of by whatever the storage engine returns.
 */
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
