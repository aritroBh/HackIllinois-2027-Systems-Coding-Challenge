import { Request, Response, NextFunction } from 'express';
import { LeaderboardService } from '../services/leaderboard.service';
import { eventHub } from '../common/sse/eventHub';

export class StatsController {
  public static async getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
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
