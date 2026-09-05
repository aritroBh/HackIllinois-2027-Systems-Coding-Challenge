/**
 * Telemetry routes — `/api/v1/stats`.
 *
 * `GET /events` is the Server-Sent Events stream powering the live war room. It holds a
 * slot in the SSE hub for as long as the tab is open (capped at 1,000 clients), which is
 * the resource that actually constrains fan-out.
 *
 * Its rate-limit cost is only the initial handshake — one hit, which ages out after
 * `RATE_LIMIT_WINDOW_MS` like any other request. The open connection consumes no ongoing
 * budget, because `express-rate-limit` counts requests, not connection-seconds.
 */
import { Router } from 'express';
import { StatsController } from '../../controllers/stats.controller';

export const statsRouter = Router();

statsRouter.get('/leaderboard', StatsController.getLeaderboard);
statsRouter.get('/operations', StatsController.getOperationsStats);
statsRouter.get('/events', StatsController.streamEvents);
