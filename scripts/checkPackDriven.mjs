/**
 * `CONTRIBUTING.md`'s oldest house rule, made checkable.
 *
 *   "Nothing in `src/` names a building, a faction or a colour. Those live in a content pack."
 *
 * It was a sentence, and sentences drift. `src/common/utils/geo.ts` held a fifteen-building
 * gazetteer with coordinates and free-text hints — a byte-for-byte duplicate of
 * `venues.json` — and `src/seed/seedData.ts` built fourteen territories and twelve beacons
 * from its own literals while the pack's `territories.json` and `beacons.json` were parsed,
 * cross-validated, served to browsers and read by nobody. A fork could edit any of the three,
 * watch `npm run content:validate` pass, and get HackIllinois's campus anyway.
 *
 * The trick this gate uses is that it needs no list of its own. It loads the *active pack*, takes
 * the strings that are that event's content — venue keys and names, monument and territory and
 * beacon names, faction ids and labels, and every hex colour — and asserts that none of them
 * appears in `src/`. So it cannot fall behind the pack, and running it against a different pack
 * checks a different set of strings without an edit here. A pack whose venue is called "Main
 * Hall" would catch a hard-coded "Main Hall" in a service; nothing has to remember to add it.
 *
 * ## What it deliberately allows
 *
 * `NEUTRAL` is a protocol constant, not event content: `crossValidate` requires every pack to
 * declare a faction with that id, so `src/` may name it. Everything else is a finding.
 *
 * ## The two failure modes a gate like this has, and what is done about them
 *
 * **Scanning nothing and passing.** `checkShell.mjs` in this repository listed five source paths
 * by hand and was silent about every file outside them for months. So the file walk and the
 * needle list both have floors below which this exits non-zero: no files found, or no strings to
 * look for, is a broken scanner, not a clean repository.
 *
 * **False positives, which get a gate deleted.** A needle that is a common English word matches
 * prose everywhere and makes the gate worthless, so short and generic needles are dropped rather
 * than guessed at: fewer than five characters, or a single lowercase word with no separator. The
 * consequence is honest and worth stating — a pack whose faction is called "Red" is not
 * protected by this gate. Quiet about what it cannot judge is what keeps it worth running.
 *
 * Comments are stripped before matching. A comment naming a building is a documentation
 * question, and the fact-checking rounds in `docs/REVIEWS.md` are where that belongs; failing a
 * build over prose would make this gate the enemy of the comments the rest of this repository
 * has spent so long getting right.
 *
 *   usage: node scripts/checkPackDriven.mjs [pack-name]     (default: CONTENT_PACK or hackillinois-2027)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packName = process.argv[2] ?? process.env.CONTENT_PACK ?? 'hackillinois-2027';
const packDir = path.join(root, 'content', packName);

/** Ids that are part of the protocol every pack must speak, not content one pack chose. */
const PROTOCOL_IDS = new Set(['NEUTRAL']);

const readJson = (file) => {
  const full = path.join(packDir, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};

/**
 * Every string in the pack that names something specific to this event.
 *
 * Returned as `{ needle, source }` so a failure can say which pack file the offending string
 * came from — "Siebel Center for CS (venues.json)" is actionable in a way that the bare string
 * is not.
 */
function packNeedles() {
  const out = [];
  const add = (value, source) => {
    if (typeof value === 'string' && value.trim()) out.push({ needle: value.trim(), source });
  };

  const venues = readJson('venues.json') ?? {};
  for (const [key, venue] of Object.entries(venues)) {
    if (key.startsWith('_')) continue;
    add(key, 'venues.json');
    add(venue?.name, 'venues.json');
    for (const hint of venue?.hints ?? []) add(hint, 'venues.json');
  }
  for (const m of readJson('monuments.json')?.monuments ?? []) add(m?.name, 'monuments.json');
  for (const t of readJson('territories.json')?.territories ?? []) {
    add(t?.name, 'territories.json');
    add(t?.locationName, 'territories.json');
  }
  for (const b of readJson('beacons.json')?.beacons ?? []) {
    add(b?.id, 'beacons.json');
    add(b?.name, 'beacons.json');
    add(b?.where, 'beacons.json');
  }
  for (const f of readJson('factions.json')?.factions ?? []) {
    if (!PROTOCOL_IDS.has(f?.id)) {
      add(f?.id, 'factions.json');
      add(f?.label, 'factions.json');
      add(f?.short, 'factions.json');
    }
    add(f?.color, 'factions.json');
  }

  // Drop needles too generic to match meaningfully. See the file header: a gate that cries wolf
  // gets `|| true` appended to it.
  return out.filter(({ needle }) => needle.length >= 5 && /[^a-z]/.test(needle));
}

/** Every TypeScript file under `src/`. */
function sourceFiles(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Code with comments blanked, so prose naming a building is not a build failure.
 *
 * Blanked, not deleted, and the difference is the whole reason this is a function. Removing a
 * block comment removes its newlines with it, so every line below it shifts up and the gate
 * reports a real hit at a line number that does not contain it. The first run of this script did
 * exactly that: it pointed at `gym.model.ts:7`, which is inside the file header, for an enum
 * member on line 45. A gate that names the wrong line is the same defect as a gate that fires on
 * the wrong thing — the reader goes to look, sees nothing, and learns to distrust it.
 *
 * So a block comment becomes the newlines it contained and nothing else, and a line comment
 * becomes an empty remainder of its own line. Offsets are preserved exactly.
 */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_match, before) => before);
}

