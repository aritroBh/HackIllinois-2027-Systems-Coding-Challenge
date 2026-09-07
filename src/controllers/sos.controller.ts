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
  /**
   * The responder says they are on their way. 200 with the ticket as this particular caller
   * may see it.
   *
   * The two-identity pattern here is the one all four lifecycle handlers use, and it is worth
   * reading once rather than four times. `actorOf` decides whether the move is *allowed* and
   * may believe a claimed identity, because `legacy` is documented as believing one for
   * actions. `viewerOf` decides what the answer may *contain* and may not. Before they were
   * separated, acknowledging as `?volunteerId=<the assignee>` from an anonymous caller
   * returned the coordinates, the hacker's name, the table and the medical category.
   *
   * The refusals are the service's: 403 unless the caller is the assigned responder or a
   * lead, and 409 when the ticket is not in a state this move is legal from. A second
   * coordinator pressing the same button lands in that 409 rather than silently overwriting
   * the first, because the transition is a compare-and-swap on the status it read.
   */
  public static async acknowledge(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.acknowledge(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The responder is standing there. Same guards as `acknowledge` — assignee or lead, a legal
   * transition, and the same split between the identity that may act and the identity that
   * may be told. Recording it as its own transition rather than folding it into the
   * acknowledgement is what lets the ticket's history show how long the walk actually took.
   */
  public static async arrive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.arrive(req.params.id as string, actorOf(req));
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Stands the ticket down. The asymmetry is in the service and it is deliberate: the person
   * who raised it may only cancel while it is still OPEN, because once somebody is walking
   * towards them the decision to stop belongs to whoever dispatched. A lead may cancel from
   * any non-terminal state.
   *
   * `note` is optional and read defensively off a body that may not be there at all. It lands
   * in the ticket's history, which is the only record of why a call was stood down.
   */
  public static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.cancel(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Puts the ticket back in the queue for somebody else. Lead-only twice over —
   * `requireRole('SHIFT_LEAD')` on the route and `isLeadRole` inside the service — because it
   * takes a call away from the person currently assigned to it.
   *
   * The service clears `escalatedAt` along with the assignment, and that is not tidiness. The
   * three-minute escalation sweep filters on `escalatedAt: null`, so a ticket that escalated
   * once, was reassigned, and was then ignored all over again could otherwise never shout a
   * second time — which is the opposite of what reassignment is for.
   */
  public static async reassign(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.reassign(req.params.id as string, actorOf(req), req.body?.note);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Raises a distress ticket. 201.
   *
   * The one response in this file that hands the ticket back ungraded — the lifecycle moves go
   * through `ticketFor`, and dispatch and the list are redacted inside the service — and safely
   * so: every field in it either came from this request or is the server's answer to it.
   * `karmaBounty` is still the field to watch. A figure above the pack's per-urgency ceiling is
   * refused with a 400 rather than quietly clamped down to it, and offering more than what is
   * left of the creator's daily budget is a 409. The one case where the stored bounty differs
   * from the one asked for is a pack whose `hackerBountyBudgetPerDay` is zero: the ticket is
   * kept — somebody still needs help — and the reward drops to nothing.
   *
   * `kind` is passed but no longer used by the service's charging decision: every creator
   * draws on the budget, not only hackers, because two volunteers exempted from the cap could
   * otherwise alternate raising maximum-bounty tickets and resolving each other's.
   */
  public static async createTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.createTicket(req.body, { id: req.account?.id, kind: req.account?.kind });
      res.status(201).json({ success: true, data: ticket });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Picks a responder and sends them. Takes no body at all: the service filters on-duty
   * volunteers by the skill the ticket needs and ranks them by distance, so a caller cannot
   * nominate a favourable responder — nor, by nominating one repeatedly, use dispatch as a
   * way of asking where a named colleague is.
   *
   * Almost every field of the answer is graded by whether the dispatcher is a *proved* lead.
   * The ticket is redacted; the distance is bucketed to twenty-five metres and measured
   * against the published, fuzzed position rather than the exact one; `positionSource` becomes
   * `unknown`, `positionAgeMs` becomes null, and the runners-up list is emptied. The three
   * position fields are graded together on purpose: a dispatcher who could see whether a named
   * colleague is publishing right now, and how fresh their fix is, would hold a liveness
   * oracle over someone without publishing anything themselves.
   *
   * 409 rather than a fallback when nobody qualifies. Assigning an unqualified responder marks
   * the ticket handled and stops anybody else looking at it, which is slower than an honest
   * refusal that puts it back in front of a human.
   */
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

  /**
   * Closes the ticket and moves the bounty. 200 with the ticket as this caller may see it.
   *
   * The role travels separately from the actor, and it is what lets a lead close a call they
   * walked to themselves: without it the lifecycle had a dead end, since `transition` lets a
   * lead acknowledge and mark themselves on-scene and this then refused them the close. Being
   * allowed to close it is not being paid for it — on a dispatched ticket the bounty follows
   * the assignment, so a lead closing on the responder's behalf pays the responder.
   *
   * Three refusals, in the order the service applies them. The transition check comes first,
   * so a second resolve is a 409 — and it gets its own wording, because "cannot go from
   * RESOLVED to RESOLVED" reads as a bug to somebody whose colleague simply got there first.
   * Then 403 for the person who raised the ticket, because nobody collects a bounty on their
   * own call. Then 403 for anyone but the assignee or a lead once a ticket has been dispatched.
   */
  public static async resolveTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const ticket = await SOSService.resolveTicket(req.params.id as string, resolveActorId(req) as string, req.account?.role);
      res.status(200).json({ success: true, data: ticketFor(ticket, viewerOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The ticket queue, optionally filtered by status. A proved lead gets whole documents;
   * everybody else gets the redacted shape — except for the tickets they are themselves a
   * party to, since redacting those would hide the address from the one volunteer who has to
   * walk to it.
   *
   * `source` travels with the id for exactly that reason. Being a party is decided by an id,
   * and in `legacy` mode an id is claimed rather than proved while account ids are public, so
   * stripping the provenance here turns `?volunteerId=<anyone>` into a way of reading that
   * person's distress call in full.
   *
   * Known gap: no pagination and no time window. This returns every ticket ever raised, newest
   * first.
   */
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
