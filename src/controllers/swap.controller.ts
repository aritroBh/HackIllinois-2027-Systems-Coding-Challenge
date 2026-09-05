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

export class SwapController {
  public static async createSwapRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const swap = await SwapService.createSwapRequest(req.body);
      res.status(201).json({ success: true, data: swap });
    } catch (error) {
      next(error);
    }
  }

  public static async acceptSwap(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const swap = await SwapService.acceptBilateralSwap(req.params.id as string, req.body.targetVolunteerId);
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
