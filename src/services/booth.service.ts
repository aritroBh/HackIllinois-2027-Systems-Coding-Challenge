/**
 * Sponsor booths (plan §A6).
 *
 * A booth is a table with a printed QR poster on it, and scanning it pays once per account,
 * ever. The list is content (`booths.json`); this service is the two rules behind it — the
 * code has to be genuine, and the pair (account, booth) has to be new.
 *
 * **The code is derived, not stored.** `codeFor` is an HMAC over the booth id under
 * `QR_HMAC_SECRET`, truncated to twelve hex characters. Three things follow from that, and
 * all three are the reason it is not a column in the pack:
 *
 *  - The pack is public. It is served to every browser under `/dashboard/content`, so a code
 *    written into `booths.json` would be a list of free karma with a nice `_about` field.
 *  - Nothing has to be provisioned. Print the posters from the same secret the deployment
 *    already refuses to boot without; there is no code table to seed, migrate or leak.
 *  - Rotating the secret invalidates every poster at once, which is the behaviour you want
 *    the day a photo of one ends up in a group chat.
 *
 * Twelve hex characters is 48 bits. That is not a key, and it does not need to be: it is
 * guarded by the API rate limiter and by the fact that a successful guess pays one booth's
 * karma once. It is short enough to read off a sign and type, which is the failure mode that
 * actually happens at a table.
 *
 * Unlike the check-in token this code is deliberately **static**. A poster is printed on
 * Thursday and taped to a table until Sunday; a rotating code would need a screen at every
 * booth. Outside production `QR_HMAC_SECRET` is ephemeral per boot, so dev codes change on
 * restart — mint them from a running server rather than writing them down.
 *
 * **Order of writes.** The scan row goes in first and the karma second, because the scan row
 * is what makes the payment once-only. If the award then fails, the row is removed so the
 * scan can be retried; the alternative is a booth that is marked scanned and was never paid,
 * with nothing that ever repairs it. Same shape as quest settlement.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import { BoothScan } from '../models/boothScan.model';
import { PowerUpInventory, PowerUpType, POWER_UP_CATALOG } from '../models/powerup.model';
import { KarmaSourceKey } from '../common/karmaSources';
import { KarmaService } from './karma.service';
import { StickerService } from './sticker.service';
import { eventHub } from '../common/sse/eventHub';
import { domainEvents } from '../common/events/domainEvents';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { env } from '../config/env';
import { pack } from '../content/loader';
import { Booth, boothsSchema } from '../content/booths.schema';

/** The cap bucket booth rewards are paid from; matched against `pack.event.karmaCaps`. */
const KARMA_SOURCE: KarmaSourceKey = 'BOOTH';

/** Domain separation, so a booth code can never be replayed as some other HMAC in this app. */
const CODE_PREFIX = 'booth:v1:';

/** Hex characters of HMAC kept. Long enough not to be guessed at a table, short enough to type. */
const CODE_LENGTH = 12;

interface BoothCatalog {
  byId: Map<string, Booth>;
  all: Booth[];
}

let catalog: BoothCatalog | null = null;

/**
 * The pack's booth list, read once.
 *
 * `booths.json` is optional: a pack without it has no booths and every scan is a 404, which
 * is how a fork adopts the platform before it has sponsors. Rewards are cross-checked here
 * rather than in the Zod schema because the vocabularies they draw on live in other files,
 * and the message is only useful if it can name the file that has to change.
 */
function boothCatalog(): BoothCatalog {
  if (catalog) return catalog;
  const file = path.join(pack.dir, 'booths.json');
  if (!fs.existsSync(file)) {
    catalog = { byId: new Map(), all: [] };
    return catalog;
  }

  const parsed = boothsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  for (const booth of parsed.booths) {
    if (!Object.prototype.hasOwnProperty.call(pack.venues, booth.venue)) {
      throw new Error(`booths.json: booth "${booth.id}" names venue "${booth.venue}", which venues.json does not declare.`);
    }
    if (booth.reward.powerUp && !Object.prototype.hasOwnProperty.call(POWER_UP_CATALOG, booth.reward.powerUp)) {
      throw new Error(`booths.json: booth "${booth.id}" rewards power-up "${booth.reward.powerUp}", which the power-up catalog does not define.`);
    }
    // The sticker too, which the comment above already claimed and this did not do.
    //
    // A typo here used to surface at scan time, from inside the grant: the karma was paid,
    // `StickerService.award` threw a 404, the scan row stayed (correctly — money had moved),
    // and the scanner got an error with the sticker and the power-up lost for good and no
    // path that repairs it. The venue and the power-up were both checked at load; this is the
    // third vocabulary the file draws on and the only one that was not.
    if (booth.reward.sticker && !StickerService.knows(booth.reward.sticker)) {
      throw new Error(`booths.json: booth "${booth.id}" rewards sticker "${booth.reward.sticker}", which memorabilia.json does not declare.`);
    }
  }

  catalog = { byId: new Map(parsed.booths.map((booth) => [booth.id, booth])), all: parsed.booths };
  return catalog;
}

/**
 * Codes are read off a sign and typed by someone who has been awake for thirty hours.
 * Case and separators are noise; everything else has to match.
 */
