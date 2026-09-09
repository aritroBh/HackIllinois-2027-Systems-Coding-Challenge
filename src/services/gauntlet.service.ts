/**
 * The gauntlet: win a coding challenge, standing at the gym, to take it.
 *
 * Three things happen here and the order of them is the security argument.
 *
 * **The geofence is checked twice — at start and again at submit — and the second one is the
 * line that matters.** Checking only at the start means a player opens the challenge at the
 * gym and answers it from the bus; checking only at submit means the question set can be
 * harvested from anywhere. Both checks call `geofenceMetersFor()` with no venue key, which is
 * the same call `GymService.battleOrContribute` makes, so all three agree by construction.
 *
 * Be exact about what that resolves to, because an earlier version of this line was not. Called
 * with no key the function returns `event.campus.geofenceMeters`, falling back to
 * `DEFAULT_GEOFENCE_METERS`; a venue's own `radiusMeters` is never consulted on this path. It
 * cannot be: a `Gym` document stores coordinates and no venue key, so there is nothing here to
 * look one up by — the same limit is written out beside the identical call in
 * `src/services/gym.service.ts`. Widening a venue therefore changes nothing for a gym. Widening
 * `event.campus.geofenceMeters` widens all three at once.
 *
 * **Judging never interprets what a player sends.** The whole judge is
 * `string -> normalise -> HMAC -> timingSafeEqual` against a digest the pack ships. Nothing is
 * executed, so there is nothing to sandbox: no `vm`, no worker, no container, no third-party
 * runner. The cost is bounded before it is reached, by two caps that live outside this file:
 * `challengeSchema` allows a challenge at most eight cases, and `submitGauntletSchema` allows
 * at most eight answers of at most 200 characters each. A submission is therefore at most eight
 * sha256 HMACs over a few hundred bytes apiece, which is why these routes carry no limiter of
 * their own — `apiRateLimiter` and `mutationLimiter`, mounted on `/api/v1` in `src/app.ts`, are
 * the whole budget. What this buys is honesty about what it is — it verifies answers, not
 * programs, and `challenges.schema.ts` says so at length.
 *
 * **A win is spent exactly once**, by a conditional update from WON to SPENT. Twenty requests
 * carrying the same attempt id produce one capture and nineteen conflicts, decided by the
 * database rather than by a read followed by a write.
 *
 * What is deliberately NOT here: the capture itself. That stays in `GymService`, which already
 * owns the compare-and-set loop, the shield rule, the faction binding and the karma payout. A
 * won gauntlet is an argument to that code, not a second implementation of it — the alternative
 * is two capture paths that drift, which is how this repository ended up with two gazetteers.
 */
import crypto from 'crypto';
import { Types } from 'mongoose';
import { ChallengeAttempt, IChallengeAttempt, OPEN_ATTEMPT_KEY } from '../models/challengeAttempt.model';
import { Gym } from '../models/gym.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { pack } from '../content/loader';
import { Challenge } from '../content/challenges.schema';
import { geofenceMetersFor } from '../common/utils/geofence';
import { GeoEngine } from '../common/utils/geo';

/**
 * Namespaces the digest so a hash can never be reused as any other HMAC in this system.
 *
 * Two things prefix themselves with it: the answer HMAC in `hashFor`, and the plain sha256 in
 * `challengeForGym` that picks which challenge a gym asks. They are different constructions
 * over different inputs, and the shared prefix is what keeps either from ever colliding with a
 * booth QR code or a session digest.
 *
 * The `v1` is the escape hatch. Changing this string invalidates every digest in every authored
 * pack at once — nothing in `content/` can be judged again until `npm run gauntlet:hashes` is
 * re-run for each pack — so it is versioned rather than edited in place.
 */
const HASH_PREFIX = 'gauntlet:v1:';

/** A WGS84 point supplied by the player client for the geofence check. */
export interface Coordinates { latitude: number; longitude: number }

/** What the client is given when an attempt opens. Carries no answer, in any form. */
export interface ServedChallenge {
  attemptId: string;
  gymId: string;
  challengeId: string;
  title: string;
  prompt: string;
  kind: Challenge['kind'];
  difficulty: Challenge['difficulty'];
  choices?: string[];
  cases: { index: number; input: string }[];
  expiresAt: Date;
  capturePower: number;
}

