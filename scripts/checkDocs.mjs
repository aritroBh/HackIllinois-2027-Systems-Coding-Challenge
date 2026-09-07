/**
 * The documentation against the repository it describes.
 *
 * Every other lockstep gate here (`checkShell`, `checkProps`, `checkEvents`) exists because two
 * things that must agree were only kept in agreement by someone remembering. The documentation
 * is the same problem with a worse failure mode: a broken gate is caught by the next engineer,
 * but a document that tells the reader to run a command that does not exist is caught by the
 * reader, at the moment they were trying to get started.
 *
 * Twelve review rounds have found a long list of these, and they were found by three external
 * models reading prose. The three checks below are the subset a machine can settle:
 *
 *   1. every relative markdown link resolves to a file that exists;
 *   2. every `npm run <script>` a document names exists in package.json;
 *   3. every repository path a document names in backticks exists on disk.
 *
 * The third is the loose one, so it is deliberately conservative: only strings that look
 * unambiguously like a path into this repository are checked (they contain a `/` and start with
 * a real top-level directory or end in a known source extension). A glob, a shell fragment or a
 * URL is skipped rather than guessed at. Being quiet about something it cannot judge is what
 * keeps this gate worth running; a checker that cries wolf gets `|| true` appended to it, and
 * `scripts/verify.sh` already learned that lesson the hard way.
 *
 * What this cannot check is whether a true-looking sentence is true. That is what the external
 * review rounds in `docs/REVIEWS.md` are for.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts));

/*
 * Every markdown file that is documentation rather than a log.
 *
 * `docs/REVIEWS.md` is excluded on purpose. It is a historical log: it names files as they were
 * at the time each round ran, including ones that have since been renamed or deleted, and
 * rewriting history to satisfy a path checker would destroy the thing that makes it useful.
 */
const docs = [
  'README.md',
  'ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  ...fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.md') && f !== 'REVIEWS.md')
    .map((f) => `docs/${f}`),
];

/**
 * Bases a documented path may be written relative to.
 *
 * Prose does not spell out a full path when the context makes it obvious: the frontend section
 * writes `views/lead.js`, and the content-pack reference writes `campus/index.json` for a file
 * inside whichever pack is being described. Both are clearer than the absolute form and both
 * are correct; a checker that demanded repository-root paths everywhere would be asking the
 * documentation to get worse so that the gate could stay simple.
 */
const BASES = [
  root,
  path.join(root, 'public'),
  ...fs.readdirSync(path.join(root, 'content'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, 'content', d.name)),
];

/**
 * Paths a document names *because* they do not exist, or does not expect to exist yet.
 *
 * `public/gl/uiuc-campus.json` is named by ARCHITECTURE.md §14.2 in the sentence explaining that
 * the single-file campus model was replaced by the tiled bake — the absence is the point.
 * `content/my-event/…` is the pack FORK_GUIDE walks the reader through creating, so it exists on
 * their disk and never on ours.
 */
const INTENTIONALLY_ABSENT = [
  /^public\/gl\/uiuc-campus\.json$/,
  /^content\/my-event(\/|$)/,
];

/** Top-level directories a backticked path may start with to be treated as a repo path. */
const REPO_DIRS = new Set(['src', 'docs', 'scripts', 'public', 'content', 'tests', 'design', 'plugins', '.github']);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|css|html|py|sh)$/;

const problems = [];

for (const rel of docs) {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  // 1. Relative markdown links.
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    if (target.startsWith('/')) continue; // site-absolute, not a repo path
    if (!fs.existsSync(path.resolve(dir, target))) {
      problems.push(`${rel}: link to ${target}, which does not exist`);
    }
  }

  // 2. npm scripts.
  for (const m of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
    if (!scripts.has(m[1])) {
      problems.push(`${rel}: says \`npm run ${m[1]}\`, which is not a script in package.json`);
    }
  }

  // 3. Backticked repository paths.
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (!raw.includes('/') || /[ *?<>|$(){}]/.test(raw) || raw.includes('://')) continue;
    const candidate = raw.replace(/^\.\//, '').split('#')[0].replace(/[.,;:]$/, '');
    const top = candidate.split('/')[0];
    const looksLikeRepoPath = REPO_DIRS.has(top) || SOURCE_EXT.test(candidate);
    if (!looksLikeRepoPath) continue;
    if (INTENTIONALLY_ABSENT.some((re) => re.test(candidate))) continue;
    // A directory reference may be written with a trailing slash.
    const trimmed = candidate.replace(/\/$/, '');
    if (BASES.some((base) => fs.existsSync(path.join(base, trimmed)))) continue;
    // `src/models/*.model.ts` style wildcards are skipped above; a `<pack>` placeholder is not
    // a path anybody can check, so treat an angle-bracketed segment as intentional.
    if (/[<>]/.test(candidate)) continue;
    problems.push(`${rel}: names \`${candidate}\`, which does not exist`);
  }
}

if (problems.length) {
  console.error('checkDocs: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`checkDocs: OK — ${docs.length} documents, links, npm scripts and repo paths all resolve`);
