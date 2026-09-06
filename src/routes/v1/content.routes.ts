/**
 * Public content descriptor: branding, venues, factions, monuments and the URLs of the pack
 * files. Anonymous by design (it is what the login screen renders from) — `GET /content` is
 * on the `enforceAuthMode` allow-list — and cacheable. Mounted inside the v1 router so it
 * sits behind the anonymous rate limiters like every other unauthenticated endpoint.
 */
import { Router, Request, Response } from 'express';
import { publicContent } from '../../content/loader';

export const contentRouter = Router();

contentRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({ success: true, data: publicContent() });
});
