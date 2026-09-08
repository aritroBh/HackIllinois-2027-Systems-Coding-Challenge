/**
 * The two read models behind the game board (plan §A6): the faction objectives bar and the
 * karma leaderboard.
 *
 * Both mutate nothing and own no invariants. They live here rather than in
 * `LeaderboardService` because that service answers the war room's question — how is the
 * event running, how full are the shifts — and these two answer the player's: who is
 * winning, and is my faction ahead. The two rankings genuinely differ, and merging them
 * would mean one of the callers silently getting the other's tie-break.
 *
 * **Attendance is the objectives currency, not karma.** A bar driven by karma would be a
 * second leaderboard, and worse, it would be won by whoever farmed beacons hardest. Counting
 * people who actually turned up and got a token scanned means a faction gets ahead by
 * bringing bodies to shifts, which is the behaviour the event wants and the one a volunteer
 * ops tool should reward.
 *
 * **Attendance is counted over the whole event, not today.** A day bucket would make the bar
 * lurch to zero at every event-local midnight, mid-shift, which is when the most people are
 * on duty. The live figure people want alongside it is "how many are on a desk right now",
 * which is reported separately as `onDuty` and needs no calendar at all.
 *
 * **The leaderboard's tie-break is reliability, then name — and reliability is dead weight
 * today, so in practice it is name.** Equal karma is common (the caps see to that), so a
 * tie-break that is only karma-then-storage-order means the board reshuffles between two
 * identical requests. Name last makes the order total and stable, and that part works.
 *
 * The reliability term does not, and the reason is worth stating precisely rather than leaving
 * for somebody to discover from a ranking that looks alphabetical. `Volunteer.reliability`
 * declares `{ completed, noShow }` and **nothing in `src/` ever writes either field** — not
 * check-out, not cancellation, not a no-show sweep, because there is no no-show sweep. So
 * `reliabilityPercent` is 0 for every account, every account ties on it, and the comparison
 * falls straight through to name.
 *
 * The intended rule stands: the person who finished what they signed up for should rank above
 * the person with the same karma who did not, and an account with no history should score zero
 * rather than a hundred — no record reads as no record, not as a perfect one. Making it true
 * needs a writer, and the honest place is check-out incrementing `completed` alongside the hours
 * it already writes, plus a decision about what counts as a no-show. That is a scheduling
 * decision rather than a leaderboard one, which is why it is recorded here instead of guessed
 * at. `docs/LIMITATIONS.md` carries it.
 *
 * Both queries are aggregations rather than a load-and-reduce in JavaScript. At one
 * hackathon's size either would do; the aggregation is here because it does not ship every
 * volunteer document over the wire to count them, which is the difference that matters the
 * first time this runs against a season of events.
 */
import { Volunteer } from '../models/volunteer.model';
import { CheckIn } from '../models/checkin.model';
import { pack } from '../content/loader';

/** The faction an account with no allegiance is counted under; the pack must declare it. */
const UNALIGNED = 'NEUTRAL';

export interface FactionObjective {
  id: string;
  label: string;
  short: string;
  color: string;
  /** Distinct accounts of this faction that have checked in at least once this event. */
  attending: number;
  /** Of those, the ones with an open check-in right now. */
  onDuty: number;
  /** This faction's share of `totalAttending`, to one decimal place. Zero when nobody has. */
  sharePercent: number;
}

export interface ObjectivesBoard {
  totalAttending: number;
  totalOnDuty: number;
  factions: FactionObjective[];
  /** The faction with the largest share, or null while the bar is empty or tied. */
  leading: string | null;
}

export interface KarmaLeaderboardEntry {
  rank: number;
  accountId: string;
  name: string;
  kind: string;
  faction: string;
  karmaPoints: number;
  prestigeTier: string;
  badges: number;
  /** Completed share of this account's shift history, 0–100. Zero with no history. */
  reliabilityPercent: number;
  shiftsCompleted: number;
  shiftsMissed: number;
}

interface AttendanceRow {
  _id: string | null;
  attending: number;
  onDuty: number;
}

/**
 * Game board aggregation service compiling 2D map entities, beacons, territories, and active campus events.
 */
