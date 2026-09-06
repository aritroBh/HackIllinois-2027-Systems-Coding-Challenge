/**
 * HackStop HTTP surface — list beacons, spin one, read and spend inventory.
 *
 * A spin is gated on both the 75 m geofence and a 5-minute per-volunteer cooldown, and
 * the loot roll happens server-side so the client cannot influence rarity.
 *
 * Worth knowing about the shipped client: it sends the campus player's real position
 * when one exists and falls back to the beacon's own coordinates when the player has not
 * been placed on the map yet. So the geofence is genuinely exercised once you walk the
 * avatar, and trivially satisfied before that. The server-side check is unconditional
 * either way — the fallback is a client convenience, not a bypass.
 */
import { Request, Response, NextFunction } from 'express';
import { HackStopService } from '../services/hackstop.service';
import { resolveActorId } from '../middleware/identity';
import { isLeadOrAbove } from '../common/types/account';
import { sameId } from '../common/utils/id';
import { ApiError } from '../common/errors/apiError';
import { env } from '../config/env';

export class HackStopController {
  public static async listBeacons(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The caller's own cooldown is theirs to see; everybody else's is not. See the service.
      const beacons = await HackStopService.listBeacons(resolveActorId(_req));
      res.status(200).json({ success: true, data: beacons });
    } catch (error) {
      next(error);
    }
  }

  public static async spinBeacon(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { coordinates } = req.body;
      const result = await HackStopService.spinBeacon(
        req.params.beaconId as string,
        resolveActorId(req) as string,
        coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async getInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const target = req.params.volunteerId as string;
      // In `required` mode an inventory is private: yours, or a lead's view of it.
      if (env.AUTH_MODE === 'required' && req.account && !sameId(req.account.id, target) && !isLeadOrAbove(req.account)) {
        throw ApiError.forbidden('You can only view your own inventory.');
      }
      const inventory = await HackStopService.getVolunteerInventory(target);
      res.status(200).json({ success: true, data: inventory });
    } catch (error) {
      next(error);
    }
  }

  public static async usePowerUp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { itemType, targetGymId } = req.body;
      const result = await HackStopService.usePowerUp(resolveActorId(req) as string, itemType, targetGymId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
