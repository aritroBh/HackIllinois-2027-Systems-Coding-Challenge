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
import { SOSService, ticketFor } from '../services/sos.service';
import { SOSTicketStatus } from '../models/sosTicket.model';
import { resolveActorId } from '../middleware/identity';

/** Who is asking, for the lifecycle guards. */
const actorOf = (req: Request) => ({ id: resolveActorId(req), role: req.account?.role, kind: req.account?.kind });

/**
 * Who is asking, for what the **answer** may contain.
 *
 * Deliberately not `actorOf`. The lifecycle guards above may believe a claimed identity — that
 * is the documented `legacy` contract for actions — but the ticket that comes back is a
 * disclosure, and `ticketFor` refuses to hand the whole document to an identity nobody proved.
 * The two shapes exist separately so that the difference is visible at every call site.
 */
const viewerOf = (req: Request) => ({ id: req.account?.id, role: req.account?.role, source: req.account?.source });

export class SOSController {
  public static async acknowledge(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.acknowledge(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  public static async arrive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.arrive(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  public static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.cancel(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  public static async reassign(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.reassign(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  public static async createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.createTicket(req.body, { id: req.account?.id, kind: req.account?.kind });
      res.status(201).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  public static async dispatchNearest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // `source` travels with the role, or `isProvenLead` sees a role with no provenance and
      // redacts a real lead. The service decides what a claimed role may be told; it cannot
      // make that decision from a viewer the controller has already stripped it out of.
      const result = await SOSService.dispatchNearestVolunteer(req.params.id as string, {
        id: req.account?.id,
        role: req.account?.role,
        source: req.account?.source,
      });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async resolveTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.resolveTicket(req.params.id as string, resolveActorId(req) as string, req.account?.role);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  public static async listTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tickets = await SOSService.listTickets(req.query.status as SOSTicketStatus | undefined, {
        id: req.account?.id,
        role: req.account?.role,
        source: req.account?.source,
      });
      res.status(200).json({ success: true, data: tickets });
    } catch (error) {
      next(error);
    }
  }
}
