/**
 * PokéShift gym HTTP surface — list control points, battle or reinforce one.
 *
 * A single endpoint covers both attack and defence: the service compares the caller's
 * faction to the gym's controlling faction and branches into reinforce, damage, or
 * capture. Keeping that decision server-side means a client cannot ask for the
 * favourable branch.
 */
import { Request, Response, NextFunction } from 'express';
import { GymService } from '../services/gym.service';
import { resolveActorId } from '../middleware/identity';

export class GymController {
  /**
   * Every gym with its live control points — the map layer's read. No account is consulted,
   * because the route is ungated: in `legacy`, the shipped default auth mode, the caller may be
   * anonymous.
   *
   * That is why the answer is a projection and not the documents. A gym document carries
   * `leaderVolunteerId`, `leaderName`, `lastBattledAt`, and a `defenders` array whose entries
   * hold a volunteer's name, their contribution and an `assignedAt` timestamp. A gym is a named
   * campus building and contesting one requires standing within 75 m of it, so returning those
   * said that a named person was at a named place at a stated moment — to anyone who asked, with
   * no session behind the request and no audit row behind the read. It was the same shape as the
   * `lastSpunUsers` map that had already been taken off the beacon listing for this reason.
   *
   * `GymService.listGymsPublic` is where the redaction lives and what it keeps is documented on
   * `PublicGym`. Gating the route instead would have been the wrong fix: the territory map is
   * meant to be readable by a hacker who has not signed in, and the scoreboard half of this
   * response is not sensitive. What was sensitive was the half nothing rendered.
   */
  public static async listGyms(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const gyms = await GymService.listGymsPublic();
      res.status(200).json({ success: true, data: gyms });
    } catch (error) {
      next(error);
    }
  }

  /**
   * One endpoint for attacking, reinforcing and capturing. Which of the three happens is
   * decided in the service by comparing the caller's faction to the gym's, so a client cannot
   * ask for the branch that suits it; all it can do is declare a side.
   *
   * `faction`, `power` and `coordinates` are the client's; the actor is whatever
   * `resolveActorId` answers, which in `required` mode is the session and never a body id. In
   * `legacy` it may be the body id — the documented open-demo contract, and what the comment
   * below records. The asymmetry that leaves is worth naming: the declared faction is *checked against* the
   * account's stored allegiance rather than read from it, because a new account has none and
   * the first non-neutral declaration is what binds it — conditionally, so two first battles
   * racing each other cannot both win the binding.
   *
   * The refusals a client should expect: a 400 VALIDATION_ERROR from the schema for power
   * outside 10–500, which is why the service's own bound on it is unreachable over HTTP; 400
   * for `NEUTRAL`, which is the unclaimed state rather than a side to fight for; 409 when the
   * declaration contradicts an allegiance already bound, or when the gym is under an
   * unexpired shield; and 403 when coordinates are sent and place the caller more than 75 m
   * away.
   */
  public static async battleOrContribute(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { faction, power, coordinates } = req.body;
      // The actor is the session (or, in legacy mode, the body id) — never a body id over a session.
      const volunteerId = resolveActorId(req);
      const result = await GymService.battleOrContribute(
        req.params.id as string,
        volunteerId as string,
        faction,
        power,
        coordinates
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}
