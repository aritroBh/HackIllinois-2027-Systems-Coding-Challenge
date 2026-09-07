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
 * The manifest's icons, which nothing checked.
 *
 * `manifest.webmanifest` named `/dashboard/icon-192.png` and `/dashboard/icon-512.png` for a
 * long time while `public/` contained no `.png` at all, so installing the app to a home
 * screen failed on its icons and no gate noticed. The loop above only walks what `sw.js`
 * precaches and the one above that only walks `src=`/`href=` in `index.html`; a manifest icon
 * is referenced from neither, which is exactly why it could rot unobserved.
 *
 * Declared size is checked against the PNG's real IHDR dimensions, not just existence — a
 * 512 named as a 192 installs a blurry icon and is the kind of thing nobody re-measures.
 */
const manifestRaw = read('public/manifest.webmanifest');
let manifest = null;
try { manifest = JSON.parse(manifestRaw); } catch (err) { problems.push(`manifest.webmanifest is not valid JSON: ${err.message}`); }
for (const icon of manifest?.icons ?? []) {
  const src = String(icon.src || '');
  if (!src.startsWith('/dashboard/')) { problems.push(`manifest icon ${src || '(missing src)'} is not under /dashboard/`); continue; }
  const file = path.join(root, 'public', src.slice('/dashboard/'.length));
  if (!fs.existsSync(file)) { problems.push(`manifest declares icon ${src}, which does not exist at ${path.relative(root, file)}`); continue; }
  const buf = fs.readFileSync(file);
  // PNG IHDR: 8-byte signature, 4-byte length, "IHDR", then width and height as big-endian u32.
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) { problems.push(`manifest icon ${src} is not a PNG`); continue; }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const declared = String(icon.sizes || '');
  if (declared && declared !== `${w}x${h}`) problems.push(`manifest icon ${src} declares ${declared} but the file is ${w}x${h}`);
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

