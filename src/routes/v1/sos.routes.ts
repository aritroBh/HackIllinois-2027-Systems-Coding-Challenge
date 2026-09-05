/**
 * Hacker SOS routes — `/api/v1/sos`.
 *
 * `POST /tickets/:id/dispatch` takes no body; the responder is chosen server-side by
 * skill match and Haversine proximity so a caller cannot nominate one.
 */
import { Router } from 'express';
import { SOSController } from '../../controllers/sos.controller';
import { validate } from '../../middleware/validate';
import {
  createSOSTicketSchema,
  dispatchSOSTicketSchema,
  resolveSOSTicketSchema,
  listSOSTicketsSchema,
} from '../../schemas/sos.schema';

export const sosRouter = Router();

sosRouter.post('/tickets', validate(createSOSTicketSchema), SOSController.createTicket);
sosRouter.get('/tickets', validate(listSOSTicketsSchema), SOSController.listTickets);
sosRouter.post('/tickets/:id/dispatch', validate(dispatchSOSTicketSchema), SOSController.dispatchNearest);
sosRouter.post('/tickets/:id/resolve', validate(resolveSOSTicketSchema), SOSController.resolveTicket);
