/**
 * Hacker SOS routes — `/api/v1/sos`.
 *
 * `POST /tickets/:id/dispatch` takes no body; the responder is chosen server-side by
 * skill match and Haversine proximity so a caller cannot nominate one.
 */
import { Router } from 'express';
import { SOSController } from '../../controllers/sos.controller';
import { validate } from '../../middleware/validate';
import { requireVolunteerKind } from '../../middleware/identity';
import {
  createSOSTicketSchema,
  dispatchSOSTicketSchema,
  resolveSOSTicketSchema,
  listSOSTicketsSchema,
} from '../../schemas/sos.schema';

export const sosRouter = Router();

sosRouter.post('/tickets', validate(createSOSTicketSchema), SOSController.createTicket);
// The list carries every ticket's location, table text and description: staff only (a hacker's
// own ticket reaches them over the `me` channel / GET /me in M5).
sosRouter.get('/tickets', requireVolunteerKind, validate(listSOSTicketsSchema), SOSController.listTickets);
// Anyone signed in may raise a ticket; dispatching and resolving are staff actions.
sosRouter.post('/tickets/:id/dispatch', requireVolunteerKind, validate(dispatchSOSTicketSchema), SOSController.dispatchNearest);
sosRouter.post('/tickets/:id/resolve', requireVolunteerKind, validate(resolveSOSTicketSchema), SOSController.resolveTicket);
