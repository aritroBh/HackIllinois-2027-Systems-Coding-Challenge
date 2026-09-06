/**
 * Raids (plan §A6).
 *
 * A raid is an hour the whole event is pointed at. The windows are content — `raids.json`
 * in the active pack — and this service is the three things the server has to know about
 * them: which one is open now, who took part, and what karma is worth while it runs.
 *
 * **Nobody joins by asking.** There is no join endpoint, because a raid you can join by
 * pressing a button is a leaderboard with extra steps. Enrolment is a listener on the domain
 * bus: do the thing the raid asks for while the window is open and you are on the roster.
 * That keeps the raid off the request path entirely — a raid rule with a bug fails a roster
 * row, never the spin that earned it — and it means adding a raid is a pack edit.
 *
 * **The roster is recorded, not derived.** It would be possible to answer "who took part" by
 * re-querying the karma ledger for the window, and it would be wrong by Sunday: the ledger
 * is keyed by day, an account can change faction, and karma gets spent. A row written at the
 * time is a fact; a query over live state is an opinion that changes.
 *
 * **Overlap resolves upward.** Two open raids is a legitimate schedule, and `multiplierAt`
 * returns the larger multiplier rather than the product. Compounding is how a pack with a
 * long teardown window accidentally pays 6× for an hour.
 *
 * **The ticker is announcement only.** `tick` emits `RAID_OPENED` and `RAID_CLOSED` on the
 * game channel as windows cross. It carries no economy: the multiplier is read from the
 * clock at award time, so a missed tick loses a banner and not a payout. The seen-set that
 * makes it fire once is per process, which is correct for the single-instance decision in
 * the plan and would need a lock if that ever changed.
 */
import fs from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import { RaidJoin } from '../models/raidJoin.model';
import { Volunteer } from '../models/volunteer.model';
import { eventHub } from '../common/sse/eventHub';
import { domainEvents, DomainEventName } from '../common/events/domainEvents';
import { pack } from '../content/loader';
import { Raid, raidsSchema } from '../content/raids.schema';

/**
 * The events a raid is allowed to count.
 *
 * Listed rather than inferred, because `DomainEventMap` is a type and has no runtime form.
 * The array is typed as `DomainEventName[]`, so an event renamed on the bus fails the build
 * here rather than silently becoming a raid nobody can join.
 */
const JOINABLE_EVENTS: readonly DomainEventName[] = [
  'checkin.completed',
  'checkout.completed',
  'registration.created',
  'gym.captured',
  'hackstop.spun',
  'booth.scanned',
];

/** How many names a raid's roster returns. Beyond this the count is the honest answer. */
const ROSTER_LIMIT = 200;

interface RaidWindow extends Raid {
  startsAtMs: number;
  endsAtMs: number;
}

interface RaidCatalog {
  all: RaidWindow[];
  /** Raids listening for an event, so a join costs one map lookup rather than a scan. */
  byEvent: Map<string, RaidWindow[]>;
}

let catalog: RaidCatalog | null = null;

/**
 * The pack's raid list, read once and sorted by start.
 *
 * `raids.json` is optional. A pack without it has no raids, which makes the board empty and
 * every join a no-op rather than a crash — the same treatment quests and stickers get, and
 * the reason a fork can adopt the platform before it has written a schedule.
 */
function raidCatalog(): RaidCatalog {
  if (catalog) return catalog;
  const file = path.join(pack.dir, 'raids.json');
  if (!fs.existsSync(file)) {
    catalog = { all: [], byEvent: new Map() };
    return catalog;
  }

  const parsed = raidsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const all: RaidWindow[] = parsed.raids
    .map((raid) => ({ ...raid, startsAtMs: Date.parse(raid.startsAt), endsAtMs: Date.parse(raid.endsAt) }))
    .sort((a, b) => a.startsAtMs - b.startsAtMs);

  const byEvent = new Map<string, RaidWindow[]>();
  for (const raid of all) {
    // A venue the pack does not declare would put the raid nowhere on the map. Loud here,
    // because the alternative is a banner pointing at a building that does not exist.
    if (!Object.prototype.hasOwnProperty.call(pack.venues, raid.venue)) {
      throw new Error(`raids.json: raid "${raid.id}" names venue "${raid.venue}", which venues.json does not declare.`);
    }
    for (const event of raid.joinEvents) {
      const listening = byEvent.get(event);
      if (listening) listening.push(raid);
      else byEvent.set(event, [raid]);
    }
  }

  catalog = { all, byEvent };
  return catalog;
}

