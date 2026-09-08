/**
 * Sticker awards (plan §A6).
 *
 * The sticker book is content, not code: `memorabilia.json` in the active pack decides which
 * stickers exist, what they are called and how they are drawn. This service is the only way
 * a row enters the book, and it refuses an id the pack does not declare, so a typo in a
 * reward rule fails at the award rather than showing up in a player's collection as a blank
 * frame the renderer cannot draw.
 *
 * An award writes in two places. `StickerLedger` is the record and carries the uniqueness
 * guarantee; `Volunteer.badges` is the denormalised copy that the offline card and the
 * leaderboard read without a join. The ledger is written first, because it is the one that
 * decides whether the award was new.
 *
 * Awards are expected to arrive more than once. A rule may fire on a re-delivered event, two
 * rules may grant the same sticker, and a player may spin the same beacon twice. `award` is
 * therefore idempotent by construction and only announces a sticker the first time.
 */
import fs from 'fs';
import path from 'path';
import { StickerLedger } from '../models/stickerLedger.model';
import { Volunteer } from '../models/volunteer.model';
import { eventHub } from '../common/sse/eventHub';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { pack } from '../content/loader';
import { memorabiliaSchema } from '../content/schema';

interface StickerMeta {
  id: string;
  name: string;
  kind: string;
  rarity: string;
}

interface StickerCatalog {
  byId: Map<string, StickerMeta>;
  total: number;
}

let catalog: StickerCatalog | null = null;

/**
 * The pack's sticker book, read once.
 *
 * `memorabilia.json` is optional and is already validated at boot by the content loader, so
 * the parse here cannot fail on a booted process. A pack without the file has an empty book,
 * which makes every award a 404 rather than a crash.
 */
function stickerCatalog(): StickerCatalog {
  if (catalog) return catalog;
  const file = path.join(pack.dir, 'memorabilia.json');
  if (!fs.existsSync(file)) {
    catalog = { byId: new Map(), total: 0 };
    return catalog;
  }
  const parsed = memorabiliaSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const byId = new Map<string, StickerMeta>();
  for (const item of parsed.items) {
    byId.set(item.id, { id: item.id, name: item.name, kind: item.kind, rarity: item.rarity });
  }
  catalog = { byId, total: byId.size };
  return catalog;
}

/** True for Mongo duplicate-key write failures, which concurrent first-writes produce. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}

export interface OwnedStickers {
  owned: string[];
  total: number;
}

/**
 * Collectible sticker service granting achievement badges and tracking digital sticker albums.
 */
export class StickerService {
  /**
   * Whether the pack declares this sticker id.
   *
   * For the catalogs that *reward* a sticker — booths, quests — so they can refuse a typo at
   * boot instead of at the moment somebody scans a poster. `award` throws on an unknown id,
   * which is correct there and far too late here: by then the karma has been paid, the
   * failure is a 404 to the scanner, and the reward is lost with no path that repairs it.
   */
  public static knows(stickerId: string): boolean {
    return stickerCatalog().byId.has(stickerId);
  }

  /**
   * Grant `stickerId` to `accountId`. Returns true when the sticker was new to this account
   * and false when it already held it.
   */
  public static async award(accountId: string, stickerId: string, source: string): Promise<boolean> {
    const meta = stickerCatalog().byId.get(stickerId);
    if (!meta) {
      throw ApiError.notFound(`No sticker "${stickerId}" in content pack ${pack.event.id}.`, ErrorCode.NOT_FOUND);
    }

    let isNew: boolean;
    try {
      const result = await StickerLedger.updateOne(
        { accountId, stickerId },
        { $setOnInsert: { accountId, stickerId, source, awardedAt: new Date() } },
        { upsert: true }
      );
      isNew = result.upsertedCount === 1;
    } catch (error) {
      // Two concurrent awards can both miss the existing row and both try to insert; the
      // unique index settles it and the loser is simply the one that was not first.
      if (!isDuplicateKeyError(error)) throw error;
      isNew = false;
    }

    // Unconditional, and cheap because it is an indexed no-op when the id is already there.
    // Running it only for a new award would leave `badges` permanently short of the ledger
    // if the process died between the two writes, with no path that ever repairs it.
    await Volunteer.updateOne({ _id: accountId }, { $addToSet: { badges: stickerId } });

    if (isNew) {
      eventHub.broadcast({
        type: 'STICKER_AWARDED',
        channel: 'game',
        data: {
          accountId,
          stickerId,
          name: meta.name,
          kind: meta.kind,
          rarity: meta.rarity,
          source,
        },
      });
    }

    return isNew;
  }

  /** The account's collection, with the pack's total so a caller can render "7 of 24". */
  public static async forAccount(accountId: string): Promise<OwnedStickers> {
    const rows = await StickerLedger.find({ accountId }).select('stickerId awardedAt').sort({ awardedAt: 1 }).lean();
    return { owned: rows.map((row) => row.stickerId), total: stickerCatalog().total };
  }
}
