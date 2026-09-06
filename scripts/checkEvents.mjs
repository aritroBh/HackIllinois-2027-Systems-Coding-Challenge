/**
 * Every server event type must be forwarded to the client bus, every forwarded name must be
 * one the server actually emits, and every name a view subscribes to must be one of those.
 *
 * That is the emit -> forward -> subscribe chain, and it is what this checks. It does NOT
 * check that a forwarded event has a handler doing something useful, and it cannot see the
 * plugin hooks, whose names are built at runtime from the plugin's own name. A green run
 * means no name was invented on any hop; it does not mean every event is acted on.
 *
 * A view subscribes with `Nexus.onEvent('ANNOUNCEMENT')` and waits. If nothing forwards that
 * name, the view waits for ever and looks exactly like a view whose event has not happened
 * yet — no error, no warning, nothing in the console. That is how the announcement banner,
 * the later pips of the SOS bar and the quest board all sat inert while the server was
 * publishing correctly the whole time.
 *
 * The reverse is just as quiet: `SOS_TICKET_REASSIGNED` was forwarded for months and is not a
 * name the server has ever emitted — a reassignment publishes `SOS_TICKET_OPEN`, because
 * `transition` names its event after the status it moved to. The lead's queue simply did not
 * update when a ticket changed hands.
 *
 * Neither direction can be caught by a test that mocks the wire, which is why this reads the
 * two sources and compares them.
 *
 *   node scripts/checkEvents.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `type: 'X'` literal the server publishes, plus the templated SOS transitions. */
function serverTypes() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const src = fs.readFileSync(full, 'utf8');
      // `type: 'X'`, and also the ternary form the registration service uses, where the two
      // branches sit on their own lines under a bare `type:`.
      for (const m of src.matchAll(/type:\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) found.add(m[1]);
      // The ternary form: a `type:` key whose value is a conditional over two string
      // literals, as the registration service writes it. Anchored on `type:` immediately
      // followed by the conditional so that an unrelated ternary elsewhere in the file — a
      // status assignment, say — cannot be mistaken for an event name.
      for (const m of src.matchAll(/type:\s*\n?\s*[A-Za-z0-9_.]+\s*===?[^?]{0,80}\?\s*\n?\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\n?\s*:\s*\n?\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
        found.add(m[1]);
        found.add(m[2]);
      }
      // `SOSService.publish(ticket, 'SOS_TICKET_CREATED')`: a literal passed as an argument.
      // Anchored on the class so that `unpublish(doc, 'REJECTED')` — a status, not an event —
      // is not mistaken for one.
      for (const m of src.matchAll(/SOSService\.publish\([^,]+,\s*['"]([A-Z][A-Z0-9_]*)['"]\)/g)) found.add(m[1]);
      // `publish(updated, `SOS_TICKET_${to}`)` — the statuses come from the model's enum.
      if (/SOS_TICKET_\$\{/.test(src)) {
        const model = fs.readFileSync(path.join(ROOT, 'src/models/sosTicket.model.ts'), 'utf8');
        const block = model.slice(model.indexOf('enum SOSTicketStatus'), model.indexOf('}', model.indexOf('enum SOSTicketStatus')));
        for (const m of block.matchAll(/=\s*['"]([A-Z_]+)['"]/g)) found.add(`SOS_TICKET_${m[1]}`);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return found;
}

const server = serverTypes();
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const block = app.match(/const FORWARDED = \[(.*?)\];/s);
if (!block) {
  console.error('public/app.js no longer declares a FORWARDED list');
  process.exit(1);
}
const forwarded = new Set([...block[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]));

// Control frames are written by the hub itself rather than published by a service, and the
// client handles them on the EventSource directly.
const CONTROL = new Set(['CONNECTED', 'EVICTED', 'RESYNC', 'HEARTBEAT']);

const missing = [...server].filter((t) => !forwarded.has(t) && !CONTROL.has(t)).sort();
const orphan = [...forwarded].filter((t) => !server.has(t)).sort();

/**
 * And the other end: a view that subscribes to a name nobody publishes.
 *
 * Forwarding is only half the bridge. `views/quests.js` waited on `RAID_STARTED` and
 * `OBJECTIVE_UPDATED` — both plausible, neither ever emitted — so the quest board did not
 * move through a single raid window and looked exactly like a raid that had not started.
 * Subscriptions are scanned across every view rather than only the one that was wrong.
 */
const clientFiles = [];
for (const dir of ['public', 'public/views']) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) if (f.endsWith('.js')) clientFiles.push(path.join(dir, f));
}
const subscribed = new Map();
for (const file of clientFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  // Names inside a comment are prose, not code. Stripping them first stops a comment that
  // names a retired event from failing the build.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/onEvent\(\s*'([A-Z][A-Z0-9_]*)'/g)) subscribed.set(m[1], file);
  // The array-of-types form: `for (const type of [ 'A', 'B' ]) N.onEvent(type, ...)`.
  for (const list of code.matchAll(/for \(const \w+ of \[([^\]]*)\]\)\s*\{?\s*N?\.?onEvent/g)) {
    for (const m of list[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)) subscribed.set(m[1], file);
  }
}
const phantom = [...subscribed].filter(([t]) => !server.has(t) && !CONTROL.has(t)).sort();
if (phantom.length) {
  console.error(`subscribed by a view, never emitted by the server: ${phantom.map(([t, f]) => `${t} (${f})`).join(', ')}`);
}

if (missing.length) console.error(`emitted by the server, never forwarded to the views: ${missing.join(', ')}`);
if (orphan.length) console.error(`forwarded by the client, never emitted by the server: ${orphan.join(', ')}`);
if (missing.length || orphan.length || phantom.length) process.exit(1);

console.log(`event bridge: ${server.size} server type(s) forwarded, ${subscribed.size} view subscription(s), none invented on either side`);
