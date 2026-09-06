/**
 * `/api/v1/announcements` — the lead's broadcast to the floor (plan §A7).
 *
 *   POST   /announcements     lead+: say something, to an audience, for a while
 *   GET    /announcements     what is currently live for the caller's audience
 *   DELETE /announcements/:id lead+: take it down early
 *
 * Delivery is filtered on the way out: an announcement for staff is broadcast on the
 * `announce` channel with its audience attached, and the client shows only what applies —
 * but the authoritative filter is `GET /announcements`, which never returns a message the
 * caller is not part of.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { requireRole, requireSession } from '../../middleware/identity';
import { objectId } from '../../schemas/common';
import { Announcement, AnnouncementAudience, AnnouncementTone, announcementReaches } from '../../models/announcement.model';
import { eventHub } from '../../common/sse/eventHub';
import { ApiError } from '../../common/errors/apiError';
import { ErrorCode } from '../../common/errors/errorCodes';

export const announcementRouter = Router();

const createSchema = z.object({
  body: z.object({
    message: z.string().min(1).max(280),
    audience: z.nativeEnum(AnnouncementAudience).default(AnnouncementAudience.ALL),
    tone: z.nativeEnum(AnnouncementTone).default(AnnouncementTone.INFO),
    venueKey: z.string().max(64).optional(),
    /** How long it stays up. Ten minutes by default; four hours at the most. */
    minutes: z.number().int().min(1).max(240).default(10),
  }),
});

announcementRouter.post('/', requireSession, requireRole('SHIFT_LEAD'), validate(createSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = req.account!;
    const doc = await Announcement.create({
      message: req.body.message,
      audience: req.body.audience,
      tone: req.body.tone,
      venueKey: req.body.venueKey ?? null,
      authorId: account.id,
      authorName: account.displayName,
      expiresAt: new Date(Date.now() + req.body.minutes * 60_000),
    });
    eventHub.broadcastChannel('announce', {
      type: 'ANNOUNCEMENT',
      data: {
        id: doc.id, message: doc.message, audience: doc.audience, tone: doc.tone,
        venueKey: doc.venueKey, authorName: doc.authorName, expiresAt: doc.expiresAt,
      },
    });
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    next(error);
  }
});

announcementRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const rows = await Announcement.find({ expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(50).lean();
    // The filter is here, not in the client: an announcement for staff must not be
    // readable by a hacker who simply ignores the audience field.
    const mine = rows.filter((r) => announcementReaches(r.audience, req.account?.kind, req.account?.role));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      success: true,
      data: mine.map((r) => ({
        id: String(r._id), message: r.message, audience: r.audience, tone: r.tone,
        venueKey: r.venueKey, authorName: r.authorName, createdAt: r.createdAt, expiresAt: r.expiresAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

announcementRouter.delete(
  '/:id',
  requireSession,
  requireRole('SHIFT_LEAD'),
  validate(z.object({ params: z.object({ id: objectId('Invalid announcement id') }) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await Announcement.findByIdAndDelete(req.params.id);
      if (!doc) throw ApiError.notFound('Announcement not found.', ErrorCode.NOT_FOUND);
      eventHub.broadcastChannel('announce', { type: 'ANNOUNCEMENT_CLEARED', data: { id: String(req.params.id) } });
      res.status(200).json({ success: true, data: { id: String(req.params.id), cleared: true } });
    } catch (error) {
      next(error);
    }
  }
);

