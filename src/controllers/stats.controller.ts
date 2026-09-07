/**
 * Telemetry HTTP surface — leaderboard, operational rollups, and the live event stream.
 *
 * Note the `limit` clamp in `getLeaderboard`. `parseInt` returns `NaN` for junk and
 * happily returns a huge number for `?limit=99999999`, and either used to flow straight
 * into a Mongo `.limit()`. The clamp to `[1, 100]` with a fallback of 20 is the whole
 * defence against a trivially cheap request that asks the database for everything.
 *
 * `streamEvents` is the odd one out: it never sends a response body and never returns.
 * It hands the raw `res` to the SSE hub, which keeps the socket open for the life of the
 * dashboard tab. Because the response is never ended, no error can be reported through
 * the normal channel once the stream is registered — the hub owns the socket from there.
 */
import { Request, Response, NextFunction } from 'express';
import { LeaderboardService } from '../services/leaderboard.service';
import { eventHub } from '../common/sse/eventHub';

export class StatsController {
  /**
   * Karma ranking. The clamp on the next line is the whole of the input handling and the file
   * header explains it; what belongs here is why it has to live in the handler at all.
   *
   * This route mounts no `validate()`, unlike every other list in the API, so there is no
   * schema boundary to coerce and bound `?limit=` before it arrives. The consequence is that
   * junk, a negative, or an enormous figure is silently turned into 20 or clamped into range
   * rather than answered with the 400 VALIDATION_ERROR every other list would give it — a
   * quieter contract than the rest of the surface, and worth knowing before treating a 200 as
   * proof the parameter was understood.
   *
   * The route also carries no role gate, unlike `/stats/operations` beside it: in `legacy`
   * anyone may read it and in `required` any signed-in account may, hackers included. These
   * rows are where the account ids that half the disclosure comments in this repository worry
   * about actually become public.
   */
  public static async getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      // Clamp: NaN/negative/huge limits previously flowed straight into Mongo.
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
      const leaderboard = await LeaderboardService.getLeaderboard(limit);
      res.status(200).json({ success: true, data: leaderboard });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Event-wide vitals for the war room. Nothing is read off the request — the figures are
   * event-wide rather than per-caller — so `requireVolunteerKind` on the route is the entire
   * access decision, and it is what makes this different from the leaderboard beside it: fill
   * rates and no-show telemetry are staff data, and a hacker is refused them even though the
   * leaderboard is open.
   *
   * The service is honest about the cost of the answer: it loads every volunteer document to
   * sum hours and karma, which is milliseconds at one hackathon's size and the first thing
   * that should become an aggregation if this ever runs against a season of events.
   */
  public static async getOperationsStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const stats = await LeaderboardService.getOperationsStats();
      res.status(200).json({ success: true, data: stats });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Real-time Server-Sent Events (SSE) stream endpoint for live War Room updates.
   *
   * Channel selection (`?channels=`, `?v=2`, `Last-Event-ID`), per-channel authorisation
   * against `req.account`, slot accounting and the 503 at capacity all happen inside
   * `registerClient` — the hub owns the socket from here.
   */
  public static streamEvents(req: Request, res: Response): void {
    eventHub.registerClient(req, res);
  }
}
