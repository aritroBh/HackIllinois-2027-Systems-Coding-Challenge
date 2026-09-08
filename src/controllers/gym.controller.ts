/**
 * PokéShift gym HTTP surface — list control points, battle or reinforce one, and run the
 * gauntlet that a rival capture may require.
 *
 * A single endpoint covers both attack and defence: the service compares the caller's
 * faction to the gym's controlling faction and branches into reinforce, damage, or
 * capture. Keeping that decision server-side means a client cannot ask for the
 * favourable branch.
 *
 * ## The gauntlet, in three requests
 *
 * When the active pack ships `challenges.json` and sets `event.gauntlet.requiredForCapture`,
 * the last blow against a *rival* gym no longer flips it: `GymService.battleOrContribute`
 * floors the gym at 1 control point and says what would finish it. Taking it then costs a
 * challenge win, spent through these three handlers in order:
 *
 *   1. `startGauntlet`  — opens an attempt and serves the question (never an answer).
 *   2. `submitGauntlet` — judges it; a win leaves the attempt in WON, a single-use token.
 *   3. `spendGauntlet`  — burns the token and runs the ordinary capture path.
 *
 * Ally and neutral play is untouched, and a pack that ships no challenges (as
 * `content/example-campus` does) never reaches any of this — `GauntletService.requiredForCapture`
 * is false when the challenge list is empty, whatever the flag says.
 *
 * **Nothing here executes what a player sends.** `GauntletService` normalises the string,
 * HMACs it and compares digests. It verifies answers, not programs; there is no sandbox
 * because there is nothing to sandbox.
 *
 * All three gauntlet routes carry `requireSession` in `src/routes/v1/pokestop.routes.ts`, which
 * refuses a legacy-claimed identity as well as an anonymous caller. That is what makes the
 * `resolveActorId(req) as string` casts below safe on those three: with a proved session in
 * hand `resolveActorId` returns the session's account id and can never fall through to a body
 * `volunteerId`.
 */
import { Request, Response, NextFunction } from 'express';
import { GauntletService } from '../services/gauntlet.service';
import { GymService } from '../services/gym.service';
import { resolveActorId } from '../middleware/identity';

/**
 * Controller handling territory control, Gym strongholds, battles, reinforcements, and coding challenge gauntlets.
 */
