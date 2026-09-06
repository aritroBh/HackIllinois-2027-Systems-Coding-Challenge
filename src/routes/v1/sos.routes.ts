/**
 * Hacker SOS routes — `/api/v1/sos`.
 *
 * `POST /tickets/:id/dispatch` takes no body; the responder is chosen server-side by
 * skill match and Haversine proximity so a caller cannot nominate one.
 */
import { Router } from 'express';
import { SOSController } from '../../controllers/sos.controller';
import { validate } from '../../middleware/validate';
import { requireAccount, requireRole, requireVolunteerKind } from '../../middleware/identity';
import {
  createSOSTicketSchema,
  dispatchSOSTicketSchema,
  resolveSOSTicketSchema,
  listSOSTicketsSchema,
  ticketActionSchema,
} from '../../schemas/sos.schema';

export const sosRouter = Router();

sosRouter.post('/tickets', validate(createSOSTicketSchema), SOSController.createTicket);
// The list carries every ticket's location, table text and description: staff only (a hacker's
// own ticket reaches them over the `me` channel / GET /me in M5).
sosRouter.get('/tickets', requireVolunteerKind, validate(listSOSTicketsSchema), SOSController.listTickets);
// Anyone signed in may raise a ticket; dispatching and resolving are staff actions.
sosRouter.post('/tickets/:id/dispatch', requireVolunteerKind, validate(dispatchSOSTicketSchema), SOSController.dispatchNearest);
sosRouter.post('/tickets/:id/resolve', requireVolunteerKind, validate(resolveSOSTicketSchema), SOSController.resolveTicket);

// The rest of the lifecycle (plan §A7). Acknowledge and on-scene belong to the assigned
// responder (a lead may also act); cancel is the creator's while the ticket is still OPEN
// and a lead's at any point; reassign is lead-only and sends the ticket back to the queue.
sosRouter.post('/tickets/:id/acknowledge', requireAccount, validate(ticketActionSchema), SOSController.acknowledge);
sosRouter.post('/tickets/:id/on-scene', requireAccount, validate(ticketActionSchema), SOSController.arrive);
sosRouter.post('/tickets/:id/cancel', requireAccount, validate(ticketActionSchema), SOSController.cancel);
sosRouter.post('/tickets/:id/reassign', requireAccount, requireRole('SHIFT_LEAD'), validate(ticketActionSchema), SOSController.reassign);
