/**
 * Quests (plan §A6).
 *
 * A quest turns something a player already does into something the event notices. The list
 * lives in the pack (`quests.json`); this service is the machinery behind it, and it knows
 * only three ways to count. COUNT increments once per event. DISTINCT collects the payload
 * field the quest names, so twelve spins of the same beacon are one beacon. STREAK records
 * the window it advanced in and reads back the run of consecutive windows ending at the
 * newest, so a missed day breaks the streak without anything having to sweep it.
 *
 * `advance` is called from domain event listeners, never from a request handler. That is
 * what makes the design tractable: the caller has already answered its request, so the cost
 * here is off the critical path, and a quest rule with a bug fails the reward rather than
 * the check-in that earned it.
 *
 * **Exactly-once has two halves, and they are different mechanisms.** Progress is idempotent
 * because every write is an upsert against the unique index on
 * `(accountId, questId, windowKey)`: a re-delivered event cannot open a second row. The
 * reward is exactly-once because completion is a conditional update on `completedAt: null` —
 * whoever matches it pays, and there is exactly one such match no matter how many concurrent
 * advances cross the target line together. Checking `row.completedAt` in JavaScript first
 * would be a read-then-write race, and the thing it would race to duplicate is karma.
 *
 * Karma is never written here. `KarmaService.awardKarma` is the only writer of `karmaPoints`
 * and the only place the pack's daily caps are applied, so a quest that pays 400 karma pays
 * whatever is left of the `QUEST` budget, not 400 regardless.
 *
 * **Windows are event-local.** An hourly window in Chicago must not roll over at 6 p.m.
 * because UTC says so, so the buckets are formatted in the pack's timezone and the day key
 * is the same `eventDay` the karma ledger caps by. Adjacency for a streak is calendar
 * adjacency: two dates one apart, or two hours one apart, which is what a player means by
 * "two days running" even across a daylight-saving change.
 */
import fs from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import { QuestProgress, IQuestProgress } from '../models/questProgress.model';
import { CheckIn } from '../models/checkin.model';
import { eventDay } from '../models/karmaLedger.model';
import { KarmaSourceKey } from '../common/karmaSources';
import { KarmaService } from './karma.service';
import { StickerService } from './sticker.service';
import { eventHub } from '../common/sse/eventHub';
import { ApiError } from '../common/errors/apiError';
import { pack } from '../content/loader';
import { Quest, QuestWindow, questsSchema } from '../content/quests.schema';

/** The cap bucket quest rewards are paid from; matched against `pack.event.karmaCaps`. */
const KARMA_SOURCE: KarmaSourceKey = 'QUEST';

/** The window key of a quest that runs once for the whole event. */
const EVENT_WINDOW_KEY = 'event';

export interface QuestAdvanceResult {
  questId: string;
  windowKey: string;
  progress: number;
  target: number;
  /** True only for the advance that crossed the line, so a caller can log the moment. */
  completed: boolean;
}

export interface QuestStatus {
  id: string;
  title: string;
  blurb: string;
  kind: Quest['kind'];
  window: QuestWindow;
  anchoredToDuty: boolean;
  target: number;
  progress: number;
  windowKey: string;
  completed: boolean;
  completedAt: Date | null;
  reward: Quest['reward'];
}

interface QuestCatalog {
  all: Quest[];
  byEvent: Map<string, Quest[]>;
}

let catalog: QuestCatalog | null = null;

/**
 * The pack's quest list, read once.
 *
 * `quests.json` is optional. A pack without it has no quests, which makes every advance a
 * no-op rather than a crash — the same treatment `memorabilia.json` gets in the sticker
 * service, and the reason a fork can adopt the platform before it has written any quests.
 */
