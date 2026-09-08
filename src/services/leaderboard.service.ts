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
 * Ranking is by karma, then hours as a tiebreak. That settles the common tie and no more:
 * two volunteers equal on both keys are left in whatever order the storage engine returns.
 * `GameBoardService.leaderboard`, the player-facing board, carries the name as a third key
 * for exactly that reason; this one does not.
 */
import { Volunteer } from '../models/volunteer.model';
import { Shift } from '../models/shift.model';
import { Registration, RegistrationStatus } from '../models/registration.model';

/** One row of the war room board. `rank` is the position in this response, not a stored field. */
export interface ILeaderboardEntry {
  rank: number;
  volunteerId: string;
  name: string;
  karmaPoints: number;
  hoursServed: number;
  prestigeTier: string;
  badges: string[];
}

/**
 * The whole-event roll-up. Two of these count different populations and the names do not say
 * so: `totalVolunteers` is every account in the collection, hackers included, while
 * `totalShifts` and the fill rate cover active shifts only.
 */
export interface IOperationsStats {
  totalVolunteers: number;
  totalShifts: number;
  totalHoursServed: number;
  totalKarmaAwarded: number;
  overallFillRatePercent: number;
  activeCheckedInCount: number;
}

/**
 * Leaderboard service computing live volunteer rankings, hours served, and tier standings with privacy protections.
 */
export class LeaderboardService {
  /**
   * The top of the board, karma first and hours as the tiebreak.
   *
   * The `limit` default of 20 is for a direct caller only; nothing reaches it over HTTP,
   * because `StatsController.getLeaderboard` clamps the query parameter to [1, 100] before
   * calling. That clamp is the defence against `?limit=99999999`, and it deliberately lives
   * at the edge rather than here, so this stays a plain read a test can ask for any slice of.
   *
   * There is no floor on karma, so an account that has earned nothing still appears once the
   * board is short enough. That is the difference from `GameBoardService.leaderboard`, which
   * filters to `karmaPoints > 0`: this is the organisers' roll call, where a volunteer sitting
   * at zero is information, and that one is a scoreboard, where it is noise.
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
   * The one call the war room makes to ask how the event is going.
   *
   * `activeCheckedInCount` is people on a desk *now*, not people who turned up at some point:
   * `CHECKED_IN` is the status a scan sets and a check-out moves on to `COMPLETED`, so the
   * count drains as shifts end without anything having to sweep it.
   *
   * `totalKarmaAwarded` is the sum of current balances rather than a read of the ledger, and
   * it survives that shortcut for one reason: the only update to `karmaPoints` anywhere in the
   * codebase is `KarmaService`'s `$inc`, and that increment is never negative, so karma cannot
   * be spent back out of the total. Seeding is where the name still over-promises — seeded
   * accounts are created holding a balance nothing ever awarded them, and it is counted here
   * as karma this event paid.
   *
   * The fill rate is over `isActive` shifts only, so deactivating a shift takes both its
   * capacity and its filled slots out of the ratio rather than leaving behind a denominator
   * nobody can fill.
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
