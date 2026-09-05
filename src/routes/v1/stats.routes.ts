import { Router } from 'express';
import { StatsController } from '../../controllers/stats.controller';

export const statsRouter = Router();

statsRouter.get('/leaderboard', StatsController.getLeaderboard);
statsRouter.get('/operations', StatsController.getOperationsStats);
statsRouter.get('/events', StatsController.streamEvents);
