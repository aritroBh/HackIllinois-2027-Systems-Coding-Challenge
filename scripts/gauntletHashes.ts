/**
 * Turn a working file of plaintext answers into the pack file the server judges against.
 *
 *   npm run gauntlet:hashes -- hackillinois-2027
 *
 * Reads `design/challenges/<pack>.json` — which holds the answers in the clear and is NOT
 * shipped anywhere — and writes `content/<pack>/challenges.json`, which is, carrying only
 * digests. The split exists because `src/app.ts` serves the whole pack directory statically at
 * `/dashboard/content`: any answer written into `content/` is a public download, and
 * `challengeCaseSchema` is `.strict()` precisely so a forgotten plaintext `answer` field fails
 * validation instead of shipping.
 *
 * `design/` is deliberately the home for the source file. It is not copied into the Docker
 * image (see the `COPY` lines in `Dockerfile` — `content/` and `public/` are, `design/` is
 * not), which is exactly right: the running server never needs the plaintext, only the digests
 * that travel with the pack.
 *
 * The digests are produced by `GauntletService.hashFor`, imported rather than reimplemented.
 * A second copy of the hashing or the normalising rule here would be a second copy that drifts,
 * and the failure mode of that drift is every answer in a pack silently becoming wrong.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GauntletService } from '../src/services/gauntlet.service';
import { challengesSchema } from '../src/content/challenges.schema';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface SourceCase { input: string; answer: string }
interface SourceChallenge {
  id: string; title: string; prompt: string; kind: string; difficulty: string;
  choices?: string[]; cases: SourceCase[];
  normalise?: { trim?: boolean; collapseWhitespace?: boolean; caseInsensitive?: boolean };
  timeLimitSeconds?: number; rewardKarma?: number; capturePower?: number;
}
interface SourceFile { _about?: string; answerSalt: string; challenges: SourceChallenge[] }

const packName = process.argv[2] || process.env.CONTENT_PACK || 'hackillinois-2027';
const sourcePath = path.join(REPO_ROOT, 'design', 'challenges', `${packName}.json`);
const outPath = path.join(REPO_ROOT, 'content', packName, 'challenges.json');

if (!fs.existsSync(sourcePath)) {
  console.error(`No answer source at ${path.relative(REPO_ROOT, sourcePath)}`);
  process.exit(1);
}

const source: SourceFile = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
if (!source.answerSalt || source.answerSalt.length < 16) {
  console.error('answerSalt must be at least 16 characters. Generate one with `openssl rand -hex 16`.');
  process.exit(1);
}

const NORMALISE_DEFAULTS = { trim: true, collapseWhitespace: true, caseInsensitive: false };

const out = {
  _about:
    source._about ??
    'Coding challenges. A player must win one, standing inside the gym\'s geofence, to take that gym. '
    + 'Answers are stored ONLY as digests: this directory is served publicly at /dashboard/content, so a '
    + 'plaintext answer here would be a download. Edit design/challenges/<pack>.json and run '
    + '`npm run gauntlet:hashes -- <pack>` to regenerate; never hand-edit the hashes. Changing answerSalt, '
    + 'a challenge id, a case order or a normalise rule invalidates every digest below.',
  answerSalt: source.answerSalt,
  challenges: source.challenges.map((c) => {
    const rules = { ...NORMALISE_DEFAULTS, ...(c.normalise ?? {}) };
    const { cases, ...rest } = c;
    return {
      ...rest,
      normalise: rules,
      cases: cases.map((cs, i) => ({
        input: cs.input,
        hash: GauntletService.hashFor(c.id, i, cs.answer, rules, source.answerSalt),
      })),
    };
  }),
};

// Validate what we are about to write with the same schema the server loads it through, so a
// broken pack is refused here rather than at somebody else's boot.
const parsed = challengesSchema.safeParse(out);
if (!parsed.success) {
  console.error('Generated file does not satisfy challengesSchema:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const serialised = `${JSON.stringify(out, null, 2)}\n`;

/*
 * The text a player can actually read, with the digests removed.
 *
 * The leak check below searches THIS rather than the whole file, and the reason is a false
 * positive that fired on the first real run: a 64-character hex digest contains almost every
 * short numeric string, so an answer of "60" was reported as leaked because those two
 * characters happen to appear inside a hash. It fired a second time on `rewardKarma: 60`,
 * which is the same mistake one level down: a number in an unrelated numeric field is not a
 * leaked answer either. So this is the prose a player actually reads — title, prompt, choices
 * and case inputs — and nothing else. That is the real question: can a reader see the answer?
 */
const visible = out.challenges
  .flatMap((c) => [c.title, c.prompt, ...(c.choices ?? []), ...c.cases.map((cs) => cs.input)])
  .join('\u0000');

/*
 * Belt and braces against the one mistake that matters: no plaintext answer may survive into
 * the served file.
 *
 * MULTIPLE_CHOICE is deliberately exempt, and the distinction is the whole point of the check
 * rather than a hole in it. Its options have to be rendered, so the answer text is public by
 * construction and the secret is *which* of them is right — a digest over one of four visible
 * strings. For PREDICT_OUTPUT there is no such excuse: the answer appearing anywhere in the
 * output means it shipped. This check caught exactly that distinction the first time it ran,
 * on a choice that was also an answer.
 *
 * The MULTIPLE_CHOICE case gets the check it can actually pass instead: the answer must be one
 * of the options, or the question is unanswerable and would only be discovered by a player
 * standing at that gym.
 */
for (const c of source.challenges) {
  for (const cs of c.cases) {
    if (!cs.answer) continue;
    if (c.kind === 'MULTIPLE_CHOICE') {
      if (!c.choices?.includes(cs.answer)) {
        console.error(`Refusing to write: the answer ${JSON.stringify(cs.answer)} for "${c.id}" is not one of its choices, so no player could ever give it.`);
        process.exit(1);
      }
      continue;
    }
    if (cs.answer.length >= 2 && visible.includes(cs.answer)) {
      console.error(`Refusing to write: the answer ${JSON.stringify(cs.answer)} for "${c.id}" appears in the output.`);
      process.exit(1);
    }
  }
}

fs.writeFileSync(outPath, serialised);
console.log(`${path.relative(REPO_ROOT, outPath)} written — ${out.challenges.length} challenge(s), answers as digests only.`);
