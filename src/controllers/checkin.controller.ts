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

/**
 * Controller managing shift check-in lifecycle: token minting, desk QR verification, and check-out settlement.
 */
export class CheckInController {
  /**
   * Mints the volunteer's own rotating QR token. 200, and the body is useful only for the
   * thirty-second slice it names: `expiresInSeconds` is the remainder of the *current* slice
   * rather than a flat thirty, so a phone that refreshes on that number stays in step with
   * the server's slices instead of drifting half a slice out of them.
   *
   * `shiftId` is the only thing taken from the request; the volunteer comes from
   * `resolveActorId`, so under `AUTH_MODE=required` a session can only ever mint its own.
   * Minting is refused with a 400 when the caller holds no CONFIRMED or CHECKED_IN
   * registration for that shift — the cheap check. Every expensive one (replay, geofence,
   * the shift's own time window) is on the scan, which is where the fraud would be.
   */
  public static async generateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // A token is only ever minted for the caller's own account (legacy mode: the body id).
      const result = await CheckInService.generateToken(resolveActorId(req) as string, req.body.shiftId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The desk scan. Four values go into the service and they come from three different places,
   * which is the whole security shape of this endpoint.
   *
   * The token and the coordinates are the scanner's, and both are checked rather than
   * believed. `scannerId` is a free label the client chooses — it distinguishes one desk from
   * another and is evidence of nothing, since anyone may send it — while `req.account?.id`
   * comes from the session cookie and is what the service records as the answer to "who
   * verified this". They are separate arguments precisely so the label cannot be mistaken for
   * the attribution.
   *
   * Nothing in the request names the volunteer being checked in; that comes out of the
   * token's signed payload. So no body a scanner can compose credits somebody else's
   * attendance. What separates the scanner from the scanned is `requireRole('SHIFT_LEAD')` on
   * the route, not anything here — see the file header.
   *
   * Honest gap in the attribution. `attachIdentity` runs at the `/api/v1` mount, ahead of
   * `validate`, so in `AUTH_MODE=legacy` a `volunteerId` in the body still establishes an
   * identity even though this route's schema then strips the field as unknown. The recorded
   * verifier can therefore be a claimed id rather than a proved one in that mode. That is the
   * documented legacy contract for actions, but it means the audit trail is only as good as
   * the mode the deployment runs in.
   */
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

  /**
   * Closes the shift and pays the karma. 200 either way: a check-in that is already closed
   * comes back as the settled record rather than an error, so a client retrying after a
   * dropped connection does not have to tell the two apart.
   *
   * The check-in id is a path parameter and the actor is the session, and the service compares
   * them — holding the id is not authority to close the record. Note that `resolveActorId` is
   * not asserted non-null here, unlike its other call sites: in `legacy` mode with no body
   * `volunteerId` it genuinely returns `undefined`, and the service turns that into a 400
   * rather than letting an absent identity satisfy an ownership check.
   */
  public static async checkOut(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const checkIn = await CheckInService.checkOut(req.params.id as string, resolveActorId(req));
      res.status(200).json({ success: true, data: checkIn });
    } catch (error) {
      next(error);
    }
  }
}
