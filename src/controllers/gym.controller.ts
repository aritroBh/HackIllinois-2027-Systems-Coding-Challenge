/**
 * PokéShift gym HTTP surface — list control points, battle or reinforce one.
 *
 * A single endpoint covers both attack and defence: the service compares the caller's
 * faction to the gym's controlling faction and branches into reinforce, damage, or
 * capture. Keeping that decision server-side means a client cannot ask for the
 * favourable branch.
 */
import { Request, Response, NextFunction } from 'express';
import { GymService } from '../services/gym.service';

export class GymController {
  public static async listGyms(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const gyms = await GymService.listGyms();
      res.status(200).json({ success: true, data: gyms });
    } catch (error) {
      next(error);
    }
  }

  public static async battleOrContribute(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { volunteerId, faction, power, coordinates } = req.body;
      const result = await GymService.battleOrContribute(
        req.params.id as string,
        volunteerId,
        faction,
        power,
        coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
