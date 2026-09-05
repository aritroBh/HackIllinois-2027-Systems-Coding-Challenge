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
