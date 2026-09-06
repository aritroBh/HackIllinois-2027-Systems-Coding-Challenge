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
 *   3. every SHELL entry is reachable under /dashboard, i.e. really is a file we serve.
 *
 * Deliberately a text scan rather than an import: `sw.js` is a service worker and cannot be
 * loaded in Node, and the point is to compare what the two files *say*.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('public/index.html');
const sw = read('public/sw.js');

/** `src="/dashboard/…"` in load order, deduped. */
const loaded = [...new Set([...html.matchAll(/src="(\/dashboard\/[^"]+\.js)"/g)].map((m) => m[1]))];

/** The string entries of one array literal in sw.js, by the name it is declared under. */
function arrayOf(name) {
  const start = sw.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`checkShell: sw.js has no ${name}`);
  const end = sw.indexOf('];', start);
  const body = sw.slice(start, end);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
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

if (problems.length) {
  console.error('checkShell: FAIL');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`checkShell: OK — ${loaded.length} scripts loaded, ${shell.length} precached, ${optional.length} optional`);