function questCatalog(): QuestCatalog {
  if (catalog) return catalog;
  const file = path.join(pack.dir, 'quests.json');
  if (!fs.existsSync(file)) {
    catalog = { all: [], byEvent: new Map() };
    return catalog;
  }
  const parsed = questsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const byEvent = new Map<string, Quest[]>();
  for (const quest of parsed.quests) {
    // A sticker id the pack never declared, refused at load rather than at settlement.
    //
    // `settle()` pays the karma and then grants the sticker, and a 404 from the grant leaves
    // a quest that has been paid for and cannot be completed — recoverable only because the
    // `paid` flag keeps the completion. Better not to reach that at all: this is a typo in a
    // JSON file, and the moment to say so is when the file is read.
    if (quest.reward.sticker && !StickerService.knows(quest.reward.sticker)) {
      throw new Error(`quests.json: quest "${quest.id}" rewards sticker "${quest.reward.sticker}", which memorabilia.json does not declare.`);
    }
    const listening = byEvent.get(quest.event);
    if (listening) listening.push(quest);
    else byEvent.set(quest.event, [quest]);
  }
  catalog = { all: parsed.quests, byEvent };
  return catalog;
}

let hourFormatter: Intl.DateTimeFormat | null = null;

/**
 * `YYYY-MM-DDTHH` in the event's timezone.
 *
 * `h23` pins midnight to `00` rather than `24`, and the hour is taken from `formatToParts`
 * rather than from the formatted string, which for an hour-only format is free to carry a
 * unit ("14 h") that would make the key unparseable.
 */
function eventHour(at: Date): string {
  if (!hourFormatter) {
    hourFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: pack.event.timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
  }
  const hour = hourFormatter.formatToParts(at).find((part) => part.type === 'hour')?.value ?? '00';
  return `${eventDay(at)}T${hour.padStart(2, '0')}`;
}

function windowBucket(window: QuestWindow, at: Date): string {
  if (window === 'HOURLY') return eventHour(at);
  if (window === 'DAILY') return eventDay(at);
  return EVENT_WINDOW_KEY;
}

/**
 * Which row a quest's progress belongs in.
 *
 * A STREAK is the one kind whose row is not its window: the run has to outlive the windows
 * it counts, so it lives in the event row and the windows themselves go into `distinct`.
 * For every other kind the row *is* the window, which is what makes an hourly quest repeat
 * without anything having to reset it.
 */
function rowWindowKey(quest: Quest, at: Date): string {
  return quest.kind === 'STREAK' ? EVENT_WINDOW_KEY : windowBucket(quest.window, at);
}

/**
 * A window key as a whole number of hours or days, for adjacency tests only.
 *
 * The key is read as calendar fields rather than as an instant, so 02:00 following 01:00 is
 * adjacent whether or not a daylight-saving change made those two hours something other than
 * sixty minutes apart.
 */
