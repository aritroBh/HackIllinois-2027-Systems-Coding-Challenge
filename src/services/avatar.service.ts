/**
 * Avatar upload, review and takedown (plan §A5).
 *
 * The upload path is deliberately paranoid. A PNG that arrives here is decoded by pngjs and
 * re-encoded from its raw pixels before anything is stored: the bytes we serve are ours, not
 * the uploader's, so metadata chunks, trailing archives and polyglot tricks do not survive
 * the round trip. Only then is the sha256 taken, which means the hash identifies the image
 * rather than the file.
 *
 * Sharing is opt-in and reviewed, and it takes **both**: an avatar is visible to its owner and
 * to leads while PENDING, and to other players once it is APPROVED *and* its owner set
 * `shareOptIn`. Approval alone does not publish — `fetch` requires the pair (see the note on it
 * below, which has always said so while this paragraph said only "once APPROVED"). An approved
 * avatar whose owner never opted in stays owner-and-lead-only, which is a support question rather
 * than a leak, but the shorter sentence was believed and wrong. Three distinct reporters — or one lead —
 * unpublish it immediately and emit `AVATAR_UNPUBLISHED` on the `game` channel, which is
 * what evicts the texture from every connected renderer's cache.
 */
import crypto from 'crypto';
import { PNG } from 'pngjs';
import { Types } from 'mongoose';
import { Avatar, AvatarStatus, IAvatar } from '../models/avatar.model';
import { Volunteer } from '../models/volunteer.model';
import { eventHub } from '../common/sse/eventHub';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { presenceService } from '../presence/service';

/**
 * The four accepted geometries, and the list is closed.
 *
 * A frame is 32 wide and either 32 (a head) or 48 (a full body) tall; a walk sheet is four
 * of those laid out horizontally, so 128 wide at the same two heights. `public/avatar.js`
 * bakes a webcam capture into the 128×48 case — `FW = 32, FH = 48, FRAMES = 4` there — and
 * the other three are accepted too, which is what lets a hand-drawn single frame or a
 * head-only sheet through. An earlier version of this comment listed only three of the four.
 *
 * Checked twice against this list in `upload`: once against the width and height declared in
 * the IHDR, before pngjs is allowed to allocate anything, and again against the decoded
 * image — because the header is the uploader's claim and the decode is the truth.
 */
const ALLOWED_SIZES: ReadonlyArray<[number, number]> = [
  [128, 48],
  [128, 32],
  [32, 32],
  [32, 48],
];
/**
 * Exported so that this and the `express.raw` body limit in `avatar.routes.ts` are one
 * constant rather than two numbers somebody has to keep equal by hand.
 *
 * Because they are equal, Express refuses anything larger with its own 413 before this
 * service is reached, so the length check at the top of `upload` never fires through that
 * route. It stands for any caller that is not that route, which would otherwise hand pngjs
 * an arbitrarily large buffer with nothing in between.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024;
/** Per account per hour, in this process only — see `rateOk` for what that is worth. */
const UPLOADS_PER_HOUR = 20;
/** Distinct reporters, not reports: `flag` counts the set of reporter ids on the document. */
const FLAGS_TO_UNPUBLISH = 3;

/**
 * account → recent upload times. In-process, so it is empty after a restart and is not
 * shared between replicas: the hourly budget is per instance, and a redeploy hands everybody
 * a fresh one. That is the honest bound on this. It is a nuisance limiter rather than a
 * security control — the controls are the 64 KB cap, the closed size list and the re-encode.
 */
const recentUploads = new Map<string, number[]>();
/** reporter → times, so one account cannot mass-report the field. */
const recentFlags = new Map<string, number[]>();
const FLAGS_PER_HOUR = 10;

/**
 * Tests and records in one call, so calling this is spending a slot rather than asking about
 * one.
 *
 * A rejected attempt does not consume one: the count is compared before the push, so
 * somebody hammering the endpoint stays at exactly twenty recorded attempts for the hour
 * instead of extending their own lockout with every retry.
 */
