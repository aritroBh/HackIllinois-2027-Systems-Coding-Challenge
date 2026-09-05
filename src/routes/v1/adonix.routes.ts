import { Router } from 'express';
import { AdonixController } from '../../controllers/adonix.controller';

export const adonixRouter = Router();

adonixRouter.post('/sync', AdonixController.syncOfficialEvents);
