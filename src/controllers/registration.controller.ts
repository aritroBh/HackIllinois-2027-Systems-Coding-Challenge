/**
 * Registration HTTP surface — reserve, cancel, list.
 *
 * Controllers in this codebase are deliberately thin. Their only jobs are to pull typed
 * values off an already-validated request, call one service method, and map the result
 * to a status code. No Mongoose, no invariant logic, no branching on domain state.
 *
 * Errors are never caught and translated here; they are forwarded with `next(error)` so
 * the single `errorHandler` owns the response envelope. That is what keeps error shape
 * consistent across every endpoint.
 *
 * Two mappings specific to this resource:
 *  - `201` for a newly created registration, `200` when an idempotent replay returns the
 *    stored response, distinguished by the `X-Cache-Lookup: HIT-IDEMPOTENT` header.
 *  - The cancel route accepts the owner id from body *or* query, because the dashboard
 *    issues a bodyless `DELETE` with a query parameter.
 */
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
      // ponytail: owner proof required — anonymous cross-user cancels are rejected as 403 in the service.
      const callerVolunteerId = (req.body?.volunteerId as string | undefined) ?? (req.query.volunteerId as string | undefined);
      const result = await RegistrationService.cancelRegistration(req.params.id as string, callerVolunteerId);
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