function rateOk(accountId: string, now = Date.now()): boolean {
  const hourAgo = now - 3_600_000;
  // Lazy sweep: without it this map keeps one entry per account that ever uploaded, for
  // the life of the process.
  if (recentUploads.size > 512) {
    for (const [id, times] of recentUploads) if (!times.some((t) => t > hourAgo)) recentUploads.delete(id);
  }
  const times = (recentUploads.get(accountId) ?? []).filter((t) => t > hourAgo);
  if (times.length >= UPLOADS_PER_HOUR) {
    recentUploads.set(accountId, times);
    return false;
  }
  times.push(now);
  recentUploads.set(accountId, times);
  return true;
}

/** Test hook. */
export function __resetAvatarRate(): void {
  recentUploads.clear();
  recentFlags.clear();
}

export class AvatarService {
  /**
   * Decode → validate dimensions → re-encode → hash → store. Returns the stored document;
   * an identical image uploaded twice returns the existing one rather than duplicating it.
   */
  public static async upload(ownerId: string, raw: Buffer, shareOptIn: boolean): Promise<IAvatar> {
    if (!raw?.length) throw new ApiError(400, ErrorCode.MISSING_REQUIRED_FIELD, 'Empty upload.');
    if (raw.length > MAX_UPLOAD_BYTES) {
      throw ApiError.badRequest(`Avatar must be ${MAX_UPLOAD_BYTES / 1024} KB or smaller.`);
    }
    if (!rateOk(ownerId)) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, 'Too many avatar uploads this hour.');
    }

    // Read the dimensions straight out of the IHDR before decoding: a 64 KB upload can
    // declare an enormous canvas, and pngjs would allocate for it before we ever looked.
    if (raw.length < 24 || raw.readUInt32BE(0) !== 0x89504e47) {
      throw ApiError.badRequest('That is not a readable PNG.');
    }
    const declaredW = raw.readUInt32BE(16);
    const declaredH = raw.readUInt32BE(20);
    if (!ALLOWED_SIZES.some(([w, h]) => declaredW === w && declaredH === h)) {
      throw ApiError.badRequest(
        `Avatar must be one of ${ALLOWED_SIZES.map(([w, h]) => `${w}x${h}`).join(', ')}; got ${declaredW}x${declaredH}.`
      );
    }

    let png: PNG;
    try {
      png = PNG.sync.read(raw);
    } catch {
      throw ApiError.badRequest('That is not a readable PNG.');
    }
    const size = ALLOWED_SIZES.find(([w, h]) => png.width === w && png.height === h);
    if (!size) {
      throw ApiError.badRequest(
        `Avatar must be one of ${ALLOWED_SIZES.map(([w, h]) => `${w}×${h}`).join(', ')}; got ${png.width}×${png.height}.`
      );
    }

    // Re-encode from the decoded pixels: this is the step that kills polyglots and strips
    // every ancillary chunk. The stored bytes never came from the client.
    const clean = new PNG({ width: png.width, height: png.height });
    png.data.copy(clean.data);
    const bytes = PNG.sync.write(clean, { colorType: 6 });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');

    // Deduplicate per owner, not globally: the same pixels uploaded by two people are two
    // rows sharing a hash, so a takedown of one never clears the other's avatar.
    const existing = await Avatar.findOne({ hash, ownerId });
    if (existing) {
      if (shareOptIn !== existing.shareOptIn) {
        existing.shareOptIn = shareOptIn;
        await existing.save();
      }
      await AvatarService.pointAccountAt(ownerId, existing);
      return existing;
    }

    const doc = await Avatar.create({
      hash,
      bytes,
      width: png.width,
      height: png.height,
      ownerId: new Types.ObjectId(ownerId),
      status: AvatarStatus.PENDING,
      shareOptIn,
    });
    await AvatarService.pointAccountAt(ownerId, doc);
    return doc;
  }

  /**
   * The account's `avatarHash` is what the presence wire carries, so pointing it at this row
   * is what actually changes anybody's sprite.
   *
   * The `invalidate` is the load-bearing half. The presence layer holds its own copy of an
   * account for about thirty seconds, and without dropping it the tick keeps publishing the
   * hash it already had — a new upload that visibly does nothing for half a minute.
   * `unpublish` makes the same call for the same reason on the takedown path, where the stale
   * copy would be a withdrawn image still being announced to peers who have not fetched it.
   */
  private static async pointAccountAt(ownerId: string, doc: IAvatar): Promise<void> {
    await Volunteer.updateOne({ _id: ownerId }, { $set: { avatarHash: doc.hash } });
    presenceService.invalidate(ownerId);
  }

  /** Bytes for `GET /avatars/:hash`, with the visibility rule applied. */
  public static async fetch(hash: string, viewer: { id: string; role: string; source?: string } | undefined): Promise<IAvatar> {
    // Several rows can share a hash (same pixels, different owners). Any published one
    // makes the image public; otherwise the viewer needs their own row, or to be a lead.
    const rows = await Avatar.find({ hash }).limit(20);
    if (!rows.length) throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
    const published = rows.find((d) => d.status === AvatarStatus.APPROVED && d.shareOptIn);
    if (published) return published;
    // A *proved* lead. These are the bytes of a face photo that is not published — either
    // still pending review or never shared — and the hash is broadcast publicly on the
    // presence wire and the roster. Trusting a claimed role meant
    // `GET /avatars/<hash>?volunteerId=<any lead id>` returned somebody's unshared photograph
    // to a caller with no cookie. `flag()` in this same service already checks both; `fetch()`
    // is the one that hands over the image.
    const isLead = !!viewer && viewer.source === 'session' && /SHIFT_LEAD|ORGANIZER|ADMIN/.test(viewer.role);
    // Proved, like the lead branch below — and this is the branch the first fix missed.
    //
    // Tightening only `isLead` moved the disclosure one branch up rather than closing it,
    // which is the same mistake the SOS ticket list made two rounds ago: the *owner* test is
    // an id comparison, and in `legacy` the id is claimed. `?volunteerId=<victim>` therefore
    // matched the victim's own row and returned their unpublished photograph to a caller with
    // no cookie — the identical outcome, at the identical cost, one `if` earlier.
    const own = viewer?.source === 'session' ? rows.find((d) => String(d.ownerId) === viewer.id) : undefined;
    if (own) return own;
    if (isLead) return rows[0];
    throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
  }

  /**
   * The moderation queue: PENDING *and* opted into sharing.
   *
   * An avatar whose owner never asked for it to be shared is deliberately absent, and stays
   * PENDING for ever as a result. That is the correct resting state rather than a backlog,
   * because `fetch` publishes a row only when it is APPROVED **and** `shareOptIn`: an
   * unshared avatar is already visible to nobody but its owner and a proved lead, so there is
   * nothing here for a reviewer to decide.
   *
   * `-bytes` because a queue page is hashes and dimensions, not several megabytes of PNG.
   * The fifty is a hard stop with no cursor behind it — the route calls this with no argument
   * — so a backlog past fifty is invisible until the front of it has been cleared.
   */
  public static async pendingQueue(limit = 50): Promise<IAvatar[]> {
    return Avatar.find({ status: AvatarStatus.PENDING, shareOptIn: true })
      .select('-bytes')
      .sort({ createdAt: 1 })
      .limit(limit);
  }

  /**
   * A lead's decision on one person's upload.
   *
   * Approving is necessary but not sufficient for the image to become visible. `fetch`
   * requires APPROVED **and** `shareOptIn`, and this touches only the first, so approving an
   * avatar its owner never opted to share leaves it exactly as private as it was. That is the
   * right way round: a reviewer working through a queue cannot publish somebody by accident.
   *
   * Rejecting does more than set a status, and has to. The status alone would leave the hash
   * on the owner's account and therefore on the presence wire until something else noticed;
   * `unpublish` is what clears it and evicts the texture from every connected renderer.
   */
  public static async review(hash: string, reviewerId: string, approve: boolean, ownerId: string): Promise<IAvatar> {
    // `ownerId` is required, not optional.
    //
    // A hash identifies an IMAGE and two people who upload the same sheet get one row each,
    // so a `{ hash }`-only lookup acts on whichever the database returns first: rejecting
    // Alice's avatar could reject Bob's, and neither would be told. The routes were fixed to
    // pass it; leaving the parameter optional here left the trap armed for the next caller.
    const doc = await Avatar.findOne({ hash, ownerId });
    if (!doc) throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
    doc.status = approve ? AvatarStatus.APPROVED : AvatarStatus.REJECTED;
    doc.reviewedBy = new Types.ObjectId(reviewerId);
    doc.reviewedAt = new Date();
    await doc.save();
    if (!approve) await AvatarService.unpublish(doc, 'REJECTED');
    return doc;
  }

  /**
   * A report. Three distinct reporters, or one lead, unpublish immediately — waiting for a
   * review queue to drain is the wrong default when the content is on other people's maps.
   */
  public static async flag(hash: string, reporter: { id: string; role: string; source?: string }, reason: string, ownerId: string): Promise<IAvatar> {
    // Required for the same reason as `review`: a report is against one person's upload.
    const doc = await Avatar.findOne({ hash, ownerId });
    if (!doc) throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
    // Three reporters unpublish, and accounts are cheap to create, so a report has to cost
    // the reporter something. Ten an hour is far more than an honest player needs and far
    // fewer than a brigade wants.
    const now = Date.now();
    const hourAgo = now - 3_600_000;
    if (recentFlags.size > 512) {
      for (const [id, times] of recentFlags) if (!times.some((t) => t > hourAgo)) recentFlags.delete(id);
    }
    const mine = (recentFlags.get(reporter.id) ?? []).filter((t) => t > hourAgo);
    if (mine.length >= FLAGS_PER_HOUR) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, 'Too many reports this hour.');
    }
    mine.push(now);
    recentFlags.set(reporter.id, mine);
    const already = doc.flags.some((f) => String(f.reporterId) === reporter.id);
    if (!already) {
      doc.flags.push({ reporterId: new Types.ObjectId(reporter.id), reason, at: new Date() });
    }
    const distinct = new Set(doc.flags.map((f) => String(f.reporterId))).size;
    // A proved lead, checked here as well as at the route. One lead flag unpublishes on its
    // own, so this is the branch that has to be right even if a future refactor remounts the
    // handler without its middleware — the same reason the roster handler re-checks.
    const isLead = reporter.source === 'session' && /SHIFT_LEAD|ORGANIZER|ADMIN/.test(reporter.role);
    if (isLead || distinct >= FLAGS_TO_UNPUBLISH) {
      doc.status = AvatarStatus.REJECTED;
      await doc.save();
      await AvatarService.unpublish(doc, isLead ? 'LEAD_TAKEDOWN' : 'REPORTED');
      return doc;
    }
    await doc.save();
    return doc;
  }

  /** Clear the hash off every account using it and tell connected clients to drop the texture. */
  private static async unpublish(doc: IAvatar, reason: string): Promise<void> {
    // Only THIS row's owner loses the hash: another account that uploaded the same pixels
    // has its own row and its own review state.
    const owners = await Volunteer.find({ _id: doc.ownerId, avatarHash: doc.hash }).select('_id').lean();
    await Volunteer.updateMany({ _id: doc.ownerId, avatarHash: doc.hash }, { $set: { avatarHash: null } });
    for (const o of owners) presenceService.invalidate(String(o._id));
    eventHub.broadcastChannel('game', {
      type: 'AVATAR_UNPUBLISHED',
      data: { hash: doc.hash, reason },
    });
  }
}