/*
 * The pre-script fallback nav against the tab registry.
 *
 * `nexus.js` replaces the nav from `registerTab()` as soon as it runs, so the buttons in
 * index.html only ever show in the gap before scripts execute or with JavaScript off. That
 * makes drift invisible in every normal load, and it drifted: three tabs behind the registry,
 * still listing a tab that had been removed, and marking the wrong one active.
 *
 * The registry is the source of truth, so this checks the direction that matters — every
 * fallback button must name a tab that is actually registered, and every tab open to *every*
 * role must have a fallback button. Role-gated tabs are deliberately absent: there is no
 * session yet when this markup renders.
 */
{
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const navBlock = html.match(/<div class="inner" role="tablist">([\s\S]*?)<\/div>/);
  if (!navBlock) {
    problems.push('index.html has no role="tablist" fallback nav');
  } else {
    const fallback = [...navBlock[1].matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);

    /*
     * Every registerTab() call across the front end, with the roles it declares.
     *
     * The call bodies are brace-matched rather than bounded by a character count. A lazy
     * `[\s\S]{0,400}?` was tried first and was quietly wrong: `views/sos.js` puts an
     * `addEventListener(…)` inside its `render`, so the first `})` is an inner one about 550
     * characters in, and the pattern matched **nothing at all** in that file. `tab-sos` was
     * invisible to this gate, and the "did the scan work" count below still saw nine hits
     * from the other files and stayed quiet — a gate that could not fail for one tab.
     *
     * Comments are stripped first, so a commented-out call cannot register a phantom tab.
     */
    const registered = new Map();
    /**
     * Every file that can register a tab, discovered rather than listed.
     *
     * This was a hard-coded list of five paths, and everything outside it was invisible to
     * the gate — which is worse than it sounds, because adding `public/views/<name>.js` is
     * exactly what CONTRIBUTING.md and docs/PLUGINS.md tell a contributor to do. Their tab
     * went unscanned, so the role-gating check this whole block exists to perform silently
     * did not run on it; and if they also added it to index.html's fallback nav, the loop
     * below reported `no registerTab() call declares "tab-x"` — a false statement about
     * their code that was really a true statement about this scanner's reading list. A
     * contributor's first meeting with this repository's gates would have been a lie.
     *
     * Plugin client assets have the same shape one directory over, so they are globbed too.
     * The same drift, in `scripts/verify.sh`'s frontend-syntax step, had left it nine files
     * behind before it was globbed for this reason.
     */
    /**
     * A `registerTab(...)` whose argument is not an inline object literal.
     *
     * Both scans key on `registerTab(\s*{`, so `const conf = {...}; registerTab(conf);`
     * matched neither and the tab was invisible to every per-tab check while `coreTabs`
     * stayed satisfied by the others. Same shape as the unreadable-id hole: the scanner
     * cannot read it, so it must say so rather than pass.
     */
    const reportIndirectRegistrations = (rel, src) => {
      // `\s*` inside the lookahead, not outside it. Outside, the engine backtracks `\s*` to
      // empty on `registerTab( {`, the lookahead then examines the space rather than the
      // brace, succeeds, and a perfectly valid registration is reported as unreadable.
      for (const m of src.matchAll(/registerTab\s*\((?!\s*\{)/g)) {
        const shown = src.slice(m.index, m.index + 60).split('\n')[0];
        problems.push(
          `${rel} calls registerTab() with something other than an inline object literal `
          + `(\`${shown.trim()}…\`). checkShell cannot read a tab declared that way.`,
        );
      }
    };

    const listJs = (rel) => {
      try {
        return fs.readdirSync(path.join(root, rel))
          .filter((name) => name.endsWith('.js'))
          .map((name) => `${rel}/${name}`);
      } catch {
        return [];   // the directory need not exist; a repo with no plugins is not a fault
      }
    };
    const pluginDirs = (() => {
      try {
        return fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => `plugins/${e.name}/public`);
      } catch {
        return [];
      }
    })();
    const TAB_SOURCES = ['public/app.js', ...listJs('public/views'), ...pluginDirs.flatMap(listJs)];
    /** The `{...}` object literal starting at `from`, by brace depth, ignoring quoted braces. */
    const objectAt = (src, from) => {
      let depth = 0, quote = null;
      for (let i = from; i < src.length; i += 1) {
        const c = src[i];
        if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return src.slice(from, i + 1); }
      }
      return null;
    };
    for (const rel of TAB_SOURCES) {
      const raw = fs.readFileSync(path.join(root, rel), 'utf8');
      // Line comments anywhere, not only at the start of a line. Start-anchored, a trailing
      // `registerTab( // note` survived the strip and the indirect-registration scan then
      // reported a valid call as unreadable. The `[^:]` guard keeps a `https://` in a string
      // from being mistaken for the start of a comment.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      reportIndirectRegistrations(rel, src);
      for (const m of src.matchAll(/registerTab\s*\(\s*\{/g)) {
        const body = objectAt(src, m.index + m[0].length - 1);
        if (!body) { problems.push(`checkShell: unbalanced registerTab({ in ${rel}`); continue; }
        // `id:` is a string literal in app.js and a module constant in the view files.
        let id = body.match(/id:\s*'([^']+)'/)?.[1];
        if (!id) {
          const ref = body.match(/id:\s*([A-Za-z_$][\w$]*)/)?.[1];
          if (ref) id = src.match(new RegExp(`const\\s+${ref}\\s*=\\s*'([^']+)'`))?.[1];
        }
        if (!id) {
          // Not `continue`. The id patterns accept a single-quoted literal or a module
          // constant; a double-quoted one, or a computed id, matched neither and was skipped
          // in silence — invisible to every per-tab check while `coreTabs` stayed at the
          // expected number, so the `!==` gate stayed green over a tab nothing had examined.
          // A scanner that cannot read something must say so, not pass.
          problems.push(
            `checkShell found a registerTab({...}) in ${rel} whose id it could not read. `
            + "Ids must be a single-quoted literal or a module constant assigned one.",
          );
          continue;
        }
        const roles = body.match(/roles:\s*([A-Za-z_]+|\[[^\]]*\])/)?.[1] ?? null;
        // Last write wins in a Map, and the plugin files are scanned last. A plugin reusing a
        // core tab's id would therefore flip that entry to non-core and silently drop the
        // fallback-nav requirement the core tab is subject to — turning this gate off for one
        // tab by adding a file, which is the failure this whole block exists to prevent.
        const clash = registered.get(id);
        if (clash) {
          // Not `clash.rel !== rel`. That enforced "unique across files" while the message
          // said "unique", so two `registerTab({ id: 'tab-x' })` calls in one file — the
          // likeliest way to get a duplicate, by copying the one above — last-won in silence
          // with the roles taken from the second and the count unchanged.
          problems.push(clash.rel === rel
            ? `tab id "${id}" is registered twice in ${rel}; ids must be unique`
            : `tab id "${id}" is registered by both ${clash.rel} and ${rel}; ids must be unique`);
        }
        registered.set(id, { roles, rel });
      }
    }
    /**
     * A tab shipped by this repository, as opposed to one a plugin adds.
     *
     * The distinction did not exist while `TAB_SOURCES` was five hard-coded core paths. Now
     * that plugins are scanned it matters twice: an installed plugin must not be able to
     * satisfy the floor below for a core tab somebody deleted, and it must not be required
     * to appear in `index.html` (see the fallback rule further down).
     */
    const isCore = (rel) => rel.startsWith('public/');
    const coreTabs = [...registered.values()].filter((t) => isCore(t.rel)).length;

    /**
     * Every core tab this repository has, as an equality rather than a floor.
     *
     * This was `< 8` while the static count was 10, and the comment beside it claimed to be
     * "the real total rather than a floor low enough to hide one". It was neither: two core
     * tabs could be deleted with the gate still green, which is exactly the shape of the
     * `sos.js` miss it was written to close. A one-sided floor cannot catch a deletion when
     * it is set below the true count, and nothing kept the number honest.
     *
     * `!==` costs a contributor one line when they add a tab, and the message says which line.
     * That is the trade a lockstep gate is for: the alternative is a number that drifts under
     * the count it is supposed to be guarding, which is what happened here.
     *
     * Ten: six in `app.js` (shifts, campus, pokeshift, qr, chaos, leaderboard — `chaos` is
     * registered conditionally at runtime but is a static call site, and this is a static
     * scan), plus one each in `views/me.js`, `views/lead.js`, `views/quests.js`,
     * `views/sos.js`.
     */
    const EXPECTED_TABS = 10;
    if (coreTabs !== EXPECTED_TABS) {
      problems.push(
        `checkShell found ${coreTabs} core registerTab() calls across ${TAB_SOURCES.length} scanned files ` +
        `but EXPECTED_TABS is ${EXPECTED_TABS}. If you added or removed a tab on purpose, update ` +
        `EXPECTED_TABS in scripts/checkShell.mjs to ${coreTabs}. Otherwise the scanner no longer ` +
        'matches how registerTab() is written, or a tab was lost.'
      );
    }

    for (const id of fallback) {
      if (!registered.has(id)) {
        problems.push(`index.html's fallback nav lists "${id}", which no registerTab() call declares`);
      }
    }
    /*
     * "Open to every role" is a property of the role set, not of how it was spelled.
     *
     * `app.js` writes `roles: EVERYONE`; `views/me.js` and `views/quests.js` write the same
     * five roles out as an array literal. Matching only the identifier meant those two counted
     * as gated, so deleting their fallback buttons would have passed this gate silently — the
     * exact drift it was added to catch.
     */
    const ALL_ROLES = ['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN', 'HACKER'];
    const openToEveryone = (roles) => {
      if (roles === null || roles === 'EVERYONE') return true;   // no `roles` key means everyone
      if (!roles.startsWith('[')) return false;                  // some other named constant
      const listed = [...roles.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return ALL_ROLES.every((r) => listed.includes(r));
    };
    for (const [id, { roles, rel }] of registered) {
      // Core tabs only. `index.html` is a static file that ships before anyone decides which
      // plugins are installed, so it cannot carry a button for a tab that may not exist —
      // requiring one would make the gate fail on a correct plugin, which is the same
      // "true statement about the scanner reported as a fault in your code" that the
      // hard-coded source list used to produce. Plugin tabs are still scanned and still
      // answer the check above: put one in the fallback nav and it must really be declared.
      if (!isCore(rel)) continue;
      if (openToEveryone(roles) && !fallback.includes(id)) {
        problems.push(`tab "${id}" is open to every role but has no button in index.html's fallback nav`);
      }
    }
    /*
     * Order.
     *
     * `index.html` tells the reader this markup is kept in step with the registry, and order
     * is half of what "in step" means — a fallback that lists the same tabs in a different
     * sequence still jumps under the reader when nexus.js re-renders. `orderedTabs()` sorts on
     * `order` and breaks ties on `label` (nexus.js), so that is reproduced here.
     */
    const seq = [...registered.entries()]
      .filter(([id]) => fallback.includes(id))
      .map(([id]) => id);
    // Sorting needs the order and label, which the scan above did not keep. Re-read them.
    const meta = new Map();
    for (const rel of TAB_SOURCES) {
      // Same strip as the first scan. This kept the start-anchored form after that one was
      // widened, so a trailing `//` inside a `registerTab` body corrupted the `order:` and
      // `label:` parse here while the id parse two hundred lines up handled it correctly —
      // one scanner, two answers to the same input.
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const m of src.matchAll(/registerTab\s*\(\s*\{/g)) {
        const body = objectAt(src, m.index + m[0].length - 1);
        if (!body) continue;
        let id = body.match(/id:\s*'([^']+)'/)?.[1];
        if (!id) {
          const ref = body.match(/id:\s*([A-Za-z_$][\w$]*)/)?.[1];
          if (ref) id = src.match(new RegExp(`const\\s+${ref}\\s*=\\s*'([^']+)'`))?.[1];
        }
        // Same policy as the first scan, which is the point: this loop kept the old silent
        // `continue` after that one learned to complain, so one scanner had two answers to the
        // same limitation. It changes no verdict today — loop one already reports the file —
        // but a reader comparing them would have to work out which behaviour was intended.
        if (!id) continue;   // already reported by the first scan; not silent, just not twice
        meta.set(id, {
          order: Number(body.match(/order:\s*(\d+)/)?.[1] ?? 100),
          label: body.match(/label:\s*'([^']+)'/)?.[1] ?? id,
        });
      }
    }
    const expected = [...seq].sort((a, b) =>
      (meta.get(a).order - meta.get(b).order) || meta.get(a).label.localeCompare(meta.get(b).label));
    if (expected.join(',') !== fallback.join(',')) {
      problems.push(
        `index.html's fallback nav is in the order [${fallback.join(', ')}] but the registry ` +
        `sorts these as [${expected.join(', ')}]`
      );
    }

    // The fallback marks one tab active; it must be one it actually lists, and it must be the
    // one the registry would open first.
    const active = navBlock[1].match(/class="pb tab-btn active"[\s\S]*?data-tab="([^"]+)"/)?.[1];
    if (!active) problems.push('index.html\'s fallback nav marks no tab active');
    else if (!fallback.includes(active)) problems.push(`the fallback nav marks "${active}" active but does not list it`);
    else if (active !== expected[0]) problems.push(`the fallback nav marks "${active}" active, but "${expected[0]}" sorts first`);
    // ...and carry the ARIA the live render carries, since this is what an early screen
    // reader gets.
    for (const attr of ['role="tab"', 'aria-selected', 'aria-controls']) {
      const n = (navBlock[1].match(new RegExp(attr.replace('=', '='), 'g')) || []).length;
      if (n < fallback.length) problems.push(`only ${n} of ${fallback.length} fallback nav buttons carry ${attr}`);
    }
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
