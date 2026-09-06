/**
 * Attendance HTTP surface — mint a rotating QR token, verify a desk scan, check out.
 *
 * Thin by design: validation has already run, so these methods unpack the request and
 * delegate. The interesting behaviour (HMAC verification, replay rejection, geofence,
 * pro-rata karma) lives in `CheckInService`.
 *
 * `POST /token` mints for the **caller's own** registration: the route requires volunteer
 * kind, and in `AUTH_MODE=required` the account comes from the session, so a volunteer can
 * only ever obtain their own token. In `legacy` the id is claimed, which is the documented
 * open-demo contract for actions.
 *
 * This comment used to say the endpoint was unauthenticated and "should sit behind organiser
 * auth". That was true when it was written and is not now — and organiser-gating it would be
 * the wrong fix anyway, because minting is what the volunteer's own phone does at the desk.
 * The gate that mattered went on `/verify`, which is the scanner: `requireRole('SHIFT_LEAD')`,
 * so the person being checked in cannot also be the one who scans them.
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
        req.body.coordinates,
        req.account?.id
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