if (!fs.existsSync(packDir)) {
  console.error(`checkPackDriven: no pack at ${path.relative(root, packDir)}`);
  process.exit(1);
}

const needles = packNeedles();
const files = sourceFiles(path.join(root, 'src'));

// Floors. Either of these being low means the scanner broke, and a broken scanner that prints
// "clean" is worse than no scanner: it is a clean bill of health nobody earned.
if (files.length < 50) {
  console.error(`checkPackDriven: found only ${files.length} files under src/ — the walk is broken, not the tree`);
  process.exit(1);
}
if (needles.length < 20) {
  console.error(`checkPackDriven: extracted only ${needles.length} content strings from ${packName} — the pack reader is broken`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const lines = code(fs.readFileSync(file, 'utf8')).split('\n');
  for (const { needle, source } of needles) {
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) {
        hits.push({ file: path.relative(root, file), line: i + 1, needle, source });
      }
    }
  }
}

/*
 * The baseline, and why there is one rather than a clean pass or a pile of exemptions.
 *
 * Turning this rule on found twenty-six existing violations, and they are not one thing. Some
 * are functional and were fixed outright — the venue gazetteer, the territory and beacon
 * literals, the faction enum used as a validator. What is left is flavour and demo data: a
 * prestige rank whose *name* contains a building, an OpenAPI `example:` string, the HackIllinois
 * Adonix adapter's own fallback events, and the seed's demo shifts. Each needs a decision and
 * some need a data migration, so fixing them all before the rule could be enforced would have
 * meant not enforcing it.
 *
 * A baseline is not an exemption list. Three properties make the difference, and all three are
 * enforced below:
 *
 *   1. It is enumerated. Every entry names a file, a string and a reason, in a file a reviewer
 *      can read. There is no wildcard and no directory-level pass.
 *   2. It can only shrink. A new violation in a baselined file still fails — the entry covers
 *      one string in one file, not the file.
 *   3. It cannot rot. An entry that no longer matches anything is an error, not a silent pass,
 *      so fixing a violation *forces* the baseline to be updated in the same change. Without
 *      this the list would quietly become a description of a repository that no longer exists,
 *      which is how a gate stops meaning anything.
 */
const baselinePath = path.join(root, 'scripts', 'pack-driven-baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : [];
const keyOf = (entry) => `${entry.file} ${entry.needle}`;
const baselined = new Map(baseline.map((entry) => [keyOf(entry), entry]));

const fresh = hits.filter((hit) => !baselined.has(keyOf(hit)));
const matched = new Set(hits.map(keyOf));
const stale = baseline.filter((entry) => !matched.has(keyOf(entry)));

if (fresh.length || stale.length) {
  if (fresh.length) {
    console.error(
      `\ncheckPackDriven: ${fresh.length} NEW place(s) in src/ name content from the "${packName}" pack.\n` +
        'Read it from `pack` (src/content/loader.ts) instead — a fork editing its own pack must not\n' +
        'have to edit src/ as well. CONTRIBUTING.md, "House style".\n'
    );
    for (const hit of fresh) {
      console.error(`  ${hit.file}:${hit.line}  "${hit.needle}"  (from ${hit.source})`);
    }
  }
  if (stale.length) {
    console.error(
      `\ncheckPackDriven: ${stale.length} baseline entr(y/ies) no longer match anything.\n` +
        'Something was fixed — delete these from scripts/pack-driven-baseline.json in the same\n' +
        'change, so the list keeps describing this repository rather than a past one.\n'
    );
    for (const entry of stale) console.error(`  ${entry.file}  "${entry.needle}"`);
  }
  process.exit(1);
}

console.log(
  `checkPackDriven: OK — ${files.length} files under src/ against ${needles.length} content ` +
    `strings from the "${packName}" pack. ${hits.length} known violation(s) baselined, 0 new.`
);
