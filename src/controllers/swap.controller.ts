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

  public static async acceptSwap(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Only the swap's target can accept it, and the target is the caller.
      const swap = await SwapService.acceptBilateralSwap(req.params.id as string, resolveActorId(req, 'targetVolunteerId') as string);
      res.status(200).json({ success: true, data: swap });
    } catch (error) {
      next(error);
    }
  }

  public static async discoverCycles(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await SwapService.discoverAndResolveCycles();
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async listSwaps(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const swaps = await SwapService.listSwaps(req.query.status as SwapStatus | undefined);
      res.status(200).json({ success: true, data: swaps });
    } catch (error) {
      next(error);
    }
  }
}
