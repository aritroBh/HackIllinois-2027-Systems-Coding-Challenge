import { Router } from 'express';
import { SOSController } from '../../controllers/sos.controller';

export const sosRouter = Router();

sosRouter.post('/tickets', SOSController.createTicket);
sosRouter.get('/tickets', SOSController.listTickets);
sosRouter.post('/tickets/:id/dispatch', SOSController.dispatchNearest);
sosRouter.post('/tickets/:id/resolve', SOSController.resolveTicket);
