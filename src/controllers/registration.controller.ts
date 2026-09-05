import { Request, Response, NextFunction } from 'express';
import { RegistrationService } from '../services/registration.service';

export class RegistrationController {
  public static async reserveShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const result = await RegistrationService.reserveShift({
        shiftId: req.body.shiftId,
        volunteerId: req.body.volunteerId,
        idempotencyKey,
      });

      const statusCode = result.cached ? 200 : 201;
      if (result.cached) {
        res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
      }

      res.status(statusCode).json({
        success: true,
        data: result.registration,
        status: result.status,
        waitlistPosition: result.waitlistPosition,
        cached: result.cached,
      });
    } catch (error) {
      next(error);
    }
  }

  public static async cancelRegistration(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await RegistrationService.cancelRegistration(req.params.id as string);
      res.status(200).json({
        success: true,
        data: result,
        message: result.promoted
          ? 'Registration cancelled. Head of waitlist was automatically promoted.'
          : 'Registration cancelled.',
      });
    } catch (error) {
      next(error);
    }
  }

  public static async listRegistrations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { shiftId, volunteerId, status } = req.query;
      const registrations = await RegistrationService.listRegistrations({
        shiftId: shiftId as string,
        volunteerId: volunteerId as string,
        status: status as any,
      });
      res.status(200).json({ success: true, data: registrations });
    } catch (error) {
      next(error);
    }
  }
}
