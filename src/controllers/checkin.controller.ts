import { Request, Response, NextFunction } from 'express';
import { CheckInService } from '../services/checkin.service';

export class CheckInController {
  public static async generateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await CheckInService.generateToken(req.body.volunteerId, req.body.shiftId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async verifyCheckIn(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await CheckInService.verifyAndCheckIn(req.body.token, req.body.scannerId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async checkOut(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const checkIn = await CheckInService.checkOut(req.params.id as string);
      res.status(200).json({ success: true, data: checkIn });
    } catch (error) {
      next(error);
    }
  }
}
