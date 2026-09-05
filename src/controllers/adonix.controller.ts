import { Request, Response, NextFunction } from 'express';
import { AdonixSyncService } from '../services/adonixSync.service';

export class AdonixController {
  public static async syncOfficialEvents(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AdonixSyncService.syncOfficialEvents();
      res.status(200).json({
        success: true,
        message: `Successfully synchronized ${result.syncedCount} shifts with HackIllinois Adonix API.`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}
