import { Request, Response, NextFunction } from 'express';
import { Volunteer } from '../models/volunteer.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

export class VolunteerController {
  public static async createVolunteer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteer = await Volunteer.create(req.body);
      res.status(201).json({ success: true, data: volunteer });
    } catch (error) {
      next(error);
    }
  }

  public static async listVolunteers(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteers = await Volunteer.find().sort({ createdAt: -1 });
      res.status(200).json({ success: true, data: volunteers });
    } catch (error) {
      next(error);
    }
  }

  public static async getVolunteerById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteer = await Volunteer.findById(req.params.id);
      if (!volunteer) {
        throw ApiError.notFound('Volunteer not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      }
      res.status(200).json({ success: true, data: volunteer });
    } catch (error) {
      next(error);
    }
  }
}
