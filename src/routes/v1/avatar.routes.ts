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
    const viewer = req.account ? { id: req.account.id, role: req.account.role } : undefined;
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

avatarRouter.post('/:hash/review', requireSession, requireRole('SHIFT_LEAD'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approve = req.body?.approve !== false;
    const doc = await AvatarService.review(String(req.params.hash), req.account!.id, approve);
    res.status(200).json({ success: true, data: { hash: doc.hash, status: doc.status } });
  } catch (error) {
    next(error);
  }
});

avatarRouter.post('/:hash/flag', requireAccount, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const doc = await AvatarService.flag(
      String(req.params.hash),
      { id: req.account!.id, role: req.account!.role },
      typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 120) : 'REPORTED'
    );
    res.status(200).json({
      success: true,
      data: { hash: doc.hash, status: doc.status, unpublished: doc.status === AvatarStatus.REJECTED, flags: doc.flags.length },
    });
  } catch (error) {
    next(error);
  }
});
