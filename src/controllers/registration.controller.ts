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

/**
 * Controller governing shift registration, capacity reservation, waitlist queueing, and cancellation cascades.
 */
export class RegistrationController {
  /**
   * Reserve a seat, or take a queue place. The status code is the only thing this method
   * decides, and it decides it on one axis only: 201 for work done here, 200 when an
   * `Idempotency-Key` replay handed back the stored answer.
   *
   * So a waitlist place is also a 201. It is a created registration, not a rejection, and a
   * client that keys on the code alone will read a queue place as a confirmed seat — `status`
   * in the body is what distinguishes them. `cached` and `X-Cache-Lookup` are the two ways to
   * spot the replay.
   *
   * `allowWaitlist` is forwarded exactly as received, including `undefined`, so that the
   * service's default (queue me) stays the single definition of it. It is also part of the
   * idempotency fingerprint, which is what makes the same key sent once with a queue place
   * accepted and once without a conflict rather than a replay of the wrong answer.
   */
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

  /**
   * Cancels, and — when the seat released was a confirmed one — promotes the head of the
   * waitlist in the same call. That is why the difference shows up in the message rather than
   * in the status code: both outcomes are 200, and the caller learns that somebody was
   * promoted without learning who.
   *
   * Ownership is proved in the service, not asserted here: it compares the resolved caller
   * against the registration's own `volunteerId` with `sameId` and answers 403 on a mismatch,
   * because a registration id on its own would otherwise let anyone drop a stranger's shift
   * and take the seat behind it.
   *
   * A lead may cancel for someone else, but only by naming them in `onBehalfVolunteerId` —
   * which means sending a body. The dashboard's bodyless `DELETE` with a query parameter
   * therefore can never take the delegated path, whoever sends it.
   */
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

  /**
   * The registration roster, filtered by any combination of shift, volunteer and status.
   *
   * Deliberately not scoped to the caller. `requireVolunteerKind` on the route is the whole
   * access decision, on the stated ground that who is working which shift is staff
   * information — so any volunteer-kind caller may list anybody's registrations, and the
   * service leaves `email` out of the populated volunteer because of it.
   *
   * Known gap: there is no pagination and no cap. `?shiftId=` bounds it in practice and the
   * dashboard always sends one, but an unfiltered call returns every registration in the
   * event.
   */
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
