/**
 * HackStop HTTP surface — list beacons, spin one, read and spend inventory.
 *
 * A spin is gated on both the 75 m geofence and a 5-minute per-volunteer cooldown, and
 * the loot roll happens server-side so the client cannot influence rarity.
 *
 * Worth knowing about the shipped client: it sends the campus player's real position, and
 * when it does not have one it refuses to send the request at all rather than substituting
 * anything. It used to fall back to the *beacon's own coordinates*, which satisfied the
 * geofence by measuring the distance from a point to itself — the check could not fail. That
 * is gone; the button now stays disabled and says what would enable it.
 *
 * The server-side check was and is unconditional, which is why that was a defect in the game
 * rather than a hole in the perimeter: the server always measured, it was simply handed a
 * number that made the answer a foregone conclusion.
 */
import { Request, Response, NextFunction } from 'express';
import { HackStopService } from '../services/hackstop.service';
import { resolveActorId } from '../middleware/identity';
import { isProvenLead } from '../common/types/account';
import { sameId } from '../common/utils/id';
import { ApiError } from '../common/errors/apiError';

export class HackStopController {
  public static async listBeacons(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // The caller's own cooldown is theirs to see; everybody else's is not, and a *claimed*
      // identity is not a caller. See the service.
      const beacons = await HackStopService.listBeacons(
        _req.account ? { id: _req.account.id, source: _req.account.source } : null
      );
      res.status(200).json({ success: true, data: beacons });
    } catch (error) {
      next(error);
    }
  }

  public static async spinBeacon(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { coordinates } = req.body;
      const result = await HackStopService.spinBeacon(
        req.params.beaconId as string,
        resolveActorId(req) as string,
        coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  public static async getInventory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const target = req.params.volunteerId as string;
      // An inventory is private in **every** mode: yours, or a proved lead's view of it.
      //
      // This used to be conditional on `env.AUTH_MODE === 'required'`, which turned the check
      // off in the shipped default, and on `req.account` being set, which let an anonymous
      // caller short-circuit it in the one mode that was supposed to enforce it. The route now
      // requires a session, so `req.account` is always present here and always proved; the
      // remaining question is only whether it is *this* account or a lead.
      if (!sameId(req.account!.id, target) && !isProvenLead(req.account)) {
        throw ApiError.forbidden('You can only view your own inventory.');
      }
      const inventory = await HackStopService.getVolunteerInventory(target);
      res.status(200).json({ success: true, data: inventory });
    } catch (error) {
      next(error);
    }
  }

  public static async usePowerUp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { itemType, targetGymId, coordinates } = req.body;
      const result = await HackStopService.usePowerUp(resolveActorId(req) as string, itemType, targetGymId, coordinates);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
