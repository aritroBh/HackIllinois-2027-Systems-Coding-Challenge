/**
 * The service worker's precache list against the scripts the page actually loads.
 *
 * `sw.js` caches a fixed `SHELL` at install and, for anything else, falls through to the
 * network — so a script index.html loads but the shell does not list is a script that
 * simply is not there when the network is not there. The failure is quiet and looks like
 * success: the cached `index.html` renders, the missing modules fail at
 * `ERR_INTERNET_DISCONNECTED`, and the tabs they own come up as empty containers.
 *
 * That is exactly what happened when the dashboard was split into per-tab views: nine of
 * the scripts index.html loads were never added to the list, and the offline mode the PWA
 * gate tests for had been broken for as long as the split had existed. Nothing failed,
 * because nothing compared the two.
 *
 * Three assertions, in the order a reader would ask them:
 *   1. every script index.html loads is in SHELL or SHELL_OPTIONAL;
 *   2. every SHELL entry exists on disk (a missing one fails the install, and `sw.js` says
 *      so — the previous worker stays in charge and the new shell never lands);
 *   3. every SHELL entry is reachable under /dashboard, i.e. really is a file we serve;
 *   4. `VERSION` in sw.js was bumped if the *contents* of any precached file changed.
 *
 * The fourth is the one that cost real time. The shell is served **cache-first**, so an
 * installed worker keeps handing the page the JS it cached at install and only a `VERSION`
 * bump evicts it. sw.js's own comment said to bump "whenever the shell list or the caching
 * rules change" — which is not the rule. The rule is that a released byte change to any
 * precached file needs a bump, or returning users keep running the old code indefinitely,
 * including through a security fix. The list can be unchanged while every file in it is
 * different. `public/sw-shell.lock` records the pairing so this is checked rather than
 * remembered.
 *
 * Deliberately a text scan rather than an import: `sw.js` is a service worker and cannot be
 * loaded in Node, and the point is to compare what the two files *say*.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('public/index.html');
const sw = read('public/sw.js');

/**
 * Everything `index.html` pulls from `/dashboard/`, in load order, deduped.
 *
 * `src=` **and** `href=`. The first version matched only `src="…​.js"`, which is the exact
 * shape of the drift this gate exists to catch — nine scripts had gone missing from the
 * precache list — but one file type over: a stylesheet, a font or the manifest added to the
 * page and not to `SHELL` would have slipped past a checker written to catch exactly that
 * mistake. The extension filter is gone with it; whatever the page loads from `/dashboard/`
 * has to be precached or explicitly optional, whatever it is.
 */
const loaded = [
  ...new Set([...html.matchAll(/(?:src|href)="(\/dashboard\/[^"]+)"/g)].map((m) => m[1])),
];

/**
 * The entries of one array literal in sw.js, by the name it is declared under.
 *
 * Quoted strings and bare identifiers both, because `SHELL` opens with `INDEX` — a `const`
 * holding `'/dashboard/index.html'`. A string-only scan skipped it silently, so the two
 * existence assertions below never covered the one file the whole offline shell is for: the
 * page itself. An identifier that does not resolve to a string constant is an error rather
 * than a skip, since skipping is exactly the failure being fixed.
 */
function arrayOf(name) {
  const start = sw.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`checkShell: sw.js has no ${name}`);
  const end = sw.indexOf('];', start);
  const body = sw.slice(start + `const ${name} = [`.length, end);

  const out = [];
  for (const raw of body.split(',')) {
    // Strip comments and whitespace; an entry is then either a quoted path or an identifier.
    const item = raw.replace(/\/\/[^\n]*/g, '').trim();
    if (!item) continue;
    const quoted = item.match(/^'([^']+)'$/);
    if (quoted) { out.push(quoted[1]); continue; }
    if (/^[A-Z_][A-Z0-9_]*$/.test(item)) {
      const decl = sw.match(new RegExp(`const ${item}\\s*=\\s*'([^']+)'`));
      if (!decl) throw new Error(`checkShell: ${name} references ${item}, which is not a string constant in sw.js`);
      out.push(decl[1]);
      continue;
    }
    throw new Error(`checkShell: ${name} has an entry this scan cannot read: ${item}`);
  }
  return out;
}

const shell = arrayOf('SHELL');
const optional = arrayOf('SHELL_OPTIONAL');
const cached = new Set([...shell, ...optional]);

const problems = [];

for (const src of loaded) {
  if (!cached.has(src)) problems.push(`index.html loads ${src}, which sw.js neither precaches nor lists as optional`);
}

for (const entry of [...shell, ...optional]) {
  if (!entry.startsWith('/dashboard/')) {
    problems.push(`sw.js precaches ${entry}, which is not under /dashboard/`);
    continue;
  }
  const file = path.join(root, 'public', entry.slice('/dashboard/'.length));
  if (!fs.existsSync(file)) {
    problems.push(`sw.js precaches ${entry}, which does not exist at ${path.relative(root, file)}`);
  }
}

/*
 * Contents against VERSION.
 *
 * The hash covers every precached file plus the shell list itself, so a byte change anywhere
 * in the offline bundle moves it. `sw-shell.lock` holds the VERSION that hash was released
 * under; if the hash has moved and VERSION has not, the deploy would leave returning users on
 * the previous JS and this fails instead. Updating the lock is deliberate work: bump VERSION
 * in sw.js, then run `node scripts/checkShell.mjs --write-lock`.
 */
const versionMatch = sw.match(/const VERSION = '([^']+)'/);
if (!versionMatch) throw new Error('checkShell: sw.js has no VERSION constant');
const version = versionMatch[1];

const digest = crypto.createHash('sha256');
for (const entry of [...shell, ...optional].sort()) {
  digest.update(entry);
  const file = path.join(root, 'public', entry.slice('/dashboard/'.length));
  if (fs.existsSync(file)) digest.update(fs.readFileSync(file));
}
const shellHash = digest.digest('hex').slice(0, 16);
const lockPath = path.join(root, 'public/sw-shell.lock');

if (process.argv.includes('--write-lock')) {
  fs.writeFileSync(lockPath, `${version} ${shellHash}\n`);
  console.log(`checkShell: lock written — ${version} ${shellHash}`);
  process.exit(0);
}

if (!fs.existsSync(lockPath)) {
  problems.push('public/sw-shell.lock is missing; run `node scripts/checkShell.mjs --write-lock`');
} else {
  const [lockVersion, lockHash] = fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/);
  if (lockHash !== shellHash && lockVersion === version) {
    problems.push(
      `the precached shell changed but sw.js VERSION is still '${version}'. The shell is served ` +
      'cache-first, so returning users would keep the old bundle. Bump VERSION in public/sw.js, ' +
      'then run `node scripts/checkShell.mjs --write-lock`.'
    );
  } else if (lockHash !== shellHash) {
    problems.push(
      `VERSION moved to '${version}' but public/sw-shell.lock still records '${lockVersion}'. ` +
      'Run `node scripts/checkShell.mjs --write-lock`.'
    );
  }
}

if (problems.length) {
  console.error('checkShell: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `checkShell: OK — ${loaded.length} assets loaded, ${shell.length} precached, ` +
  `${optional.length} optional, shell ${version}/${shellHash}`
);
