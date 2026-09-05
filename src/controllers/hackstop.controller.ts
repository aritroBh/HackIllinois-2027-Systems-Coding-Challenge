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

export class HackStopController {
  public static async listBeacons(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const beacons = await HackStopService.listBeacons();
      res.status(200).json({ success: true, data: beacons });
    } catch (error) {
      next(error);
    }
  }

  public static async spinBeacon(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { volunteerId, coordinates } = req.body;
      const result = await HackStopService.spinBeacon(
        req.params.beaconId as string,
        volunteerId,
        coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async getInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const inventory = await HackStopService.getVolunteerInventory(req.params.volunteerId as string);
      res.status(200).json({ success: true, data: inventory });
    } catch (error) {
      next(error);
    }
  }

  public static async usePowerUp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { volunteerId, itemType, targetGymId } = req.body;
      const result = await HackStopService.usePowerUp(volunteerId, itemType, targetGymId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