function normaliseCode(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

export interface BoothScanResult {
  boothId: string;
  sponsor: string;
  name: string;
  venue: string;
  awardedKarma: number;
  /** True when the daily cap on the booth source held part of the award back. */
  karmaCapped: boolean;
  sticker: string | null;
  powerUp: PowerUpType | null;
}

export class BoothService {
  /**
   * The code printed on a booth's poster. Deterministic for a given secret and booth id.
   *
   * Exported rather than private because posters have to be produced from somewhere, and the
   * organiser tooling that prints them should derive them the same way the scanner verifies
   * them rather than keeping a second copy.
   */
  public static codeFor(boothId: string, secret: string = env.QR_HMAC_SECRET): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${CODE_PREFIX}${boothId}`)
      .digest('hex')
      .slice(0, CODE_LENGTH)
      .toUpperCase();
  }

  /** Every booth in the pack. Codes are never included; this is the public map layer. */
  public static list(): Booth[] {
    return boothCatalog().all;
  }

  /**
   * Record a scan and pay for it.
   *
   * @param accountId Who scanned. Any account kind: booths are for hackers as much as staff.
   * @param boothId The booth from the URL, matched against the pack.
   * @param presentedCode What was scanned or typed.
   */
  public static async scan(accountId: string, boothId: string, presentedCode: string): Promise<BoothScanResult> {
    const booth = boothCatalog().byId.get(boothId);
    if (!booth) {
      throw ApiError.notFound(`No booth "${boothId}" in content pack ${pack.event.id}.`, ErrorCode.NOT_FOUND);
    }
    if (!Types.ObjectId.isValid(accountId)) {
      throw ApiError.badRequest('A booth scan needs a valid account id.', { boothId });
    }

    // Constant-time, and only after both strings are the same length — `timingSafeEqual`
    // throws on a mismatch rather than returning false, so a short code would be a 500.
    const presented = Buffer.from(normaliseCode(presentedCode), 'utf8');
    const expected = Buffer.from(BoothService.codeFor(boothId), 'utf8');
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      throw ApiError.forbidden(`That code does not belong to ${booth.name}.`);
    }

    // The insert is the guarantee, so it happens before anything is paid. Twenty phones on
    // one poster in one second produce one winner here and nineteen 409s.
    let scan;
    try {
      scan = await BoothScan.create({ accountId, boothId, karmaAwarded: 0, scannedAt: new Date() });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 11000) {
        throw ApiError.conflict(`You have already scanned ${booth.name}.`, ErrorCode.DUPLICATE_RESOURCE, { boothId });
      }
      throw error;
    }

    // Whether anything has been GRANTED yet — karma, sticker or power-up, not karma alone.
    //
    // The compensating delete below hands the booth back by removing the row that makes a
    // scan once-ever, which is only safe while nothing has moved. It tracked the karma award
    // and nothing else, and the reward is three things: a booth priced at zero karma (or one
    // whose karma the daily cap has clamped to nothing) that grants a power-up would leave
    // this flag false, so a transient failure on the write *after* the grant deleted the
    // scan row and handed the booth back — with the power-up already in the inventory. The
    // retry then passes the uniqueness insert and `$inc`s a second one, which is exactly the
    // once-ever violation this flag exists to prevent, reached through the one reward that
    // was not being counted.
    //
    // The sticker grant is idempotent on its own ledger, so it is not the dangerous one; it
    // is included anyway, because "has anything moved" is the question and enumerating the
    // exceptions is how this went wrong the first time.
    let granted = false;
    try {
      let awardedKarma = 0;
      let karmaCapped = false;
      if (booth.reward.karma > 0) {
        // Through the ledger like every other award, and capped by `karmaCaps.BOOTH` —
        // which every pack must now price, because an unpriced source is an unlimited one.
        const award = await KarmaService.awardKarma(accountId, booth.reward.karma, KARMA_SOURCE, { boothId, sponsor: booth.sponsor });
        awardedKarma = award.awarded;
        karmaCapped = award.capped;
        granted = granted || award.awarded > 0;
      }

      if (booth.reward.sticker) {
        await StickerService.award(accountId, booth.reward.sticker, `BOOTH:${boothId}`);
        granted = true;
      }

      const powerUp = (booth.reward.powerUp ?? null) as PowerUpType | null;
      if (powerUp) {
        const meta = POWER_UP_CATALOG[powerUp];
        // The plan calls this a timed item. `PowerUpInventory` has no expiry field yet, so
        // it is granted untimed; adding `expiresAt` belongs to the power-up model.
        await PowerUpInventory.findOneAndUpdate(
          { volunteerId: accountId, itemType: powerUp },
          { $inc: { quantity: 1 }, $setOnInsert: { name: meta.name, rarity: meta.rarity, obtainedFrom: `BOOTH:${boothId}` } },
          { upsert: true, new: true }
        );
        granted = true;
      }

      await BoothScan.updateOne({ _id: scan._id }, { $set: { karmaAwarded: awardedKarma } });

      // The scan is committed; quests and plugins subscribe rather than being called here.
      domainEvents.emit('booth.scanned', { accountId, boothId });

      eventHub.broadcast({
        type: 'BOOTH_SCANNED',
        channel: 'game',
        data: { accountId, boothId, sponsor: booth.sponsor, name: booth.name, venue: booth.venue, awardedKarma },
      });

      return {
        boothId,
        sponsor: booth.sponsor,
        name: booth.name,
        venue: booth.venue,
        awardedKarma,
        karmaCapped,
        sticker: booth.reward.sticker ?? null,
        powerUp,
      };
    } catch (error) {
      // Hand the booth back only if nothing was granted. A failure after any part of the
      // reward has landed leaves the scan row standing: something moved, so the once-ever
      // guard has to stand with it. The caller still gets the error and can retry, and the
      // retry gets a clean 409 rather than a second grant.
      if (!granted) {
        await BoothScan.deleteOne({ _id: scan._id });
      } else {
        console.error(
          `[booth] ${boothId} granted ${accountId} part of its reward and then failed; scan row kept so the booth cannot be scanned twice.`,
          error
        );
      }
      throw error;
    }
  }

  /** Test hook: the catalog is read once and would outlive a suite that swaps packs. */
  public static __reset(): void {
    catalog = null;
  }
}
