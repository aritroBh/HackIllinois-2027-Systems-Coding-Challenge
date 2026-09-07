# Extending Nexus Quest

You want to add something. This says where it goes, what it costs you, and what will stop you.

The seams are listed in order of blast radius: the first changes no code and cannot break the
event, the last is a change to the core that everybody inherits. **Work down this list and stop
at the first thing that fits.** If you find yourself editing a service to add a feature, come
back and check you have not walked past a seam.

| # | Seam | You edit | Restart needed | Can break the event |
|---|---|---|---|---|
| 1 | [Content pack](#1-the-content-pack) | `content/<pack>/*.json` | yes | no — a bad pack refuses to boot |
| 2 | [Client registry](#2-the-client-registry) | one file under `public/` | no | one tab, not the server |
| 3 | [Server plugin](#3-a-server-plugin) | `plugins/<name>/` | yes | itself only; five failures disable it |
| 4 | [Identity adapter](#4-an-identity-adapter) | one file in `src/auth/` + 3 lines | yes | sign-in |
| 5 | [Scheduled job](#5-a-scheduled-job) | `src/scheduler.ts` | yes | the background loop |
| 6 | [Domain event](#6-a-new-domain-event) | the bus + one service | yes | the operation that emits it |

---

## 1. The content pack

**Everything specific to one event lives in `content/<pack>/`, and nothing in `src/` names a
building, a faction or a colour.** That is not aspirational any more —
`scripts/checkPackDriven.mjs` reads the active pack, takes every string that is that event's
content, and fails the build if any of them appears in `src/`. It runs in `scripts/verify.sh`.

It was aspirational until recently, and the failure is worth knowing about because it is the
shape of thing this whole document exists to prevent. `src/common/utils/geo.ts` held a
fifteen-building gazetteer — coordinates and free-text hints — that was a byte-for-byte
duplicate of `venues.json`. The pack's copy was what the client rendered; the copy in `src/` was
what the check-in geofence measured against. So a fork that edited `venues.json`, exactly as the
fork guide told it to, moved the pin on the map and not the geofence, and its volunteers were
refused at the right desk. `territories.json` and `beacons.json` were worse: parsed,
cross-validated, served to browsers, and read by nobody, while the seed built the game world
from its own literals. `territories.json`'s own `_about` said "Read by `src/seed/seedData.ts`".
It was not.

### What a pack controls

| File | What it decides |
|---|---|
| `event.json` | Name, timezone, HQ venue, karma caps per source, bounty ceilings, active plugins |
| `venues.json` | Every place a shift or a geofence can refer to: key, name, coordinates, free-text hints |
| `factions.json` | The sides, their ids, labels, colours and HQ venues |
| `territories.json` | The starting state of the map: which gyms exist, where, held by whom |
| `beacons.json` | The HackStops people spin |
| `loot.json` | The spin table: karma band and item weights |
| `monuments.json` | Landmarks the 3D pipeline gives hand-authored silhouettes |
| `quests.json`, `raids.json`, `booths.json`, `memorabilia.json` | The game layer's content |

`docs/CONTENT-PACKS.md` documents every field.

### What checks you

`npm run content:validate` and, again, the server at boot. A pack that does not validate does
not start the process — deliberately, because a typo in a venue key is a geofence anchored to
the wrong building and it should fail loudly at boot rather than quietly at three in the
morning.

`crossValidate` (`src/content/schema.ts`) is the interesting half: it checks *between* files. A
territory naming a venue that `venues.json` does not declare, a faction that `factions.json`
does not declare, or a monument the bake does not contain; a beacon id used twice; a karma
source the pack has not priced. That last one exists because the cap lookup fails **open** — an
unpriced source mints without a ceiling — so an omission is a boot failure rather than an
unlimited economy nobody notices.

### Timezone

`event.json`'s `timezone` is a real setting, not decoration. Karma ledger day keys, quest
windows and the surge curve all read it. The circadian surge bonus — the thing that makes the
3 a.m. shift pay — peaks at 03:30 in *your* timezone.

### The honest gaps

Two things a pack does not yet control, both listed because you will hit them:

- **Demo shifts.** The six shifts `npm run seed` creates are literals in `src/seed/seedData.ts`
  and name HackIllinois buildings. There is no shift schema in a pack yet. Territories, beacons,
  venues and loot all come from the pack; shifts do not.
- **Power-up definitions.** `loot.json` chooses the odds; `POWER_UP_CATALOG` in
  `src/models/powerup.model.ts` chooses what each item is called and what it pays. That split is
  deliberate — a pack is public, served to every browser under `/dashboard/content`, and
  `karmaBonus` is money — but it means adding an item is a code change and not a pack change. A
  pack naming an item the catalogue does not price refuses to boot.

Both are recorded in `scripts/pack-driven-baseline.json` with the reasoning.

---

## 2. The client registry

Adding a tab, a HUD widget or a button needs no server change at all. The shell exposes a small
registry on `window.Nexus`, and a browser script uses it and nothing else:

```js
Nexus.registerTab({ id, label, roles, order, render, onShow, onHide, badge });
Nexus.registerAction(name, handler);            // claims data-action="<name>"
Nexus.registerHudWidget({ id, corner, render, tick });   // tick is throttled to 2 Hz
Nexus.registerSticker(item);
Nexus.registerItemRenderer(kind, fn);
Nexus.onEvent(channel, fn);                     // ops | sos | game | presence | announce | me
```

`roles` decides who sees a tab, and a tab the current role cannot see is never put in the DOM.
`registerAction` returns the previous handler, so an override can chain rather than clobber.

### What checks you

`scripts/checkShell.mjs`. It globs `public/views/*.js` and `plugins/*/public/*.js`, parses every
`registerTab({…})` call by brace matching, and cross-checks the result against `index.html`'s
fallback nav and against `sw.js`'s precache list. It also enforces a core tab count, so deleting
a tab is a deliberate act.

Two things to know before you add a tab:

- The fallback-nav requirement applies to **core** tabs only. A plugin's tab is scanned but is
  not required to appear in `index.html`, because `index.html` ships before anybody decides
  which plugins are installed.
- A plugin reusing a core tab id is a named error rather than a silent overwrite.

### The rules

No build step, no inline handlers, no external origins: these are plain browser scripts served
under `script-src 'self'`. Escape everything you inject into HTML — a script here runs with the
page's full privileges. `npm run csp:audit` checks the first part; the second is on you.

---

## 3. A server plugin

Use this when you need server behaviour — to react to something happening, to add an endpoint,
or to ship a tab with a backend behind it.

A plugin is a plain object, not a package. Copy `plugins/hello-nexus/`, which does one of each
thing a plugin can do and nothing else:

```
plugins/<your-name>/
  index.ts          exports a ServerPlugin
  public/*.js       browser scripts, served at /dashboard/plugins/<your-name>/
```

Three steps to turn it on:

1. Export a `ServerPlugin` from your plugin's `index.ts`.
2. Add it to `CATALOG` in `src/plugins/registry.ts`.
3. Name it in your pack's `event.json` under `plugins`.

Step 2 is a core edit and it is deliberate: `CATALOG` is a literal array of static imports, so
`tsc` type-checks every plugin with the rest of the codebase and there is no dynamic `require`
anywhere in the loader. A plugin that breaks the contract fails `npm run lint` rather than the
event.

Step 3 used to be a lie. `docs/PLUGINS.md` said activation came from the pack's `plugins` array;
that array was parsed by the schema and read by nobody, and activation came only from a
`PLUGINS` environment variable that nothing in the repository ever set. A fork could follow the
documentation exactly and get no plugin, no error and no warning.

### What a plugin may do

**Hooks** react to a domain event *after* it has been committed. They cannot veto the operation,
cannot change its result, and are never awaited by the caller:

| Hook | Fires when |
|---|---|
| `onCheckIn` | attendance is verified, in either direction |
| `onRegistration` | somebody takes a shift or goes on its waitlist |
| `onSOSResolved` | a distress ticket reaches `RESOLVED` |
| `onGymCaptured` | a territory changes faction |
| `onSpin` | a HackStop spin pays out |

**Routes** mount at `/api/v1/plugins/<name>` and inherit the whole API stack — identity, rate
limiting, CSRF, the JSON error contract.

**Client assets** are served at `/dashboard/plugins/<name>/`, listed in `GET /api/v1/plugins`
with the SHA-256 of each file as it was on disk at boot, and loaded with `integrity=`.

### What bounds you

A hook that throws or takes longer than two seconds fails that hook only. Five *consecutive*
failures disable the plugin and broadcast `PLUGIN_DISABLED`; one success resets the count. A
disabled plugin's routes and assets both answer 404 — Express cannot unmount a router at
runtime, so everything sits behind a guard rather than being removed.

Be honest about what the timeout buys: it stops the registry waiting, it does not cancel your
work. A hook that opens a socket and never closes it still leaks.

### What a plugin cannot do

It gets a namespaced logger, a way to broadcast, and a way to ask whether it is still enabled.
It does not get the Express app, the Mongoose connection, or the event hub. `broadcast` prefixes
your type with `PLUGIN_<NAME>_`, so a plugin cannot forge a core event.

**A plugin is first-party code.** It lives in this repository, it is reviewed the way core code
is reviewed, and it runs in-process with the same database handles as everything else. There is
no sandbox, no marketplace, and no way to point the server at a URL. If you have not read it, do
not enable it.

---

## 4. An identity adapter

A fourth way to sign in is one file in `src/auth/` plus four small edits: a login method on
`AuthService`, an entry in `providers()`, a route, **and a new member of `IdentityProvider` in
`src/models/volunteer.model.ts`** — the union and the Mongoose `enum` beside it.

That fourth one is easy to miss and fails late: the adapter works, the session mints, and the
linked identity is rejected by schema validation when it is written, so the new login path cannot
persist. This page said "three" until a reviewer counted; `README.md` and the model's own guide
have both said four. All three ways in — badge claim code,
magic link, HackIllinois SSO — mint the same signed session, carried only in an HttpOnly cookie
with a CSRF nonce echoed on every mutation.

`docs/IDENTITY.md` has the shape and the runbook. The rule that matters: an adapter proves an
identity and then hands over; it never becomes a second kind of session.

---

## 5. A scheduled job

Anything that must happen on a clock goes in `src/scheduler.ts` rather than starting its own
`setInterval` somewhere in a service — one timer is easy to stop in tests and on shutdown, and
one file makes it obvious how much background work the process is doing.

```ts
registerJob({ name: 'my-sweep', everyMs: 30_000, run: async () => { … } });
```

Write it idempotent. The event runs one instance by decision, so there is no leader election,
and a second instance should duplicate work rather than corrupt it. A job that throws is logged
and retried on the next tick; it never takes the timer down.

`registerJob` is exported for exactly this and currently has no caller — the three shipped jobs
are in the array literal. It is neither idempotent nor keyed on `name`, so calling it twice
registers two jobs.

---

## 6. A new domain event

`domainEvents` is the inward-facing bus: it lets one part of the server react to another without
importing it. Check-in has no business knowing a sticker book exists, so it emits
`checkin.completed` and the reward rules subscribe.

Adding one means editing `DomainEventMap`, emitting it from the service that owns the change,
and — if plugins should see it — adapting it into a hook in `src/plugins/registry.ts`.

**Emit it from the same change that declares it.** `registration.cancelled` sat in the map with
a full payload type and no emitter for a long time, and because `emit` returns early when a name
has no listeners, anybody who subscribed got silence rather than an error. A declared event with
no emitter is a promise the bus cannot keep.

Listeners run on `setImmediate`, so the request that emitted has already been answered. A
listener that throws is logged and goes no further. Delivery is best-effort and confined to one
process: nothing survives a restart, nothing crosses instances. Anything that must not be lost
belongs in the database write that produced the event, not in a listener.

---

## Before you open a pull request

```sh
npm run lint            # tsc --noEmit
npm test
npm run content:validate
npm run pack:check      # src/ names nothing the pack owns
scripts/verify.sh       # everything above, plus the lockstep gates
```

`CONTRIBUTING.md` has the house style. Two rules from it are worth repeating here because this
repository has been bitten by both, repeatedly:

**A comment is a claim.** Every sentence you write next to code is something a reader will
believe. In one commit here, seven separate sentences were false and every one of them would
have been believed. Before you write "this is the only caller", grep for the others.

**A guard is only a guard if you can say what makes it fire.** Five checks in this repository
have read a value that could not take the failing state. The test is simple: delete the guard
and watch something go red. If nothing does, the guard was a comment wearing an `if`.