/**
 * Coding challenge gauntlet service validating algorithmic puzzle solutions required for rival Gym takeovers.
 */
export class GauntletService {
  /**
   * Every challenge the pack ships, or an empty list when it ships none.
   *
   * `pack.challenges` is `null`, not `[]`, when the pack has no `challenges.json` at all —
   * `content/example-campus` is that case. The distinction matters to `loader.ts` and to
   * nothing here, so it is flattened to a list the callers can iterate without a null check.
   * Anything in this list has been through `challengesSchema`: `loadPack` throws on any issue,
   * so a pack whose challenges do not validate does not boot, it does not boot degraded.
   */
  public static list(): Challenge[] {
    return pack.challenges ?? [];
  }

  /**
   * This pack's answer salt. Only meaningful when the pack ships challenges.
   *
   * The `''` fallback is unreachable while judging rather than merely harmless: `start` refuses
   * with a 404 when the list is empty, and `submit` refuses when the attempt's challenge is no
   * longer in the pack, so no digest is ever produced under the empty salt and compared against
   * one produced under a real salt.
   */
  public static salt(): string {
    return pack.challengesSalt ?? '';
  }

  /**
   * A challenge by its pack id, or null when this pack no longer ships it.
   *
   * Null is a real case, not defensive padding, and both callers translate it into a 404: an
   * attempt row outlives the pack that served it, so an event that swaps its `challenges.json`
   * while somebody has an attempt open leaves rows pointing at an id that is gone.
   */
  public static byId(id: string): Challenge | null {
    return this.list().find((c) => c.id === id) ?? null;
  }

  /**
   * Whether a pack has turned the gauntlet requirement on. Off means gyms capture as before.
   *
   * The `length > 0` half is the important one. A pack that sets `requiredForCapture` while
   * shipping no challenges would otherwise make every rival gym permanently uncapturable — the
   * flip would demand a win that nothing can serve — so the flag is refused unless there is
   * something to unlock it with. `src/content/schema.ts` defaults it to false for the same
   * reason, one layer earlier.
   */
  public static requiredForCapture(): boolean {
    return this.list().length > 0 && pack.event.gauntlet.requiredForCapture;
  }

  /**
   * Fold an answer to the form the pack said counts as the same.
   *
   * Applied identically when a digest is generated (`scripts/gauntletHashes.ts` imports this
   * function rather than reimplementing it) and when a submission is judged. Two copies of
   * this rule would be two copies that drift, and the symptom would be every answer in a pack
   * silently becoming wrong.
   *
   * The only two regular expressions here are literals. Nothing is built from player input, so
   * there is no expression a submission can make expensive.
   */
  public static normalise(text: string, rules: Challenge['normalise']): string {
    let out = String(text ?? '');
    if (rules.collapseWhitespace) out = out.replace(/\s+/g, ' ');
    if (rules.trim) out = out.trim();
    if (rules.caseInsensitive) out = out.toLowerCase();
    return out;
  }

  /**
   * The one definition of "correct". `scripts/gauntletHashes.ts` calls this to author a pack,
   * which is what keeps authoring and judging from drifting apart.
   *
   * Keyed on the pack's own `answerSalt` rather than on `QR_HMAC_SECRET`: see the trade-off
   * written out in `challenges.schema.ts`. In short, the server secret is ephemeral per boot
   * outside production, so a pack keyed on it would stop judging correctly the next morning.
   */
  public static hashFor(challengeId: string, caseIndex: number, answer: string, rules: Challenge['normalise'], salt: string = this.salt()): string {
    return crypto
      .createHmac('sha256', salt)
      .update(`${HASH_PREFIX}${challengeId}:${caseIndex}:${this.normalise(answer, rules)}`)
      .digest('hex');
  }