export class GymController {
  /**
   * Every gym with its live control points — the map layer's read. No account is consulted,
   * because the route is ungated: in `legacy`, the shipped default auth mode, the caller may be
   * anonymous.
   *
   * That is why the answer is a projection and not the documents. A gym document carries
   * `leaderVolunteerId`, `leaderName`, `lastBattledAt`, and a `defenders` array whose entries
   * hold a volunteer's name, their contribution and an `assignedAt` timestamp. A gym is a named
   * campus building and contesting one requires standing inside its geofence — 75 m in both
   * shipped packs — so returning those
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
   * Open a coding challenge at the gym you are standing at. `201` with the served challenge.
   *
   * The geofence is checked inside `GauntletService.start` *before* a challenge is chosen, so
   * this cannot be used to enumerate the question set from elsewhere. The radius is the pack's,
   * resolved through `geofenceMetersFor` — not a literal here or there.
   *
   * The body carries only `coordinates`; the gym is the path id and the challenge is picked
   * server-side and deterministically from the gym id, so re-opening the same gym asks the same
   * question rather than letting a player reroll until they get one they know.
   *
   * Refusals worth expecting: 403 when the caller is outside the gym's geofence, 409 when the
   * gym is under an unexpired shield or this account already has an attempt open, and 404 when
   * the pack ships no challenges at all.
   */
  public static async startGauntlet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteerId = resolveActorId(req);
      const served = await GauntletService.start(volunteerId as string, req.params.id as string, req.body.coordinates);
      res.status(201).json({ success: true, data: served });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Judge an open attempt. Returns per-case verdicts and never the expected answer.
   *
   * `perCase` is a boolean per case and `correctCount`/`total` summarise it, so a player can see
   * *which* case they got wrong. What never leaves the server is what the right answer was: the
   * pack ships digests, and `GauntletService.judge` compares digests. Be exact about what that
   * buys — the same salt that keeps an answer from being read does not keep it from being
   * guessed, and the answer space is small. What bounds a guessing attack is the rest of the
   * mechanic: the geofence at both ends, a server-side deadline, and one open attempt per
   * account, so guesses cost walking back to the building.
   *
   * `won` is all-or-nothing, because a gym is. This handler does not capture anything; that is
   * `spendGauntlet` below, which is why the response names `nextAction: 'SPEND'` rather than
   * letting a client assume the banner has already changed.
   *
   * **`rewardKarma` is advertising, not a receipt.** It echoes the value the pack put on this
   * challenge (`challenges.schema.ts`, bounded 0–500). Nothing in `src/` awards it: the karma a
   * player actually receives is paid later, by the capture inside `GymService`, out of the
   * existing `GYM` source and under that source's daily cap. If the two numbers disagree, the
   * ledger is the true one.
   */
  public static async submitGauntlet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteerId = resolveActorId(req);
      const { won, perCase, challenge } = await GauntletService.submit(
        volunteerId as string,
        req.params.attemptId as string,
        req.body.answers,
        req.body.coordinates
      );
      res.status(200).json({
        success: true,
        data: {
          won,
          perCase,
          correctCount: perCase.filter(Boolean).length,
          total: perCase.length,
          // Named so the client knows the win is a token that still has to be spent, rather
          // than assuming the gym already changed hands.
          nextAction: won ? 'SPEND' : null,
          rewardKarma: won ? challenge.rewardKarma : 0,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Spend a win on the gym it was won at.
   *
   * Two steps, in this order: `GauntletService.spend` burns the token with a conditional update
   * from WON to SPENT, then the ordinary `GymService.battleOrContribute` capture path runs with
   * `viaGauntlet: true` and the challenge's own `capturePower`. The gym is the one recorded on
   * the attempt, not one the body names, so a win cannot be carried to a different building.
   *
   * The client sends `faction` and `coordinates` here as well as at start and submit. That is
   * the third geofence check, made by the capture path itself, and it is deliberate: a token
   * burned from the bus would otherwise flip a gym its holder had walked away from.
   *
   * **The failure this leaves open, stated rather than implied.** If the capture throws after
   * the token is burned — an unexpired shield, a lost compare-and-swap after five retries, a
   * faction mismatch — the win is gone and the map is unchanged, the same survivable direction
   * `GymService` already chose for karma. Nothing compensates it and no error message mentions
   * the lost token: what the player sees is the capture's own 409 or 403. This sentence used to
   * claim the error named it, which was never true of any message in this stack.
   *
   * The common case is guarded one layer down instead: `GauntletService.spend` refuses *before*
   * burning anything when the challenge is worth fewer control points than the gym still has,
   * and that refusal does say the win is still good.
   */
  public static async spendGauntlet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const volunteerId = resolveActorId(req);
      const { challenge, gymId } = await GauntletService.spend(volunteerId as string, req.params.attemptId as string, req.body.faction);
      const result = await GymService.battleOrContribute(
        gymId,
        volunteerId as string,
        req.body.faction,
        challenge.capturePower,
        req.body.coordinates,
        { viaGauntlet: true }
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * One endpoint for attacking, reinforcing and capturing. Which of the three happens is
   * decided in the service by comparing the caller's faction to the gym's, so a client cannot
   * ask for the branch that suits it; all it can do is declare a side.
   *
   * This docblock was for a while attached to the wrong method: the gauntlet handlers were
   * added above it and it ended up describing `startGauntlet`, so the endpoint it documents had
   * none. Worth a line, because a comment that has drifted onto its neighbour is the failure
   * this file's own review rounds keep finding.
   *
   * `faction`, `power` and `coordinates` are the client's; the actor is whatever
   * `resolveActorId` answers, which in `required` mode is the session and never a body id. In
   * `legacy` it may be the body id — the documented open-demo contract, and what the comment
   * below records. The asymmetry that leaves is worth naming: the declared faction is *checked against* the
   * account's stored allegiance rather than read from it, because a new account has none and
   * the first non-neutral declaration is what binds it — conditionally, so two first battles
   * racing each other cannot both win the binding.
   *
   * `resolveActorId` can answer `undefined` — legacy mode, no session, no body id — and the
   * `as string` cast carries that straight into the service. That is not an identity bypass:
   * the service's first act is to look the volunteer up and it refuses when there is none, and
   * no branch anywhere below treats a missing actor as a permitted one.
   *
   * The refusals a client should expect: a 400 VALIDATION_ERROR from the schema for power
   * outside 10–500, which is why the service's own bound on it is unreachable over HTTP; 400
   * for `NEUTRAL`, which is the unclaimed state rather than a side to fight for; 409 when the
   * declaration contradicts an allegiance already bound, or when the gym is under an
   * unexpired shield; and 403 when the coordinates place the caller outside the gym's geofence.
   *
   * That radius is the pack's, read through `geofenceMetersFor` with no venue key, so it is the
   * campus-wide value: `event.campus.geofenceMeters`, which is 75 in both shipped packs and is
   * also the schema's default. This paragraph named the literal 75 until the day a fork changed
   * it; the mechanism is what stays true.
   *
   * What is *not* named here is the gauntlet. When a pack requires it, the strike that would
   * have captured a rival gym instead returns `action: 'ATTACKED'` with the gym on 1 control
   * point and a message saying a challenge win is what finishes it. Same status code, same
   * shape, different ending — see `GymService.battleOrContribute`.
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
