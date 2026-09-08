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

/**
 * Controller handling inbound HTTP requests for external Adonix schedule synchronisation.
 */
export class AdonixController {
  /**
   * Runs one synchronisation pass and reports how many shifts it touched.
   *
   * Takes nothing at all — no body, no query, and not the caller's identity either; the
   * request is `_req` for that reason. Everything that decides the outcome is upstream, so
   * the only interesting gate on this endpoint is the one on the route, and the file header
   * above says why it has to be there.
   *
   * A completed pass is always 200, including the offline one: an unreachable or slow Adonix
   * endpoint is caught inside the service and produces a static fallback set of events rather
   * than an error. So a 200 here does not mean the live schedule was read. `syncedCount` and
   * the echoed event titles in `data` are the only way to tell the two apart.
   */
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