function bucketOrdinal(window: QuestWindow, key: string): number {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  if (window === 'HOURLY') return Date.UTC(year, month - 1, day, Number(key.slice(11, 13))) / 3_600_000;
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** The run of consecutive windows ending at the newest one recorded. */
function trailingRun(window: QuestWindow, keys: string[]): number {
  if (keys.length === 0) return 0;
  const ordinals = keys.map((key) => bucketOrdinal(window, key)).sort((a, b) => a - b);
  let run = 1;
  for (let i = ordinals.length - 1; i > 0; i -= 1) {
    if (ordinals[i] - ordinals[i - 1] !== 1) break;
    run += 1;
  }
  return run;
}

/** Progress towards the target, read the way this quest's kind counts. */
function progressOf(quest: Quest, row: Pick<IQuestProgress, 'count' | 'distinct'>): number {
  if (quest.kind === 'COUNT') return row.count;
  if (quest.kind === 'DISTINCT') return row.distinct.length;
  return trailingRun(quest.window, row.distinct);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

/**
 * The value a quest collects from an event payload, or null when the payload does not carry
 * it. A DISTINCT quest naming a field its event never sends cannot advance; skipping is how
 * that stays visible as a quest stuck at zero, rather than as one counted once and then
 * never again.
 */
function distinctValue(quest: Quest, meta: Record<string, unknown>, at: Date): string | null {
  if (quest.kind === 'STREAK') return windowBucket(quest.window, at);
  if (!quest.distinctBy) return null;
  const raw = meta[quest.distinctBy];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !(raw instanceof Types.ObjectId)) return null;
  const value = String(raw);
  return value.length > 0 && value.length <= 200 ? value : null;
}

export class QuestService {
  /**
   * Every `event` name the active pack's quests declare, deduplicated.
   *
   * Exists so `economy/wiring.ts` can warn at boot about a quest naming an event no listener
   * subscribes to. The catalogue is module-private and the subscriptions live in the wiring, so
   * one of the two has to reach across; an accessor here is smaller than exporting the catalogue
   * or widening `ContentPack` to carry quests.
   */
  public static declaredEvents(): string[] {
    return [...new Set(questCatalog().all.map((quest) => quest.event).filter(Boolean))] as string[];
  }

  /**
   * Read the catalog now, so a bad pack fails at boot rather than at the first player.
   *
   * The cross-checks live inside the lazy read — that is the right place for them, since it
   * is the only place that has the parsed file — but a lazy read runs when somebody scans a
   * poster or finishes a quest, and by then the karma has been paid and the failure is a 404
   * in one player's face. The docblocks say these vocabularies are refused at boot; this is
   * what makes that true.
   */
  public static warm(): void {
    questCatalog();
  }

  /**
   * Advances every quest listening for `eventType`, and pays the ones that finish.
   *
   * `meta` is the domain event's payload. DISTINCT quests read one named field out of it;
   * `onDuty` is honoured when the caller already knows the answer, and looked up once
   * otherwise, so an event that touches no anchored quest costs no extra query.
   *
   * Returns one entry per quest that moved, which is what the economy tests assert on.
   */
  public static async advance(
    accountId: string,
    eventType: string,
    meta: Record<string, unknown> = {},
    at: Date = new Date()
  ): Promise<QuestAdvanceResult[]> {
    const listening = questCatalog().byEvent.get(eventType);
    if (!listening || listening.length === 0) return [];
    if (!Types.ObjectId.isValid(accountId)) {
      throw ApiError.badRequest(`Cannot advance quests for "${accountId}": not an account id.`, { eventType });
    }

    let onDuty: boolean | null = typeof meta.onDuty === 'boolean' ? meta.onDuty : null;
    const isOnDuty = async (): Promise<boolean> => {
      // An open check-in is the definition of on duty: scanned in, not yet scanned out.
      if (onDuty === null) onDuty = (await CheckIn.exists({ volunteerId: accountId, checkOutTime: null })) !== null;
      return onDuty;
    };

    const results: QuestAdvanceResult[] = [];
    for (const quest of listening) {
      if (quest.anchoredToDuty && !(await isOnDuty())) continue;

      const collected = quest.kind === 'COUNT' ? null : distinctValue(quest, meta, at);
      if (quest.kind !== 'COUNT' && collected === null) continue;

      const windowKey = rowWindowKey(quest, at);
      const row = await QuestService.claimProgress(accountId, quest.id, windowKey, collected);
      const progress = progressOf(quest, row);

      if (progress < quest.target) {
        // `count` is the derived progress for the kinds that count by collection, written
        // back so `forAccount` and a human reading the collection need not re-derive it.
        if (row.count !== progress) {
          await QuestProgress.updateOne({ _id: row._id, count: { $ne: progress } }, { $set: { count: progress } });
        }
        results.push({ questId: quest.id, windowKey, progress, target: quest.target, completed: false });
        continue;
      }

      const completed = await QuestService.settle(accountId, quest, row, progress);
      results.push({ questId: quest.id, windowKey, progress, target: quest.target, completed });
    }
    return results;
  }

  /** Every quest in the pack, with this account's progress in the window each runs in now. */
  public static async forAccount(accountId: string, at: Date = new Date()): Promise<QuestStatus[]> {
    if (!Types.ObjectId.isValid(accountId)) {
      throw ApiError.badRequest(`Cannot read quests for "${accountId}": not an account id.`);
    }
    const quests = questCatalog().all;
    if (quests.length === 0) return [];

    const keyed = quests.map((quest) => ({ quest, windowKey: rowWindowKey(quest, at) }));
    const rows = await QuestProgress.find({
      accountId,
      $or: keyed.map(({ quest, windowKey }) => ({ questId: quest.id, windowKey })),
    }).lean();

    const byKey = new Map(rows.map((row) => [`${row.questId} ${row.windowKey}`, row]));
    return keyed.map(({ quest, windowKey }) => {
      const row = byKey.get(`${quest.id} ${windowKey}`);
      return {
        id: quest.id,
        title: quest.title,
        blurb: quest.blurb,
        kind: quest.kind,
        window: quest.window,
        anchoredToDuty: quest.anchoredToDuty,
        target: quest.target,
        progress: row ? progressOf(quest, row) : 0,
        windowKey,
        completed: !!row?.completedAt,
        completedAt: row?.completedAt ?? null,
        reward: quest.reward,
      };
    });
  }

  /**
   * The upsert that records one advance.
   *
   * A first advance and a concurrent first advance both miss the row and both try to insert
   * it; the unique index rejects the loser with a duplicate key, and re-running finds the
   * winner's row. One retry is enough, because after the first failure the row exists.
   */
  private static async claimProgress(
    accountId: string,
    questId: string,
    windowKey: string,
    collected: string | null
  ): Promise<IQuestProgress> {
    const filter = { accountId, questId, windowKey };
    const update = collected === null ? { $inc: { count: 1 } } : { $addToSet: { distinct: collected } };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const row = await QuestProgress.findOneAndUpdate(filter, update, { upsert: true, new: true });
        if (row) return row;
      } catch (error) {
        if (!isDuplicateKeyError(error) || attempt === 1) throw error;
      }
    }
    throw ApiError.internal(`Could not record progress for quest "${questId}".`);
  }

  /**
   * Marks a quest finished and pays for it, at most once per row.
   *
   * The conditional match on `completedAt: null` is the guard. Karma is paid before the
   * sticker because the sticker is decoration and the karma is the balance: a sticker
   * service refusing an id the pack never declared must not cost a player the award they
   * earned.
   */
  private static async settle(
    accountId: string,
    quest: Quest,
    row: IQuestProgress,
    progress: number
  ): Promise<boolean> {
    const won = await QuestProgress.findOneAndUpdate(
      { _id: row._id, completedAt: null },
      { $set: { completedAt: new Date(), count: progress } },
      { new: true }
    );
    if (!won) return false;

    // Pay before announcing. The CAS above is what makes completion exactly once, so a
    // payout that throws here would otherwise leave a quest marked complete, announced as
    // complete, and never paid, with no way to retry it. Failing before the broadcast is
    // recoverable; failing after it is a lie the player can see.
    // Whether anything has been paid yet, for the same reason the booth scan tracks it: the
    // compensating write below un-completes the quest, and un-completing a quest that has
    // already paid makes a once-per-event reward repeatable. A sticker write failing after
    // the karma landed did exactly that — the next matching event re-settled the quest and
    // paid again, bounded only by the daily QUEST cap. The docblock at the top of this file
    // says the reward is exactly-once; this is what makes that true rather than usually true.
    let paid = false;
    let grantedKarma = 0;
    try {
      if (quest.reward.karma > 0) {
        const award = await KarmaService.awardKarma(accountId, quest.reward.karma, KARMA_SOURCE, {
          questId: quest.id,
          windowKey: won.windowKey,
        });
        paid = award.awarded > 0;
        grantedKarma = award.awarded;
      }
      if (quest.reward.sticker) {
        await StickerService.award(accountId, quest.reward.sticker, `QUEST:${quest.id}`);
      }
    } catch (error) {
      // Hand the completion back only if nothing was paid; otherwise the completion stands
      // and the failure is logged, because the alternative is paying for it twice.
      if (!paid) {
        await QuestProgress.updateOne({ _id: won._id }, { $set: { completedAt: null } });
      } else {
        console.error(
          `[quest] ${quest.id} paid ${accountId} and then failed; completion kept so it cannot settle twice.`,
          error
        );
      }
      throw error;
    }

    eventHub.broadcast({
      type: 'QUEST_COMPLETED',
      channel: 'game',
      data: {
        accountId,
        questId: quest.id,
        title: quest.title,
        windowKey: won.windowKey,
        // Granted, not advertised. The daily QUEST cap can clamp a 400-karma quest to the
        // remainder — or to nothing — and announcing the reward regardless told the player
        // they had been paid four hundred while their balance did not move. Checkout, gym,
        // HackStop and booth all put the granted figure on the wire; this was the one that
        // put the price tag there instead.
        karma: grantedKarma,
        // What the quest was worth, so a capped player can see why the two differ rather
        // than concluding the number is simply wrong.
        karmaOffered: quest.reward.karma,
        sticker: quest.reward.sticker ?? null,
      },
    });

    return true;
  }
}
