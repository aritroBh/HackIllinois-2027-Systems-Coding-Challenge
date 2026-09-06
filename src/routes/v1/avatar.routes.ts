/**
 * `/api/v1/avatars` — player sprite sheets (plan §A5).
 *
 *   POST   /avatars            raw PNG body (≤ 64 KB), 20/hour; re-encoded and hashed server-side
 *   GET    /avatars/:hash      the sheet; APPROVED + shared for everyone, or owner/lead
 *   GET    /avatars/queue      lead+: what is waiting for review
 *   POST   /avatars/:hash/review  lead+: approve or reject
 *   POST   /avatars/:hash/flag    any account: report it
 *
 * The bytes are served `private, max-age=60, must-revalidate` with an ETag — deliberately
 * not `immutable`, because the same URL becomes a 404 once the avatar is unpublished. That
 * makes 60 seconds the worst case for a browser that has the file cached and is not
 * connected: a connected renderer drops the texture immediately on `AVATAR_UNPUBLISHED`,
 * a reconnecting one revalidates on its next snapshot, and everyone else re-validates
 * within the minute.
 */
import express, { Router, Request, Response, NextFunction } from 'express';
import { requireAccount, requireRole, requireSession } from '../../middleware/identity';
import { AvatarService, MAX_UPLOAD_BYTES } from '../../services/avatar.service';
import { AvatarStatus } from '../../models/avatar.model';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { objectId } from '../../schemas/common';

export const avatarRouter = Router();

/** Raw PNG bodies; `express.json` never sees these. */
const rawPng = express.raw({ type: ['image/png', 'application/octet-stream'], limit: MAX_UPLOAD_BYTES });

avatarRouter.post('/', requireAccount, rawPng, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const share = req.query.share === '1' || req.query.share === 'true';
    const doc = await AvatarService.upload(req.account!.id, req.body as Buffer, share);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      success: true,
      data: { hash: doc.hash, width: doc.width, height: doc.height, status: doc.status, shareOptIn: doc.shareOptIn, url: `/api/v1/avatars/${doc.hash}` },
    });
  } catch (error) {
    next(error);
  }
});

avatarRouter.get('/queue', requireSession, requireRole('SHIFT_LEAD'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await AvatarService.pendingQueue();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: rows.map((d) => ({ hash: d.hash, width: d.width, height: d.height, ownerId: String(d.ownerId), flags: d.flags.length, createdAt: d.createdAt })),
    });
  } catch (error) {
    next(error);
  }
});

avatarRouter.get('/:hash', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // `source` travels with the role. Without it `fetch()` sees a role with no provenance and
    // hands the unpublished-avatar branch to a claimed lead — see the note there.
    const viewer = req.account
      ? { id: req.account.id, role: req.account.role, source: req.account.source }
      : undefined;
    const doc = await AvatarService.fetch(String(req.params.hash), viewer);
    const etag = `"${doc.hash.slice(0, 32)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('ETag', etag);
    // Never `immutable`: this URL 404s once the avatar is unpublished, so a cached copy
    // must expire. 60 s is the ceiling for a disconnected browser; connected ones are
    // evicted by the AVATAR_UNPUBLISHED event long before that.
    res.setHeader('Cache-Control', 'private, max-age=60, must-revalidate');
    res.status(200).send(doc.bytes);
  } catch (error) {
    next(error);
  }
});

/**
 * `ownerId` is required on both moderation routes, and that is the point of them.
 *
 * A hash identifies an IMAGE, not a row: two people who upload the same sheet get one row
 * each, so that a takedown against one never clears the other's — which is the behaviour the
 * unique index on `(hash, ownerId)` exists to produce. Addressing a row by hash alone
 * therefore acts on whichever of them the database returns first. A lead rejecting Alice's
 * avatar could reject Bob's instead, and neither of them would be told.
 *
 * The moderation queue already returns `ownerId` alongside every row, so the caller always
 * has it. Both bodies go through Zod like every other route in the repository rather than
 * being read off `req.body` with ad-hoc coercion.
 */
const reviewSchema = z.object({
  params: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'hash must be a sha256 hex digest') }),
  body: z.object({
    ownerId: objectId('ownerId must be the account id the queue listed beside this avatar'),
    approve: z.boolean().default(true),
  }),
});

const flagSchema = z.object({
  params: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'hash must be a sha256 hex digest') }),
  body: z.object({
    ownerId: objectId('ownerId must be the account id whose avatar is being reported'),
    reason: z.string().min(1).max(120).default('REPORTED'),
  }),
});

avatarRouter.post('/:hash/review', requireSession, requireRole('SHIFT_LEAD'), validate(reviewSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await AvatarService.review(String(req.params.hash), req.account!.id, req.body.approve, String(req.body.ownerId));
    res.status(200).json({ success: true, data: { hash: doc.hash, status: doc.status } });
  } catch (error) {
    next(error);
  }
});

// `requireSession`, not `requireAccount`. A flag is a moderation action — a lead's flag
// unpublishes on its own, and three ordinary ones do — so a *claimed* identity must not
// reach it. In legacy mode `?volunteerId=<any lead's id>` was enough to censor any
// attendee's avatar in one unauthenticated request, and rotating the claimed id also walked
// past the per-reporter hourly cap, which is keyed on the reporter.
avatarRouter.post('/:hash/flag', requireSession, requireAccount, validate(flagSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await AvatarService.flag(
      String(req.params.hash),
      { id: req.account!.id, role: req.account!.role, source: req.account!.source },
      String(req.body.reason),
      String(req.body.ownerId)
    );
    res.status(200).json({
      success: true,
      data: { hash: doc.hash, status: doc.status, unpublished: doc.status === AvatarStatus.REJECTED, flags: doc.flags.length },
    });
  } catch (error) {
    next(error);
  }
});
