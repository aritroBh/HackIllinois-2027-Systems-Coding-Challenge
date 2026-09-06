/**
 * Attendance HTTP surface — mint a rotating QR token, verify a desk scan, check out.
 *
 * Thin by design: validation has already run, so these methods unpack the request and
 * delegate. The interesting behaviour (HMAC verification, replay rejection, geofence,
 * pro-rata karma) lives in `CheckInService`.
 *
 * Note that token minting is currently unauthenticated — anyone who can name a
 * volunteer with a confirmed registration can obtain a valid token for them. The HMAC is
 * unforgeable, but the issuing endpoint will sign for any caller, so this route should
 * sit behind organiser auth before real use.
 */
import { Request, Response, NextFunction } from 'express';
import { CheckInService } from '../services/checkin.service';
import { resolveActorId } from '../middleware/identity';

export class CheckInController {
  public static async generateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // A token is only ever minted for the caller's own account (legacy mode: the body id).
      const result = await CheckInService.generateToken(resolveActorId(req) as string, req.body.shiftId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async verifyCheckIn(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await CheckInService.verifyAndCheckIn(
        req.body.token,
        req.body.scannerId,
        req.body.coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async checkOut(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const checkIn = await CheckInService.checkOut(req.params.id as string, resolveActorId(req));
      res.status(200).json({ success: true, data: checkIn });
    } catch (error) {
      next(error);
    }
  }
}
