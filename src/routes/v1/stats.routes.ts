/**
 * Telemetry routes — `/api/v1/stats`.
 *
 * `GET /events` is the Server-Sent Events stream powering the live war room. It holds a
 * slot in the shared stream-limit table (`src/common/streamLimits.ts`) for as long as the
 * tab is open, which is the resource that actually constrains fan-out.
 *
 * The handler is also exported standalone as `streamEventsHandler` so `app.ts` can mount
 * `/api/v1/stats/events` *before* the API rate limiter: an open stream must never consume
 * API tokens, and a reconnect storm after a Wi-Fi blip must not be 429'd (plan A3). The
 * route is kept on this router too, so the path works even before that mount is wired;
 * once it is, Express reaches the earlier mount first and this copy is simply shadowed.
 */
import { RequestHandler, Router } from 'express';
import { StatsController } from '../../controllers/stats.controller';

export const streamEventsHandler: RequestHandler = (req, res) => StatsController.streamEvents(req, res);

export const statsRouter = Router();

statsRouter.get('/leaderboard', StatsController.getLeaderboard);
statsRouter.get('/operations', StatsController.getOperationsStats);
statsRouter.get('/events', streamEventsHandler);
