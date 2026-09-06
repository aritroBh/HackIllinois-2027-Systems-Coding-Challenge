/**
 * `/api/v1/presence` — the HTTP mirror of the WebSocket protocol (plan §A4).
 *
 *   POST   /presence            one position sample (the SSE fallback's input)
 *   DELETE /presence            stop publishing and drop the session
 *   GET    /presence            lead+ only: exact positions, rate-bound to one call per 5 s
 *                               per lead and audited as ONE document per call
 *
 * The opt-in toggle lives on `PATCH /me/presence` (me.routes) because it is account state,
 * not a position.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { validate } from '../../middleware/validate';
import { requireAccount, requireRole, requireSession } from '../../middleware/identity';
import { listPresenceSchema, postPresenceSchema } from '../../schemas/presence.schema';
import { presenceService } from '../../presence/service';
import { presenceStore } from '../../presence/store';
import { ensureSseSession, dropSseSession } from '../../presence/sseTransport';
import { PresenceAudit } from '../../models/presenceAudit.model';
import { ApiError } from '../../common/errors/apiError';
import { ErrorCode } from '../../common/errors/errorCodes';
import { fromLocal, toLocal } from '../../content/loader';

export const presenceRouter = Router();

/** One exact-position listing per lead per 5 s. */
const lastList = new Map<string, number>();
const LIST_INTERVAL_MS = 5000;

presenceRouter.post('/', requireAccount, validate(postPresenceSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = req.account!;
    ensureSseSession(account);
    const result = await presenceService.submit(account.id, {
      lat: req.body.lat, lng: req.body.lng, acc: req.body.acc, h: req.body.h, spd: req.body.spd,
    });
    if (!result.ok) {
      const status = result.reason === 'OPT_OUT' ? 403 : result.reason === 'MUTED' || result.reason === 'SPEED_STRIKE' ? 429 : 202;
      res.status(status).json({ success: status === 202, data: { accepted: false, reason: result.reason } });
      return;
    }
    res.status(202).json({ success: true, data: { accepted: true, tick: presenceService.stats.ticks } });
  } catch (error) {
    next(error);
  }
});

presenceRouter.delete('/', requireAccount, (req: Request, res: Response) => {
  const id = req.account!.id;
  dropSseSession(id);
  presenceStore.remove(id);
  res.status(200).json({ success: true, data: { published: false } });
});

presenceRouter.get('/', requireSession, requireRole('SHIFT_LEAD'), validate(listPresenceSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reader = req.account!.id;
    const now = Date.now();
    // Same lazy sweep as the avatar limiter: one entry per lead who ever called this.
    if (lastList.size > 256) for (const [id, at] of lastList) if (now - at > LIST_INTERVAL_MS * 10) lastList.delete(id);
    const last = lastList.get(reader) ?? 0;
    if (now - last < LIST_INTERVAL_MS) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, 'One presence listing per five seconds.');
    }
    lastList.set(reader, now);

    // The schema accepts a centre and a radius; honour them rather than always dumping
    // everyone. Filtering happens on the exact position, which is what this route returns.
    const centre = req.query.lat !== undefined && req.query.lng !== undefined
      ? toLocal(Number(req.query.lat), Number(req.query.lng))
      : null;
    const radiusUnits = centre ? Number(req.query.radiusMeters ?? 300) / presenceStore.cfg.metersPerUnit : Infinity;

    const rows = [...presenceStore.all()]
      .filter((e) => !Number.isNaN(e.fx))
      .filter((e) => !centre || Math.hypot(e.x - centre.x, e.z - centre.z) <= radiusUnits)
      .map((e) => {
        const ll = fromLocal(e.x, e.z);
        return {
          accountId: e.id, name: e.name, kind: e.kind, role: e.role, faction: e.faction,
          onDuty: e.onDuty, latitude: +ll.latitude.toFixed(6), longitude: +ll.longitude.toFixed(6),
          x: +e.x.toFixed(3), z: +e.z.toFixed(3), accuracyMeters: e.acc, ageMs: now - e.t,
          stale: presenceStore.isStale(e, now),
        };
      });

    // One audit document per call — never one per row (plan §A4).
    await PresenceAudit.create({ readerId: reader, reason: 'presence-list', subjectCount: rows.length, at: new Date(now) });
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: { count: rows.length, players: rows, tick: presenceService.stats.ticks } });
  } catch (error) {
    next(error);
  }
});