export class GameBoardService {
  /**
   * Each faction's share of attendance, with every faction the pack declares present even
   * when its share is zero — the bar has fixed segments, so a faction nobody joined has to
   * render as an empty one rather than vanish and shift the others along.
   */
  public static async objectives(): Promise<ObjectivesBoard> {
    const rows = await CheckIn.aggregate<AttendanceRow>([
      // One row per person first: attendance counts people, and someone who scanned in at
      // six desks is one person on the bar, not six.
      {
        $group: {
          _id: '$volunteerId',
          open: { $max: { $cond: [{ $eq: [{ $ifNull: ['$checkOutTime', null] }, null] }, 1, 0] } },
        },
      },
      { $lookup: { from: Volunteer.collection.name, localField: '_id', foreignField: '_id', as: 'account' } },
      { $unwind: '$account' },
      {
        $group: {
          _id: { $ifNull: ['$account.faction', UNALIGNED] },
          attending: { $sum: 1 },
          onDuty: { $sum: '$open' },
        },
      },
    ]);

    const byFaction = new Map(rows.map((row) => [row._id ?? UNALIGNED, row]));
    const totalAttending = rows.reduce((sum, row) => sum + row.attending, 0);
    const totalOnDuty = rows.reduce((sum, row) => sum + row.onDuty, 0);

    const factions: FactionObjective[] = pack.factions.map((faction) => {
      const row = byFaction.get(faction.id);
      const attending = row?.attending ?? 0;
      return {
        id: faction.id,
        label: faction.label,
        short: faction.short,
        color: faction.color,
        attending,
        onDuty: row?.onDuty ?? 0,
        sharePercent: totalAttending > 0 ? Math.round((attending / totalAttending) * 1000) / 10 : 0,
      };
    });

    // The unaligned segment is the bar's remainder, not a contender, so it never leads.
    const contenders = factions.filter((faction) => faction.id !== UNALIGNED);
    const best = contenders.reduce<FactionObjective | null>(
      (top, faction) => (top === null || faction.attending > top.attending ? faction : top),
      null
    );
    const tied = best !== null && contenders.filter((faction) => faction.attending === best.attending).length > 1;

    return {
      totalAttending,
      totalOnDuty,
      factions,
      leading: best && best.attending > 0 && !tied ? best.id : null,
    };
  }

  /**
   * Top accounts by karma, tie-broken by reliability and then by name.
   *
   * The collation is what makes the name tie-break mean what a reader expects: without it
   * Mongo sorts by byte value, which puts every capitalised name ahead of every lowercase
   * one and reads as no order at all.
   */
  public static async leaderboard(limit = 25): Promise<KarmaLeaderboardEntry[]> {
    const rows = await Volunteer.aggregate<Omit<KarmaLeaderboardEntry, 'rank'>>([
      { $match: { karmaPoints: { $gt: 0 } } },
      {
        $addFields: {
          shiftsCompleted: { $ifNull: ['$reliability.completed', 0] },
          shiftsMissed: { $ifNull: ['$reliability.noShow', 0] },
        },
      },
      {
        $addFields: {
          reliabilityPercent: {
            $let: {
              vars: { total: { $add: ['$shiftsCompleted', '$shiftsMissed'] } },
              in: {
                $cond: [
                  { $gt: ['$$total', 0] },
                  { $round: [{ $multiply: [100, { $divide: ['$shiftsCompleted', '$$total'] }] }, 1] },
                  0,
                ],
              },
            },
          },
        },
      },
      { $sort: { karmaPoints: -1, reliabilityPercent: -1, name: 1 } },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          accountId: { $toString: '$_id' },
          name: 1,
          kind: { $ifNull: ['$kind', 'VOLUNTEER'] },
          faction: { $ifNull: ['$faction', UNALIGNED] },
          karmaPoints: 1,
          prestigeTier: 1,
          badges: { $size: { $ifNull: ['$badges', []] } },
          reliabilityPercent: 1,
          shiftsCompleted: 1,
          shiftsMissed: 1,
        },
      },
    ]).collation({ locale: 'en' });

    return rows.map((row, index) => ({ rank: index + 1, ...row }));
  }
}