  /**
   * Judge a submission. Returns a verdict per case and whether every one of them passed.
   *
   * Partial credit is not a thing: a gym is binary, and reporting "three of four" would invite
   * a player to brute-force the fourth one case at a time.
   *
   * `timingSafeEqual` needs equal lengths, so the digests are compared as fixed-width buffers
   * built from our own hex on both sides — a submission cannot influence the length.
   */
  public static judge(challenge: Challenge, answers: string[]): { won: boolean; perCase: boolean[] } {
    const perCase = challenge.cases.map((c, i) => {
      const given = this.hashFor(challenge.id, i, answers[i] ?? '', challenge.normalise);
      const a = Buffer.from(given, 'hex');
      const b = Buffer.from(c.hash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    return { won: perCase.every(Boolean), perCase };
  }

  /** Refuse unless the caller is standing inside the gym's own geofence. */
  private static assertAtGym(gym: { latitude: number; longitude: number; name: string }, coordinates: Coordinates): void {
    const radiusMeters = geofenceMetersFor();
    const check = GeoEngine.isWithinGeofence(coordinates, { latitude: gym.latitude, longitude: gym.longitude }, radiusMeters);
    if (!check.allowed) {
      // Quotes the radius that was applied rather than a literal, so the message cannot
      // disagree with the rule that produced it.
      throw ApiError.forbidden(`Out of range: You are ${check.distanceMeters}m from ${gym.name}. Must be within ${check.maxRadiusMeters}m to attempt its challenge.`);
    }
  }

  /**
   * Pick the challenge for a gym. Deterministic, so re-opening the same gym asks the same thing
   * rather than letting a player reroll until they get one they know.
   */
  private static challengeForGym(gymId: string): Challenge {
    const all = this.list();
    if (!all.length) throw ApiError.notFound('This event ships no coding challenges.', ErrorCode.NOT_FOUND);
    const digest = crypto.createHash('sha256').update(`${HASH_PREFIX}pick:${gymId}`).digest();
    return all[digest.readUInt32BE(0) % all.length];
  }

  /**
   * Open an attempt at a gym the player is standing at.
   *
   * The geofence is checked before a challenge is even chosen, so a caller who is not there
   * cannot use this endpoint to enumerate the question set.
   */
  public static async start(accountId: string, gymId: string, coordinates: Coordinates): Promise<ServedChallenge> {
    const gym = await Gym.findById(gymId);
    if (!gym) throw ApiError.notFound('Gym not found.');
    this.assertAtGym(gym, coordinates);

    if (gym.isShielded && gym.shieldExpiresAt && gym.shieldExpiresAt > new Date()) {
      throw ApiError.conflict('Gym is currently protected by an active Boba Shield. Cannot contest!');
    }

    const challenge = this.challengeForGym(String(gym._id));
    const now = Date.now();
    const expiresAt = new Date(now + challenge.timeLimitSeconds * 1000);

    // Sweep this account's own stale attempts first, so a player whose clock ran out is not
    // locked out of the whole mechanic until a background job notices. Conditional on the
    // deadline, so it can never touch a live one.
    await ChallengeAttempt.updateMany(
      { accountId: new Types.ObjectId(accountId), status: 'OPEN', expiresAt: { $lte: new Date(now) } },
      { $set: { status: 'EXPIRED', openKey: null } }
    );

    let attempt: IChallengeAttempt;
    try {
      attempt = await ChallengeAttempt.create({
        accountId: new Types.ObjectId(accountId),
        gymId: gym._id,
        challengeId: challenge.id,
        status: 'OPEN',
        openKey: OPEN_ATTEMPT_KEY,
        startedAt: new Date(now),
        expiresAt,
      });
    } catch (err) {
      // The partial unique index decides this, not a preceding count — two starts in the same
      // millisecond produce one attempt and one duplicate-key error.
      if ((err as { code?: number }).code === 11000) {
        throw ApiError.conflict('You already have a challenge open. Finish it or let it run out first.', ErrorCode.DUPLICATE_RESOURCE);
      }
      throw err;
    }

    return {
      attemptId: String(attempt._id),
      gymId: String(gym._id),
      challengeId: challenge.id,
      title: challenge.title,
      prompt: challenge.prompt,
      kind: challenge.kind,
      difficulty: challenge.difficulty,
      ...(challenge.choices ? { choices: challenge.choices } : {}),
      // Only the inputs travel. The digests stay on this side.
      cases: challenge.cases.map((c, index) => ({ index, input: c.input })),
      expiresAt,
      capturePower: challenge.capturePower,
    };
  }

  /**
   * Judge an open attempt.
   *
   * Returns the verdict and, on a win, leaves the attempt in WON — a single-use token the
   * caller spends through `GymService`. This does not capture anything itself; see the note at
   * the top of the file about not growing a second capture path.
   */
  public static async submit(accountId: string, attemptId: string, answers: string[], coordinates: Coordinates): Promise<{
    won: boolean; perCase: boolean[]; challenge: Challenge; gymId: string; attempt: IChallengeAttempt;
  }> {
    if (!Types.ObjectId.isValid(attemptId)) throw ApiError.badRequest('Invalid attempt id.', { code: ErrorCode.VALIDATION_ERROR });
    const attempt = await ChallengeAttempt.findOne({ _id: attemptId, accountId: new Types.ObjectId(accountId) });
    if (!attempt) throw ApiError.notFound('No such challenge attempt.');
    if (attempt.status !== 'OPEN') throw ApiError.conflict('That challenge is already finished.');

    const gym = await Gym.findById(attempt.gymId);
    if (!gym) throw ApiError.notFound('Gym not found.');
    // The second geofence check, and the reason a player cannot start here and answer elsewhere.
    this.assertAtGym(gym, coordinates);

    // The deadline is the server's, compared here rather than swept by a job, so a lapsed
    // attempt is refused the moment it is used whatever a background sweeper is doing. A
    // correct answer arriving late still loses; that is what a deadline means.
    if (attempt.expiresAt.getTime() <= Date.now()) {
      attempt.status = 'EXPIRED';
      attempt.openKey = null;
      await attempt.save();
      throw ApiError.conflict('Time is up on that challenge. Start another one.');
    }

    const challenge = this.byId(attempt.challengeId);
    if (!challenge) throw ApiError.notFound('That challenge is no longer in this event\'s content pack.');

    const { won, perCase } = this.judge(challenge, answers);
    attempt.status = won ? 'WON' : 'LOST';
    attempt.openKey = null;
    attempt.answeredAt = new Date();
    attempt.perCase = perCase;
    await attempt.save();

    return { won, perCase, challenge, gymId: String(gym._id), attempt };
  }

  /**
   * Spend a win, exactly once.
   *
   * The conditional update IS the guarantee: the filter names the state the caller believes
   * they are in, so a second request carrying the same id matches nothing and is told so.
   * Returns the challenge whose terms the capture should use.
   */
  public static async spend(accountId: string, attemptId: string, actorFaction?: string): Promise<{ challenge: Challenge; gymId: string }> {
    if (!Types.ObjectId.isValid(attemptId)) throw ApiError.badRequest('Invalid attempt id.', { code: ErrorCode.VALIDATION_ERROR });

    /*
     * Refuse BEFORE burning the token if the win cannot actually take the gym.
     *
     * A challenge is worth `capturePower` control points, and the capture branch needs that to
     * meet or exceed what the gym has left. Spending anyway did something worse than failing:
     * the win was consumed and applied as an ordinary hit, so a player who answered correctly
     * watched the banner not change and had nothing left to try again with. That is the
     * enabled-button-that-always-fails shape one layer up — the action succeeds and does not
     * do the thing it was for.
     *
     * The check is deliberately *before* the single-spend update. Ordering it the other way
     * would make the refusal cost the token it is protecting.
     */
    const held = await ChallengeAttempt.findOne({ _id: attemptId, accountId: new Types.ObjectId(accountId), status: 'WON' });
    if (held) {
      const gym = await Gym.findById(held.gymId);
      const challenge = this.byId(held.challengeId);
      if (gym && challenge && actorFaction && gym.controllingFaction !== actorFaction && gym.controllingFaction !== 'NEUTRAL') {
        if (challenge.capturePower < gym.controlPoints) {
          throw ApiError.conflict(
            `${gym.name} still has ${gym.controlPoints} control points and this challenge is worth ${challenge.capturePower}. `
            + 'Wear it down first, then spend your win on the last blow. Your win is still good.'
          );
        }
      }
    }

    const spent = await ChallengeAttempt.findOneAndUpdate(
      { _id: attemptId, accountId: new Types.ObjectId(accountId), status: 'WON' },
      { $set: { status: 'SPENT', spentAt: new Date(), openKey: null } },
      { new: true }
    );
    if (!spent) throw ApiError.conflict('That challenge win has already been used.', ErrorCode.DUPLICATE_RESOURCE);
    const challenge = this.byId(spent.challengeId);
    if (!challenge) throw ApiError.notFound('That challenge is no longer in this event\'s content pack.');
    return { challenge, gymId: String(spent.gymId) };
  }
}
