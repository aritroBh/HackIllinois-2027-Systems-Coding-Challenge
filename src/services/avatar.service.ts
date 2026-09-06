/**
 * Avatar upload, review and takedown (plan §A5).
 *
 * The upload path is deliberately paranoid. A PNG that arrives here is decoded by pngjs and
 * re-encoded from its raw pixels before anything is stored: the bytes we serve are ours, not
 * the uploader's, so metadata chunks, trailing archives and polyglot tricks do not survive
 * the round trip. Only then is the sha256 taken, which means the hash identifies the image
 * rather than the file.
 *
 * Sharing is opt-in and reviewed: an avatar is visible to its owner and to leads while
 * PENDING, and to other players once APPROVED. Three distinct reporters — or one lead —
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

/** A walk sheet (128×48 or 128×32) or a single 32×32 head. */
const ALLOWED_SIZES: ReadonlyArray<[number, number]> = [
  [128, 48],
  [128, 32],
  [32, 32],
  [32, 48],
];
export const MAX_UPLOAD_BYTES = 64 * 1024;
const UPLOADS_PER_HOUR = 20;
const FLAGS_TO_UNPUBLISH = 3;

const recentUploads = new Map<string, number[]>();
/** reporter → times, so one account cannot mass-report the field. */
const recentFlags = new Map<string, number[]>();
const FLAGS_PER_HOUR = 10;

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

  /** The account's `avatarHash` is what the presence wire carries. */
  private static async pointAccountAt(ownerId: string, doc: IAvatar): Promise<void> {
    await Volunteer.updateOne({ _id: ownerId }, { $set: { avatarHash: doc.hash } });
    presenceService.invalidate(ownerId);
  }

  /** Bytes for `GET /avatars/:hash`, with the visibility rule applied. */
  public static async fetch(hash: string, viewer: { id: string; role: string } | undefined): Promise<IAvatar> {
    // Several rows can share a hash (same pixels, different owners). Any published one
    // makes the image public; otherwise the viewer needs their own row, or to be a lead.
    const rows = await Avatar.find({ hash }).limit(20);
    if (!rows.length) throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
    const published = rows.find((d) => d.status === AvatarStatus.APPROVED && d.shareOptIn);
    if (published) return published;
    const isLead = !!viewer && /SHIFT_LEAD|ORGANIZER|ADMIN/.test(viewer.role);
    const own = viewer ? rows.find((d) => String(d.ownerId) === viewer.id) : undefined;
    if (own) return own;
    if (isLead) return rows[0];
    throw ApiError.notFound('Avatar not found.', ErrorCode.NOT_FOUND);
  }

  public static async pendingQueue(limit = 50): Promise<IAvatar[]> {
    return Avatar.find({ status: AvatarStatus.PENDING, shareOptIn: true })
      .select('-bytes')
      .sort({ createdAt: 1 })
      .limit(limit);
  }

  public static async review(hash: string, reviewerId: string, approve: boolean, ownerId?: string): Promise<IAvatar> {
    const doc = await Avatar.findOne(ownerId ? { hash, ownerId } : { hash });
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
  public static async flag(hash: string, reporter: { id: string; role: string }, reason: string, ownerId?: string): Promise<IAvatar> {
    const doc = await Avatar.findOne(ownerId ? { hash, ownerId } : { hash });
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
    const isLead = /SHIFT_LEAD|ORGANIZER|ADMIN/.test(reporter.role);
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
