/**
 * Adonix synchronisation HTTP surface.
 *
 * Pulls the official HackIllinois event schedule and synthesises volunteer shifts from
 * it, upserting on title so repeated syncs converge rather than duplicate. Falls back to
 * a static event set when the upstream API is unreachable, which keeps the demo working
 * offline.
 *
 * The route is organiser-only (`requireRole('ORGANIZER')` in `adonix.routes.ts`, effective
 * in `required` mode and open only under the documented legacy-demo contract). It still
 * rewrites `startTime`/`endTime` on existing shifts, so an upstream schedule change can move
 * a shift volunteers are already committed to without re-validating their rest buffers —
 * which is why it is an organiser action rather than an automatic one.
 */
import { Request, Response, NextFunction } from 'express';
import { AdonixSyncService } from '../services/adonixSync.service';

export class AdonixController {
  public static async syncOfficialEvents(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AdonixSyncService.syncOfficialEvents();
      res.status(200).json({
        success: true,
        message: `Successfully synchronized ${result.syncedCount} shifts with HackIllinois Adonix API.`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
