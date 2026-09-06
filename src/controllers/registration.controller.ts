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
import { resolveActorId, resolveOnBehalf } from '../middleware/identity';

export class RegistrationController {
  public static async reserveShift(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      // Registration is the one flow a lead may drive for someone else: the roster desk
      // signing a volunteer up at the table. It must be asked for explicitly, in
      // `onBehalfVolunteerId`, by a signed-in lead — see `resolveOnBehalf`.
      const onBehalf = resolveOnBehalf(req);
      const result = await RegistrationService.reserveShift({
        shiftId: req.body.shiftId,
        volunteerId: (onBehalf?.subjectId ?? resolveActorId(req)) as string,
        // Absent means "queue me if the shift is full", which is what every client has
        // always got. Only an explicit `false` asks for confirm-or-fail.
        allowWaitlist: req.body.allowWaitlist,
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
      // Owner proof: the session's account (legacy mode: the body/query id). The service
      // still compares it with `sameId` and rejects cross-user cancels as 403.
      const callerVolunteerId = resolveOnBehalf(req)?.subjectId ?? resolveActorId(req);
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
