/**
 * Game board routes — `/api/v1/game` (plan §A6).
 *
 * The three reads are the HUD: what is happening now (raids), who is winning the campus
 * (objectives), and who is winning personally (leaderboard). They are open to whoever the
 * deployment's auth mode lets through, exactly like the gym and beacon listings — a
 * scoreboard nobody can read before signing in is a scoreboard nobody looks at. In
 * `AUTH_MODE=required` `enforceAuthMode` has already turned an anonymous request into a 401
 * before any of this runs.
 *
 * The one write needs an actor, so it takes `requireAccount`. Booths accept either account
 * kind on purpose: sponsor row is the part of the weekend that is for hackers.
 *
 * All three reads are `no-store`. Each one is a live figure that a player will refresh to
 * watch move, and a cached raid timer is worse than a slow one.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { requireAccount } from '../../middleware/identity';
import { validate } from '../../middleware/validate';
import { RaidService } from '../../services/raid.service';
import { BoothService } from '../../services/booth.service';
import { GameBoardService } from '../../services/gameBoard.service';
import { scanBoothSchema, leaderboardQuerySchema } from '../../schemas/game.schema';

export const gameRouter = Router();

/** The raid schedule, the window that is open now, and who is on its roster. */
gameRouter.get('/raids', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const board = await RaidService.board();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: board });
  } catch (error) {
    next(error);
  }
});

/** The faction bar: each faction's share of who actually turned up. */
gameRouter.get('/objectives', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const board = await GameBoardService.objectives();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: board });
  } catch (error) {
    next(error);
  }
});

/** Karma ranking, tie-broken by reliability and then by name so the order is total. */
gameRouter.get('/leaderboard', validate(leaderboardQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entries = await GameBoardService.leaderboard(Number(req.query.limit));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: entries });
  } catch (error) {
    next(error);
  }
});

/**
 * Scan a sponsor booth. Once per account per booth, ever; the code is verified against the
 * deployment's secret rather than against anything in the pack.
 */
gameRouter.post('/booths/:id/scan', requireAccount, validate(scanBoothSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await BoothService.scan(req.account!.id, req.params.id as string, req.body.code);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});
