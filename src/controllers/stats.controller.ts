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
   */
  public static streamEvents(req: Request, res: Response): void {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const userId = req.headers['x-user-id'] as string | undefined;

    eventHub.registerClient(clientId, res, userId);
  }
}
