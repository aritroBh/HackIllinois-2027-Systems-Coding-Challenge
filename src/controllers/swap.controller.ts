/**
 * Shift-swap HTTP surface — propose, accept, resolve cycles, list.
 *
 * `POST /swaps/cycles/resolve` is the interesting one: it takes no input. It reads every
 * PENDING proposal, builds the directed "wants" graph, finds elementary cycles, and
 * executes each rotation transactionally. It is idempotent in the sense that a second
 * call finds nothing left to rotate.
 */
import { Request, Response, NextFunction } from 'express';
import { SwapService } from '../services/swap.service';
import { SwapStatus } from '../models/swap.model';
import { resolveActorId } from '../middleware/identity';

export class SwapController {
  /**
   * Proposes a swap. 201.
   *
   * The spread is deliberate and the override after it is what makes it safe: everything the
   * client sent survives except `proposerVolunteerId`, which is replaced by the resolved
   * actor. `targetVolunteerId` is left exactly as submitted because it names the *other*
   * party rather than the caller — supplying it makes this a bilateral proposal aimed at one
   * person, omitting it makes it an open offer for the cycle finder to weave into a rotation.
   *
   * That distinction is also why `legacyIdFrom` in the identity middleware lists
   * `proposerVolunteerId` among the fields that name the caller and deliberately leaves
   * `targetVolunteerId` out of that list.
   *
   * Refusals from the service: 400 for a self-swap, for the same shift on both sides, and
   * when the proposer does not actually hold a CONFIRMED registration for the shift they are
   * offering; 409 for a proposal identical to one already pending.
   */
  public static async createSwapRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The proposer is always the caller. `targetVolunteerId` in the body is the other
      // party to a bilateral swap, not an identity claim, and stays as submitted.
      const swap = await SwapService.createSwapRequest({
        ...req.body,
        proposerVolunteerId: resolveActorId(req, 'proposerVolunteerId') as string,
      });
      res.status(201).json({ success: true, data: swap });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Accepts a bilateral proposal and executes the exchange in one transaction. 200.
   *
   * The acceptor is always the caller. The second argument to `resolveActorId` only names the
   * body field to fall back to in `legacy` mode and never overrides a session, so a swap id
   * on its own is not authority to accept: the service then checks the caller against the
   * person the proposal was addressed to.
   *
   * The sharp edge of the open-offer design, stated plainly: that ownership check is
   * conditional on the proposal actually naming a target, so an open offer can be accepted by
   * any volunteer who finds it. That is what "open" means here, not an oversight.
   */
  public static async acceptSwap(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Only the swap's target can accept it, and the target is the caller.
      const swap = await SwapService.acceptBilateralSwap(req.params.id as string, resolveActorId(req, 'targetVolunteerId') as string);
      res.status(200).json({ success: true, data: swap });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Scans the whole pending graph and executes every rotation it can. Takes no input at all,
   * which is part of why it is a lead action rather than something any volunteer may trigger
   * in a loop — see the route.
   *
   * `discoveredCycles` is not a list of volunteers, and a client that reads it as one will be
   * wrong. Each entry is a ring of *offers*, encoded `<volunteerId>::<shiftId>`, because a
   * volunteer with two pending proposals is two nodes and which shift of theirs is on the
   * table differs per ring. It also includes rings that were then skipped or failed, so
   * `executedCount` is the number that actually rotated and can be lower — a volunteer already
   * consumed by an earlier ring in the same pass is passed over.
   *
   * Below two pending proposals the service returns empty without building a graph at all.
   */
  public static async discoverCycles(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await SwapService.discoverAndResolveCycles();
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The swap board, optionally filtered by status. The populated volunteers carry names only:
   * this list is readable by any volunteer-kind caller and none of them needs another
   * volunteer's email out of it.
   *
   * `status` is the sole accepted query parameter and it is a strict enum, which it has to
   * be. This was the one list route with no `validate()`, and Express's extended query parser
   * turned `?status[$regex]=.*` into an operator object that went straight into `find`.
   */
  public static async listSwaps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const swaps = await SwapService.listSwaps(req.query.status as SwapStatus | undefined);
      res.status(200).json({ success: true, data: swaps });
    } catch (error) {
      next(error);
    }
  }
}
