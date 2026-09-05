import { Request, Response, NextFunction } from 'express';
import { ShiftService } from '../services/shift.service';

export class ShiftController {
  public static async createShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.createShift(req.body);
      res.status(201).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  public static async listShifts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { category, location, availableOnly, surgeOnly, limit, offset } = req.query;
      const result = await ShiftService.listShifts({
        category: category as any,
        location: location as string,
        availableOnly: availableOnly === 'true',
        surgeOnly: surgeOnly === 'true',
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.status(200).json({ success: true, data: result.shifts, total: result.total });
    } catch (error) {
      next(error);
    }
  }

  public static async getShiftById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.getShiftById(req.params.id as string);
      res.status(200).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  public static async updateShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shift = await ShiftService.updateShift(req.params.id as string, req.body);
      res.status(200).json({ success: true, data: shift });
    } catch (error) {
      next(error);
    }
  }

  public static async deleteShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ShiftService.deleteShift(req.params.id as string);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