export type RaidState = 'UPCOMING' | 'OPEN' | 'CLOSED';

export interface RaidSummary {
  id: string;
  title: string;
  blurb: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  karmaMultiplier: number;
  joinEvents: string[];
  state: RaidState;
  /** Milliseconds until the window opens, or until it closes once it has. Null when closed. */
  msUntilChange: number | null;
  joinCount: number;
}

export interface RaidRosterEntry {
  accountId: string;
  name: string;
  faction: string;
  joinedAt: Date;
}

export interface RaidBoard {
  now: Date;
  /** The window that is open, with its roster. Null between raids. */
  current: (RaidSummary & { roster: RaidRosterEntry[]; rosterTruncated: boolean }) | null;
  next: RaidSummary | null;
  raids: RaidSummary[];
}

/** Raid ids this process has already announced as open, and as closed. */
const announcedOpen = new Set<string>();
const announcedClosed = new Set<string>();

function stateOf(raid: RaidWindow, nowMs: number): RaidState {
  if (nowMs < raid.startsAtMs) return 'UPCOMING';
  return nowMs < raid.endsAtMs ? 'OPEN' : 'CLOSED';
}

function summarise(raid: RaidWindow, nowMs: number, joinCount: number): RaidSummary {
  const state = stateOf(raid, nowMs);
  return {
    id: raid.id,
    title: raid.title,
    blurb: raid.blurb,
    venue: raid.venue,
    startsAt: raid.startsAt,
    endsAt: raid.endsAt,
    karmaMultiplier: raid.karmaMultiplier,
    joinEvents: raid.joinEvents,
    state,
    msUntilChange: state === 'UPCOMING' ? raid.startsAtMs - nowMs : state === 'OPEN' ? raid.endsAtMs - nowMs : null,
    joinCount,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

export class RaidService {
  /** The raids that are open at `at`. Empty between windows; more than one when they overlap. */
  public static openAt(at: Date = new Date()): Raid[] {
    const nowMs = at.getTime();
    return raidCatalog().all.filter((raid) => stateOf(raid, nowMs) === 'OPEN');
  }

  /**
   * What karma earned at `at` is worth: the largest multiplier among the open raids, or 1.
   *
   * The largest rather than the product. Overlapping windows are a schedule an organiser
   * writes on purpose, and compounding them is how a sponsor hour inside a teardown window
   * quietly pays three times what either was meant to.
   */
  public static multiplierAt(at: Date = new Date()): number {
    let multiplier = 1;
    for (const raid of RaidService.openAt(at)) {
      if (raid.karmaMultiplier > multiplier) multiplier = raid.karmaMultiplier;
    }
    return multiplier;
  }

  /** The whole schedule, the window that is open now, and who is on its roster. */
  public static async board(at: Date = new Date()): Promise<RaidBoard> {
    const nowMs = at.getTime();
    const raids = raidCatalog().all;
    if (raids.length === 0) return { now: at, current: null, next: null, raids: [] };

    const counts = await RaidJoin.aggregate<{ _id: string; count: number }>([
      { $match: { raidId: { $in: raids.map((raid) => raid.id) } } },
      { $group: { _id: '$raidId', count: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((row) => [row._id, row.count]));

    const summaries = raids.map((raid) => summarise(raid, nowMs, countById.get(raid.id) ?? 0));

    // The first open window is the one the HUD shows. Overlaps are legal, and the earlier
    // start is the one people are already in.
    const openIndex = summaries.findIndex((summary) => summary.state === 'OPEN');
    const next = summaries.find((summary) => summary.state === 'UPCOMING') ?? null;

    if (openIndex === -1) return { now: at, current: null, next, raids: summaries };

    const open = summaries[openIndex];
    const roster = await RaidService.roster(open.id);
    return {
      now: at,
      current: { ...open, roster, rosterTruncated: open.joinCount > roster.length },
      next,
      raids: summaries,
    };
  }

  /** The names on a raid's roster, oldest join first, capped at `ROSTER_LIMIT`. */
  public static async roster(raidId: string): Promise<RaidRosterEntry[]> {
    const rows = await RaidJoin.find({ raidId }).sort({ joinedAt: 1 }).limit(ROSTER_LIMIT).lean();
    if (rows.length === 0) return [];

    const accounts = await Volunteer.find({ _id: { $in: rows.map((row) => row.accountId) } })
      .select('name faction')
      .lean();
    const byId = new Map(accounts.map((account) => [String(account._id), account]));

    return rows.map((row) => {
      const account = byId.get(String(row.accountId));
      return {
        accountId: String(row.accountId),
        // A join whose account has since been deleted still counts; it just has no name.
        name: account?.name ?? 'Unknown',
        faction: account?.faction ?? 'NEUTRAL',
        joinedAt: row.joinedAt,
      };
    });
  }

  /**
   * Enrol an account in every open raid that counts `eventName`.
   *
   * Idempotent by the unique index on (raidId, accountId): a re-delivered event, or twelve
   * spins inside the hour, add one row. Returns the raids newly joined, which is what makes
   * the announcement fire once.
   */
  public static async recordJoin(accountId: string, eventName: string, at: Date = new Date()): Promise<string[]> {
    const listening = raidCatalog().byEvent.get(eventName);
    if (!listening || listening.length === 0) return [];
    if (!Types.ObjectId.isValid(accountId)) return [];

    const nowMs = at.getTime();
    const joined: string[] = [];

    for (const raid of listening) {
      if (stateOf(raid, nowMs) !== 'OPEN') continue;
      try {
        const result = await RaidJoin.updateOne(
          { raidId: raid.id, accountId },
          { $setOnInsert: { raidId: raid.id, accountId, firstEvent: eventName, joinedAt: at } },
          { upsert: true }
        );
        if (result.upsertedCount !== 1) continue;
      } catch (error) {
        // Two events for one account in the same millisecond both miss the row and both try
        // to insert. The index settles it, and the loser is simply not the first.
        if (!isDuplicateKeyError(error)) throw error;
        continue;
      }

      joined.push(raid.id);
      eventHub.broadcast({
        type: 'RAID_JOINED',
        channel: 'game',
        data: { raidId: raid.id, title: raid.title, accountId, via: eventName },
      });
    }

    return joined;
  }

  /**
   * Announce windows opening and closing. Idempotent per process; safe to call every tick.
   *
   * No economy runs here on purpose. The multiplier is read from the clock when karma is
   * awarded, so a tick that never fires costs a banner rather than a payout.
   */
  public static tick(at: Date = new Date()): void {
    const nowMs = at.getTime();
    for (const raid of raidCatalog().all) {
      const state = stateOf(raid, nowMs);
      if (state === 'OPEN' && !announcedOpen.has(raid.id)) {
        announcedOpen.add(raid.id);
        eventHub.broadcast({
          type: 'RAID_OPENED',
          channel: 'game',
          data: { raidId: raid.id, title: raid.title, blurb: raid.blurb, venue: raid.venue, endsAt: raid.endsAt, karmaMultiplier: raid.karmaMultiplier },
        });
      }
      if (state === 'CLOSED' && announcedOpen.has(raid.id) && !announcedClosed.has(raid.id)) {
        announcedClosed.add(raid.id);
        eventHub.broadcast({
          type: 'RAID_CLOSED',
          channel: 'game',
          data: { raidId: raid.id, title: raid.title, venue: raid.venue },
        });
      }
    }
  }

  /**
   * Subscribe raid enrolment to the domain bus. Returns an unsubscribe for tests.
   *
   * Every joinable event is subscribed regardless of what the pack asks for; `recordJoin`
   * does the filtering. One listener per event is cheaper to reason about than a set that
   * changes with the content, and the pack is read once anyway.
   */
  public static subscribe(): () => void {
    const offs = JOINABLE_EVENTS.map((name) =>
      domainEvents.on(name, (payload) => {
        // `sos.resolved` is not joinable precisely because it carries no `accountId`; every
        // event in the list above does.
        const accountId = (payload as { accountId?: string }).accountId;
        if (!accountId) return;
        void RaidService.recordJoin(accountId, name).catch((err) =>
          console.warn(`[raids] ${name} join failed: ${(err as Error).message}`)
        );
      })
    );
    return () => offs.forEach((off) => off());
  }

  /** Test hook: the catalog and the announced-once sets outlive a suite otherwise. */
  public static __reset(): void {
    catalog = null;
    announcedOpen.clear();
    announcedClosed.clear();
  }
}
