/**
 * Coding challenges in a content pack — the gauntlet a player must win to take a gym.
 *
 * A pack decides what its event asks people to solve. The server knows one way to judge:
 * normalise the submitted text, HMAC it, and compare against a digest the pack ships. That is
 * the whole judge, and the shape of this schema follows from two constraints.
 *
 * **The pack directory is public.** `src/app.ts` serves it with `express.static(pack.dir)` at
 * `/dashboard/content`, and `publicContent()` maps every file in the pack into a URL. A
 * plaintext answer written here would be a download, not a secret — the answer key, served to
 * anybody who guesses a filename. So `cases[].hash` is the only form an answer may take, and
 * `answer` is rejected outright rather than ignored, because a field that is quietly dropped is
 * a field somebody will believe was honoured. `scripts/gauntletHashes.ts` turns a working file
 * of plaintext answers into the digests that go in the pack.
 *
 * **The digest is keyed on a salt that ships in this file, not on `QR_HMAC_SECRET`**, and that
 * is a deliberate trade rather than an oversight. Keying on the server secret would have been
 * stronger, and it would also have meant that rotating that secret silently invalidated every
 * answer in every pack, and that the same pack could not be validated offline or shared
 * between two deployments. `npm run demo` alone generates a fresh `QR_HMAC_SECRET` on every
 * boot, so a pack authored on Tuesday would have stopped judging on Wednesday.
 *
 * Be exact about what a shipped salt buys, because it is less than it looks. **It stops the
 * answer being read; it does not stop it being guessed.** The answer space for "what does this
 * print" is small, and anyone who downloads the pack can hash candidate answers against the
 * salt offline until one matches. What actually bounds cheating here is physical and temporal
 * — you must be inside the gym's geofence when you start and again when you submit, the
 * attempt carries a server-side deadline, one submission ends it, and only one attempt is open
 * per account at a time. The salt is what stops a casual reader; the geofence is what stops a
 * determined one from being somewhere else while they do it.
 *
 * **Nothing is executed.** This verifies answers, not programs. There is no sandbox, no `vm`,
 * no worker and no container, and adding one is a different piece of work with its own threat
 * model. Reading a snippet and predicting its output is a real skill and a real filter; calling
 * it a code runner would be a lie, and it is the kind of lie that survives in a README long
 * after somebody has assumed it and built on it.
 *
 * **A known limit, stated because it will be found.** Every player of a given challenge sees
 * the same input, so the answer is a constant and can be shared. Deriving the input per attempt
 * — `HMAC(challengeId, playerId, attemptNo)` — would fix that, at the cost of moving challenge
 * authoring out of the pack and into server code, since the server would then have to compute
 * the answer. This ships the shareable version deliberately: what bounds the damage is
 * physical rather than cryptographic, and the bounds are real. You must be inside the gym's
 * geofence when you start AND when you submit, the attempt carries a server-side deadline, one
 * submission ends it, and one attempt is open per account at a time. A `generatorId` field can
 * be added later without invalidating a single authored pack.
 */
import { z } from 'zod';

/**
 * How a challenge is answered.
 *
 * `PREDICT_OUTPUT` shows a snippet and asks what it prints. `MULTIPLE_CHOICE` shows options
 * and asks which is right. Both are judged identically — the difference is what the client
 * renders and how many cases are meaningful.
 */
export const CHALLENGE_KINDS = ['PREDICT_OUTPUT', 'MULTIPLE_CHOICE'] as const;
export const CHALLENGE_DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;

export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];
export type ChallengeDifficulty = (typeof CHALLENGE_DIFFICULTIES)[number];

/**
 * One case: an input the player is shown, and the digest of the answer they should give.
 *
 * `answer` is not optional-and-ignored, it is refused. An author writes plaintext in a working
 * file, runs `npm run gauntlet:hashes`, and pastes the digests here; a pack that still carries
 * the plaintext has skipped that step and would ship its answers to every browser.
 */
export const challengeCaseSchema = z
  .object({
    input: z.string().min(1).max(400),
    hash: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha256 hex digest from `npm run gauntlet:hashes`'),
  })
  .strict('a case may not carry a plaintext `answer`: the pack directory is served publicly, so an answer written here is a public download. Run `npm run gauntlet:hashes` and ship only `hash`.');

export const challengeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase, digits and dashes'),
    title: z.string().min(1).max(80),
    /** The snippet or question. Plain text — the client renders it in a `<pre>`, not as HTML. */
    prompt: z.string().min(1).max(4000),
    kind: z.enum(CHALLENGE_KINDS),
    difficulty: z.enum(CHALLENGE_DIFFICULTIES),
    choices: z.array(z.string().min(1).max(120)).min(2).max(6).optional(),
    cases: z.array(challengeCaseSchema).min(1).max(8),
    /**
     * What counts as the same answer. Applied identically when the digest is generated and
     * when a submission is judged, so a pack that turns one of these on after generating its
     * hashes invalidates them — which is why `gauntlet:hashes` reads these same fields.
     */
    normalise: z
      .object({
        trim: z.boolean().default(true),
        collapseWhitespace: z.boolean().default(true),
        caseInsensitive: z.boolean().default(false),
      })
      .default({}),
    /** Server-side deadline for an attempt. The client counts down from the server's clock. */
    timeLimitSeconds: z.number().int().min(30).max(1800).default(300),
    /** Karma for the win itself, paid through the existing `GYM` cap. */
    rewardKarma: z.number().int().nonnegative().max(500).default(0),
    /**
     * Control points the win is worth when spent on a capture. Bounded to the same range
     * `battleGymSchema` accepts for `power`, so a won gauntlet cannot express a battle the
     * ordinary route would refuse.
     */
    capturePower: z.number().int().min(10).max(500).default(250),
  })
  .superRefine((c, ctx) => {
    // A multiple-choice question with no options cannot be answered, and an output-prediction
    // question with options is a different question than the one the author wrote. Both boot
    // cleanly and fail only when a player walks to that gym, which is the invisible-dead-content
    // failure `quests.schema.ts` exists to prevent — same reasoning, same treatment.
    if (c.kind === 'MULTIPLE_CHOICE') {
      if (!c.choices) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'a MULTIPLE_CHOICE challenge must list its choices' });
      if (c.cases.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases'], message: 'a MULTIPLE_CHOICE challenge has exactly one case' });
    } else if (c.choices) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'only a MULTIPLE_CHOICE challenge carries choices' });
    }
  });

export const challengesSchema = z
  .object({
    _about: z.string().optional(),
    /**
     * Salt for this pack's answer digests. Any string; it is not a secret in the sense of
     * being unguessable, it is what stops one pack's digests being reusable against another
     * and stops an answer being read straight off the file. Change it and every hash in the
     * file must be regenerated, which is why `gauntlet:hashes` writes both together.
     */
    answerSalt: z.string().min(16).max(200),
    challenges: z.array(challengeSchema).min(1).max(200),
  })
  .superRefine((f, ctx) => {
    // A duplicate id would make two challenges share one identity: an attempt opened against
    // the first could be judged against the second's digests.
    const seen = new Set<string>();
    f.challenges.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['challenges', i, 'id'], message: `duplicate challenge id "${c.id}"` });
      seen.add(c.id);
    });
  });

export type ChallengeCase = z.infer<typeof challengeCaseSchema>;
export type Challenge = z.infer<typeof challengeSchema>;
export type ChallengesFile = z.infer<typeof challengesSchema>;
