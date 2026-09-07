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
  /**
   * The beacon list answers an unproved caller rather than refusing one: an identity that was
   * claimed rather than proved, or none at all, gets the beacons with no cooldown fields on
   * them. That shape only ever occurs in `legacy` mode. In `required` mode this path is not on
   * `enforceAuthMode`'s allow-list, so an anonymous request is already a 401 and everyone who
   * reaches here holds a proved session.
   *
   * What is handed to the service is the caller's id *and how it was established*, because it
   * needs both. Passing `req.account.id` on its own would have handed a legacy-claimed
   * identity the per-caller cooldown, and since account ids are public that is the same
   * position-history disclosure the whole `lastSpunUsers` map was removed for, rebuilt one
   * beacon at a time. The service's own comment carries the detail.
   */
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

  /**
   * Spins a beacon for loot. 200 with what was rolled; the roll happens server-side, so
   * nothing in the request can influence rarity.
   *
   * Two refusals mean quite different things to a player and are worth telling apart. 403 is
   * being out of range, and quotes the measured distance against the beacon's own configured
   * radius. 409 is the per-volunteer cooldown, and quotes the seconds remaining. The service
   * checks the cooldown twice — cheaply up front so a double-tap gets a countdown instead of
   * a wasted roll, and then as a conditional claim, which is the one that actually enforces
   * it against two concurrent spins.
   *
   * `beaconId` is the beacon's own string key rather than an ObjectId, which is why it is the
   * one path parameter in this file not run through `objectId()`.
   */
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

  /**
   * Somebody's bag, addressed by id in the path. The ownership check is the reason this is
   * not a one-liner, and the comment inside it records what the two previous versions of that
   * check got wrong; do not simplify it back.
   *
   * The `req.account!` assertion is load-bearing on the route carrying both `requireSession`
   * and `requireAccount`. Remount this handler without them and the assertion becomes a lie
   * that fails open rather than closed, which is precisely how the earlier version broke.
   */
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

  /**
   * Spends one item out of the caller's inventory. Everything that decides whether it may be
   * spent lives in the service, and the ordering there is the point: the target gym is
   * resolved, the caller's position is checked against it, and the faction rule is applied,
   * all before the quantity is decremented. There is no transaction around the two, so a
   * refusal after the decrement would eat the item and pay nothing for it.
   *
   * `coordinates` is optional in the schema and required by the service for the two
   * gym-targeted items only. That split is deliberate rather than sloppy: an item that is
   * drunk rather than aimed should not demand a position from a player who never opened the
   * campus renderer and has none to give.
   */
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
