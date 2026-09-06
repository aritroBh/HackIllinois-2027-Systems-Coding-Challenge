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

/** Who is asking, for the lifecycle guards. */
const actorOf = (req: Request) => ({ id: resolveActorId(req), role: req.account?.role, kind: req.account?.kind });

export class SOSController {
  public static async acknowledge(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.acknowledge(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async arrive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.arrive(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.cancel(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async reassign(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.reassign(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

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
      const result = await SOSService.dispatchNearestVolunteer(req.params.id as string, { role: req.account?.role });
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
