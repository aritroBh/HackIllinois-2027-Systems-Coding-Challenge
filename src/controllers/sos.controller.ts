/**
 * Hacker SOS HTTP surface — file a distress ticket, dispatch the nearest responder,
 * resolve, and list.
 *
 * Dispatch takes no body: the service selects the responder itself by filtering on-duty
 * volunteers by required skill and ranking them by Haversine distance to the ticket's
 * coordinates. Selection is server-side precisely so a caller cannot nominate a
 * favourable responder.
 */
import { Request, Response, NextFunction } from 'express';
import { SOSService } from '../services/sos.service';
import { SOSTicketStatus } from '../models/sosTicket.model';
import { resolveActorId } from '../middleware/identity';

export class SOSController {
  public static async createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.createTicket(req.body);
      res.status(201).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async dispatchNearest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await SOSService.dispatchNearestVolunteer(req.params.id as string);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async resolveTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.resolveTicket(req.params.id as string, resolveActorId(req) as string);
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tickets = await SOSService.listTickets(req.query.status as SOSTicketStatus | undefined);
      res.status(200).json({ success: true, data: tickets });
    } catch (error) {
      next(error);
    }
  }
}
