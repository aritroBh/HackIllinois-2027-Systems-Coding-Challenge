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
/**
 * A fourth check: a backticked identifier in a document that exists nowhere in the repository.
 *
 * The three checks above catch a link, a script or a path that has gone stale. They do not catch
 * the most common way documentation rots here, which is a *symbol* outliving the code: a comment
 * or a page that names a constant, a table or an exported function that has since been renamed or
 * deleted. `ARCHITECTURE.md` went on naming `HACKILLINOIS_VENUES` after that table was deleted and
 * replaced by a pack read, and every other gate in this repository stayed green — the paths all
 * resolved, the scripts all existed, the prose was simply about a thing that was no longer there.
 *
 * The pattern is deliberately narrow: SCREAMING_SNAKE_CASE with at least one underscore. That is
 * specific enough to be almost always a real symbol — an env var, an enum member, a constant, a
 * pack key — and it excludes the acronyms that would otherwise flood this (`GET`, `SSE`, `CSP`,
 * `UTC`, `JSON`), which carry no underscore. Measured against the current tree it reports zero,
 * with no false positives across all sixteen documents, which is the bar a gate has to clear
 * before it is worth having: one that cries wolf gets `|| true` appended to it.
 *
 * The haystack is every file a symbol could legitimately live in, including `content/` — pack
 * keys like `SIEBEL_ATRIUM` and faction ids like `TEAM_RED` are real identifiers that appear only
 * in JSON, and treating them as missing would be exactly the false alarm this avoids.
 *
 * **The convention this enforces: backticks mean the thing exists.** A document describing
 * something that was deleted — and several here usefully do, because knowing what a mechanism
 * used to be is often the point — names it in plain prose rather than in code formatting. That
 * is a small discipline and it is what makes this check possible at all: without it there is no
 * way to distinguish "this doc is stale" from "this doc is history".
 *
 * ## Why this is documents only, when the same rot is worse in source comments
 *
 * The obvious extension is to run the same needle over every comment in `src/`, `tests/`,
 * `scripts/` and `public/`. It is where the failure actually lives — the deleted-symbol
 * reference that motivated this check is itself in a `geo.ts` comment, which this gate cannot
 * see. It was measured rather than assumed, and the measurement says no: ten unresolved
 * identifiers, of which **one** was genuinely stale. The other nine fall into two groups that a
 * document essentially never produces and a source comment legitimately does.
 *
 * Six were named *precisely because nothing emits them* — comments in `views/quests.js`,
 * `views/lead.js`, `app.js` and `checkEvents.mjs` whose entire point is "this looks like an event
 * type and is not one". Under the convention above those backticks are wrong; in practice they
 * are what tells a reader the token is an identifier being discussed rather than an English word,
 * and removing them makes the comment worse. Two more cite things that are real but outside this
 * repository: a browser constant, and a fictional faction used as an example in another gate's
 * own docblock.
 *
 * So the rule would fire nine times out of ten on comments that are correct, which is how a gate
 * earns a `|| true` and stops being run at all. The asymmetry is the whole reason this works on
 * documents: a page of prose rarely needs to cite an external constant or hold up a
 * counter-example, and a comment sitting next to code often does. Recorded here with the numbers
 * so the next person to have this idea can skip the experiment — or bring a rule that separates
 * the categories, which nothing mechanical yet does.
 */
function missingIdentifiers(docFiles, root) {
  const haystack = [];
  const skip = /node_modules|[/\\]\.git|[/\\]dist|\.venv|osm[/\\]cache|campus[/\\]tiles/;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (skip.test(full)) continue;
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|mjs|js|json|sh|yml)$/.test(name)) continue;
      const body = fs.readFileSync(full, 'utf8');
      // Comments are stripped from source files before they count as evidence that a symbol
      // exists. Without this the gate cannot fire on the case it was built for: `geo.ts` still
      // *mentions* `HACKILLINOIS_VENUES` in the paragraph explaining that it was deleted, and a
      // plain substring search over the file therefore reports the symbol as alive. The first
      // version of this check did exactly that and stayed green against a planted control —
      // a gate that cannot fail for the input it exists to catch. JSON has no comments to strip
      // and is passed through, which is how pack keys like `SIEBEL_ATRIUM` stay findable.
      haystack.push(
        /\.json$/.test(name)
          ? body
          : body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
      );
    }
  };
  for (const dir of ['src', 'scripts', 'public', 'content', 'plugins', '.github']) walk(path.join(root, dir));
  for (const file of ['package.json', '.env.example']) {
    try { haystack.push(fs.readFileSync(path.join(root, file), 'utf8')); } catch { /* optional */ }
  }
  const hay = haystack.join('\n');

  const problems = [];
  for (const rel of docFiles) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of source.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)) {
      if (hay.includes(match[1])) continue;
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(`${rel}: names \`${match[1]}\` at line ${line}, which exists nowhere in the repository`);
    }
  }
  return problems;
}

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

problems.push(...missingIdentifiers(docs, root));

if (problems.length) {
  console.error('checkDocs: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`checkDocs: OK — ${docs.length} documents; links, npm scripts, repo paths and backticked identifiers all resolve`);
