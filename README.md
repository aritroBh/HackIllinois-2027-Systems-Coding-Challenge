# 🌊 WaveShift Nexus
### High-Performance Volunteer Scheduling & Operations Engine
**Built for the HackIllinois 2027 Systems Team Coding Challenge**  
*Architected directly to align with [HackIllinois Adonix](https://github.com/HackIllinois/adonix) conventions.*

---

## 🌟 Overview

During a massive 1,000+ attendee hackathon across the Siebel Center, ECEB, and Kenney Gym, volunteer operations face high-friction human and distributed systems challenges:
- **Peak Contention Overbooking:** 50 volunteers send simultaneous reservation requests for 2 prime sponsor/swag shifts.
- **Sudden Dropouts:** A volunteer cancels their 3:30 AM shift 20 minutes before it starts, leaving an area unmonitored.
- **Volunteer Fatigue & Overlap:** Volunteers double-book overlapping shifts or work 14 hours straight without rest.
- **Trade Liquidity Deadlocks:** Direct 1-to-1 trades fail because Alice wants Bob's shift, Bob wants Charlie's shift, and Charlie wants Alice's shift ($A \to B \to C \to A$).
- **Attendance Fraud:** Volunteers share static QR code screenshots over Discord to fake attendance.

**WaveShift Nexus** solves every one of these operational failure modes with mathematical invariants, database-level atomic primitives, and a real-time reactive War Room.

> [!TIP]
> **Detailed Engineering Specification & 12 System Diagrams**: See [ARCHITECTURE.md](file:///Users/aritro/Downloads/HackIllinois%202027%20Systems%20Coding%20Challenge/ARCHITECTURE.md) for full Mermaid topologies, ERDs, WiredTiger CAS sequence flows, Tarjan cycle discovery, and threat models.

---

## 🚀 Key Systems Innovations

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                   WAVESHIFT NEXUS                       │
                  └──────────────────────────┬──────────────────────────────┘
                                             │
      ┌──────────────────────────────────────┼──────────────────────────────────────┐
      ▼                                      ▼                                      ▼
[FORMAL SYSTEMS RIGOR]                [WAR-ROOM OPERATIONS]             [PERFORMANCE HACKER DX]
- Atomic CAS ($expr) Overbooking Guard - Dynamic Karma Surge Economy     - Tarjan Cycle Detection (3-Way Swaps)
- Exact-Once Idempotency Store        - Prestige Tiers (Midnight Kraken)- Chaos Monkey Concurrency Bomb
- 30-Min Rest Buffers & Fatigue Caps  - Pure Web Audio Synthesizer      - Offline HMAC-SHA256 Rotating QR
- Autonomous FIFO Waitlist Cascade    - Live SSE Floorplan Stream       - 0-Config In-Memory Mongo Replica Set
```

### 1. 🛡️ Atomic Concurrency Guard (Zero Overbooking Guarantee)
- Rather than naive read-then-write logic (`find()` followed by `save()`), reservations execute via an atomic conditional Compare-And-Swap (CAS) update directly on MongoDB's WiredTiger storage engine:
  ```typescript
  const updatedShift = await Shift.findOneAndUpdate(
    { _id: shiftId, $expr: { $lt: ['$filledSlots', '$capacity'] } },
    { $inc: { filledSlots: 1, version: 1 } },
    { new: true }
  );
  ```
- If the shift is saturated, the system overflows the applicant into an ordered FIFO waitlist with an atomically computed `waitlistPosition`.
- **Verified via automated stress test firing 50 concurrent requests against a 2-spot shift**: Exactly 2 confirmed, 48 waitlisted, 0 oversold.

### 2. 🌊 Autonomous FIFO Waitlist Cascade Engine
- When a confirmed volunteer cancels, the system automatically triggers an atomic cascade:
  1. Decrements `filledSlots`.
  2. Queries the head of the waitlist (`position = 1`).
  3. Verifies that the candidate has no schedule conflicts with their other confirmed shifts.
  4. Atomically transitions candidate to `CONFIRMED` and decrements `waitlistCount`.
  5. Re-indexes remaining waitlist positions monotonically ($1, 2, \dots, n$) to preserve queue contiguity.
  6. Broadcasts real-time SSE notifications to the live dashboard.

### 3. ⏱️ Anti-Burnout Rest Buffers & 8-Hour Daily Fatigue Limit
- **30-Minute Rest Buffer:** Enforces that consecutive shifts must have at least 30 minutes of rest time between them ($[S_A, E_A) \cap [S_B - 30\text{m}, E_B + 30\text{m}) = \emptyset$).
- **Daily Fatigue Cap:** Enforces a maximum threshold of 8.0 cumulative volunteer hours per calendar day.

### 4. 🔄 Directed Graph Cycle Detection for Multi-Party Swaps (Tarjan)
- Direct 1-to-1 trades fail in over 90% of hackathon logistics situations.
- WaveShift constructs a directed trade graph $G=(V, E)$ where edge $u \to v$ indicates Volunteer $u$ desires the shift held by Volunteer $v$.
- Uses **Tarjan's cycle discovery with canonical minimum-vertex rotation hashing** to discover 2-way, 3-way, and 4-way circular trade rings ($A \to B \to C \to A$) and executes the trade rotation atomically.

### 5. 📱 Anti-Fraud Dynamic HMAC-SHA256 QR Check-In
- Dynamic QR code containing time-sliced HMAC-SHA256 tokens that rotate every 30 seconds:
  $$\text{Token} = \text{Base64Url}(\text{version}:\text{volunteerId}:\text{shiftId}:\text{timeSlice}:\text{nonce}) \mathbin{\Vert} '.' \mathbin{\Vert} \text{Hex}(\text{HMAC})$$
- Sliding window evaluation ($\pm 30\text{s}$) compensates for phone clock drift.
- In-memory replay-nonce cache mathematically blocks token reuse or screenshot sharing.

### 6. ⚡ Dynamic Karma Surge Pricing Economy
- Volunteer compensation dynamically recalibrates based on event stress:
  $$\text{Karma}(S) = \text{round}\Big( B_{\text{role}} \times M_{\text{surge}}(t, S) \Big)$$
  $$M_{\text{surge}} = \min\Big(5.0,\, M_{\text{circadian}}(t) \times M_{\text{scarcity}}(S) \times M_{\text{urgency}}(t, S)\Big)$$
- **Circadian Curve:** Peaks at 3:30 AM ($2.50\times$) to incentivize unglamorous late-night shifts (e.g. Siebel Basement Trash Run).
- **Prestige Tiers:** *Neophyte Plankton* $\to$ *Current Rider* $\to$ *Abyssal Vanguard* $\to$ *Siebel Guardian* $\to$ *Midnight Kraken* $\to$ *Leviathan Prime*.

---

## ⚡ Zero-Setup Quickstart

No MongoDB installation or Docker setup is required! WaveShift Nexus includes an embedded **In-Memory MongoDB Replica Set** (`mongodb-memory-server`) that boots automatically.

### 1. Installation
```bash
git clone https://github.com/aritroBh/HackIllinois-2027-Systems-Coding-Challenge.git
cd "HackIllinois 2027 Systems Coding Challenge"
npm install
```

### 2. Run the demo (one command)
```bash
npm run demo
```

This is the command you want. It boots one in-memory replica set, seeds it, and serves the war room
against **that same database** — so the dashboard comes up populated.

> [!IMPORTANT]
> Do not use `npm run seed && npm run dev` for the demo. Each of those commands calls
> `connectDatabase()` independently, so with no `MONGODB_URI` set they each spin up their **own**
> ephemeral replica set. The seed populates a database that is destroyed when the seed process
> exits, and the server then starts against an empty one. The dashboard renders, but every panel is
> blank. `npm run demo` (`scripts/devSeeded.ts`) exists precisely to share one instance.
>
> The two-step flow is still correct when you point both at a real database:
> ```bash
> export MONGODB_URI="mongodb://localhost:27017/waveshift"
> npm run seed && npm run dev
> ```

### 3. Run the automated test suite
```bash
npm test
```
*9 suites / 43 tests, all in-memory: the 50-worker concurrency bomb, 30-minute rest-buffer checks,
waitlist cascades, 3-way circular trade resolution, dynamic HMAC QR validation, 75 m geodesic
geofence enforcement, nearest-neighbour SOS dispatch, PokéShift OCC battles, and the 10-system
master simulation.*

Coverage is measured with `npm run test:coverage`. The suite covers the service and invariant layer
thoroughly; it does **not** exercise the browser dashboard, the production build, or the container —
see [Known gaps](#-known-gaps--verification-status).

Visit the services in your browser:
- 🎛️ **Live War-Room Console:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- 📖 **Interactive Swagger UI:** [http://localhost:3000/docs](http://localhost:3000/docs)
- 📡 **Health Check:** [http://localhost:3000/health](http://localhost:3000/health)

---

## 🎬 3-Minute Interview Live Demo Script

When demonstrating WaveShift Nexus during your interview:

1. **The Hook (0:00 - 0:45)**:
   - Open `http://localhost:3000/dashboard`.
   - Explain the hackathon operations problem: *3:30 AM at Siebel Center, volunteers ghosting, static spreadsheets failing, and race conditions during high-demand shifts.*
2. **Shift Radar & Surge Multipliers (0:45 - 1:30)**:
   - Point to the live cards with dynamic capacity wave meters and required certifications (`DRIVERS_LICENSE`, `FOOD_HANDLING`).
   - Highlight the **03:30 AM Siebel Emergency Cleanup** shift with a live **3.5× Surge Multiplier** and **770 Karma** reward.
3. **The Concurrency Bomb (1:30 - 2:15)**:
   - Switch to the **Chaos Lab** tab.
   - Click **Fire 50-worker bomb**.
   - Show the live benchmark terminal: 50 requests launched in parallel into a 2-slot shift $\to$ **Exactly 2 confirmed, 48 waitlisted, 0 oversold**.
4. **The Automatic Waitlist Cascade (2:15 - 2:45)**:
   - Click **Drop & waitlist cascade**.
   - Watch the Web Audio cascade chime trigger and observe the waitlist candidate instantly promoted to confirmed over live SSE.
5. **Tarjan 3-Way Trade & Dynamic QR Scan (2:45 - 3:00)**:
   - Click **Resolve 3-way trade** to watch Alice, Bob, and Charlie rotate shifts in an atomic transaction.
   - Switch to the **Trainer** tab to show the 30s rotating HMAC token, then click **Simulate desk scan** followed by **Test replay** to prove anti-fraud replay rejection.

---

### 7. 🗺️ Spatial Geofencing & Haversine Distance Engine
- **Sub-Millimeter Geodesic Metric:** Calculates great-circle Haversine distances across Siebel Center, ECEB, Kenney Gym, and DCL ($R = 6,371,000\text{m}$) with clamping to prevent precision underflow.
- **75-Meter Check-In Geofence:** Protects against remote or proxy check-in fraud by enforcing that dynamic QR attendance verification must occur within a 75-meter boundary of the shift's designated campus venue.

### 8. 🚨 Hacker SOS Emergency Dispatch Engine
- **Hacker Distress Beacons:** Hackers at hardware tables or auditoriums create emergency tickets with urgency levels (`LOW` $\to$ `CRITICAL`) and categories (e.g. `HARDWARE_MALFUNCTION`, `POWER_OUTAGE`, `SPILL_CLEANUP`).
- **Spatial Nearest-Neighbor Dispatch:** Algorithms filter on-duty checked-in volunteers by required skill certification, calculate Haversine distance to the distress location, and dispatch the closest volunteer with estimated walking ETAs.
- **Volunteer Karma Bounties:** Resolving SOS incidents awards volunteers immediate Karma points and unlocks the exclusive `FIRST_RESPONDER` prestige badge.

### 9. 🔄 Official HackIllinois Adonix API Synchronization
- **Live Event Ingestion Client:** Integrates with official HackIllinois backend (`https://adonix.hackillinois.org/event/`) to ingest real-time hackathon schedules.
- **Volunteer Shift Synthesis:** Maps event categories, durations, and sponsor requirements directly into volunteer shift capacities and base karma allocations using idempotent `$setOnInsert` upserts.

### 10. 🎮 PokéShift // UIUC Campus Turf Wars & HackStop Engine
- **Fourteen Campus Monuments as Territory:** Alma Mater, Foellinger Auditorium, Altgeld Hall, the Illini Union, the Main Library, Memorial Stadium, the State Farm Center, Krannert, Siebel, ECEB, Grainger, DCL, Kenney Gym and Beckman are all contestable strongholds. **Team Kernel** (cyan), **Team Tensor** (violet) and **Team Silicon** (amber) clash for campus dominion.
- **Atomic CAS Gym Combat ($I_{\text{gym}}$):** Concurrency-safe optimistic locking (`{ _id, version }`) allowing allies to fortify control points (up to 2,000 CP) and rival factions to attack. When defense reaches 0, the Gym is captured and flies the conquering faction's banner.
- **Geofenced HackStops ($I_{\text{cd}}$):** Twelve supply beacons spread across campus — the Alma Mater plaza, Altgeld's steps, Foellinger's portico, the Stadium tunnel and more — requiring volunteers to be within 75 meters. Enforces a 5-minute sliding cooldown and rolls for rare drops.
- **Power-Up Vault & Consumables ($I_{\text{inv}}$):** Collect and deploy rare hackathon power-ups (**Cold Brew Elixir of Haste**, **Insomnia S'mores Cookie Shield**, **Overclocked Solder Core**, **Rubber Duck of Debugging Omniscience**, and **The Forbidden 100W Anker Gauntlet**).
- **Live 3D Campus Map:** A hand-written WebGL2 renderer draws the real UIUC campus from **899 OpenStreetMap building footprints** with OSM height data, the street network and the Quad lawns. Monuments wear their holding faction's colour, on-duty volunteers orbit the building they are working, and open distress calls plant a pulsing cone at their true coordinates. See [ARCHITECTURE §14](ARCHITECTURE.md#14-nexus-os-war-room-the-webgl-campus-renderer).

---

### 11. 🎮 Nexus Quest (the retro game layer)
- **Pixel-game UI**, chosen from three OpenPencil directions (`design/exports/{gameboy,snes,neoretro}/`): quest board, trainer card, sticker book, SNES-style gym encounters, a duck mascot with opinions.
- **Your sprite on the real campus.** WASD or *Walk with me* (real GPS) moves a pixel avatar across the OSM-built UIUC; stand within 75 m of a HackStop to spin it, open a gym to fight. Spins and battles send *your* position, so the server's geofence is the authority.
- **That's you.** Webcam or photo → 32×32 pixel avatar (three palettes, dither) → walk-cycle sprite the map wears. `/dashboard/avatar-demo.html`.
- **Memorabilia.** 16 HackIllinois collectibles as 16×16 pixel art (Alma Mater pin, Boneyard duck, the 3:30 AM cleanup patch…) plus a badge per monument held.
- **RETRO toggle** pixelates and posterises the 3D so it sits inside the pixel UI; **Cinematic** goes edge-to-edge.

### 12. 🗺️ The 3D Campus Renderer
- **Zero dependencies.** The dashboard's CSP allows only `'self'` scripts, so a CDN three.js build is blocked. `public/gl/glx.js` is a ~450-line WebGL2 layer (matrices, VAOs, half-float targets, ear-clipping triangulation, static batching) and `public/gl/campus3d.js` is the scene.
- **Real geography.** `design/build-campus.py` bakes cached Overpass extracts into a 247 KB model: projection to a metric frame centred on the Main Quad, Douglas-Peucker simplification, heights from OSM `building:levels`, and name-then-proximity resolution of the fourteen monuments.
- **Verified coordinates.** Cross-checking `HACKILLINOIS_VENUES` against OSM centroids while building the map corrected several venue positions (Kenney Gym was ~450 m off), so geofencing and the map now agree.
- **Three-pass HDR pipeline.** Scene → soft-knee bright pass → 3× separable Gaussian bloom → ACES composite with chromatic aberration, scanlines, vignette and grain.
- **One draw call for the city.** All 899 ambient footprints are merged into a single interleaved static mesh; only the monuments are dynamic, because only they change colour.
- **Analytic LOD.** Procedural window lights fade out via `fwidth()` once a cell drops below a pixel, so the city reads as solid mass zoomed out and as lit facades zoomed in — no aliasing shimmer.
- **Surveyed detail.** 2,343 individually mapped trees, 63 street lamps, Boneyard Creek, the rail line, parking pads and fountains from a third OSM extract — the elm rows on the Quad are real positions.
- **Reference-driven materials.** Ten Commons photographs of the monuments were read into `design/refs/MATERIALS.md`; `public/gl/materials.js` turns that into 22 procedural surfaces (brick coursing, limestone ashlar, verdigris domes, slate, terracotta tile, glass) with the same `fwidth()` LOD, so Foellinger is red brick under a ribbed green dome and Altgeld is grey stone under a red tile spire. Official brand palette verified against brand.illinois.edu.
- **Hero viewport.** The campus is full-width with a live telemetry strip and a cinematic mode (Escape exits); clicking a landmark opens a dossier — Altgeld's 15-bell chime tower, the Stadium's 200 memorial columns — from `public/gl/monuments-info.json`.

**Rebuilding the campus model** (only needed if you refresh the OSM cache):

```bash
python3 design/build-campus.py     # design/osm/*.json → public/gl/uiuc-campus.json
```

---

## 📊 Automated Test Coverage Matrix

| Test Suite | Focus Area | Assertions | Status |
| :--- | :--- | :--- | :---: |
| `masterEndToEnd.test.ts` | 10-System Integration Simulation | Unmocked full lifecycle: Adonix sync, concurrency bomb, QR check-in, cascade, cyclic swaps, SOS dispatch, gym capture, beacon spin, inventory CAS | ✅ PASS |
| `concurrency.test.ts` | High-Contention Race Conditions | 50 simultaneous parallel requests hitting 2 slots $\to$ 0 overselling | ✅ PASS |
| `registration.test.ts` | Scheduling Invariants & Fatigue | 30-min buffer conflict rejection + 8h daily cap + idempotency replay | ✅ PASS |
| `waitlist.test.ts` | Autonomous FIFO Cascade | Confirmed volunteer drop $\to$ Head of waitlist promoted automatically | ✅ PASS |
| `swaps.test.ts` | P2P & Multi-Party Trades | Bilateral atomic swap + Tarjan 3-way circular trade resolution | ✅ PASS |
| `checkin.test.ts` | Dynamic QR Security | HMAC token verification + clock drift tolerance + replay rejection | ✅ PASS |
| `shifts.test.ts` | Catalog & Surge Pricing | Zod time ordering validation + Circadian/Scarcity surge math | ✅ PASS |
| `geoSos.test.ts` | Spatial Geofence & SOS Dispatch | Haversine distance + 75m geofence rejection + nearest SOS dispatch + Adonix sync | ✅ PASS |
| `pokestop.test.ts` | PokéShift Gyms & HackStops | 75m beacon geofence + 5-min cooldown + ally fortify + gym capture + inventory CAS | ✅ PASS |



---

## 🏛️ Architecture & Adonix Alignment

This project mirrors the production architecture of HackIllinois's core backend **[Adonix](https://github.com/HackIllinois/adonix)**:
- **Layered Clean Architecture**: Strict decoupling of Routers $\to$ Controllers $\to$ Services $\to$ Models.
- **Strict TypeScript 5+**: `noImplicitAny: true`, `strictNullChecks: true`, branded types for identifiers, and zero `any` shortcuts.
- **Contract-First Validation**: All request bodies, query params, path parameters, and headers are validated at the gateway using **Zod**.
- **Unified Error Envelope**: Centralized `errorHandler` producing standardized JSON responses (`{ success: false, error: CODE, message: string }`).
- **Real-Time Push**: Built-in Server-Sent Events (SSE) hub with 15-second heartbeat keep-alives and channel multiplexing.
- **Pure Web Audio Engine**: Zero MP3 asset dependencies; all audio cues are synthesized directly in the browser using the Web Audio API.

---

## 🔒 Production Hardening Flags

The demo ships open (no auth, optional GPS) so the dashboard works with zero
setup. For real operations, set these in your environment:

| Variable | Default | Effect when enabled |
| :--- | :---: | :--- |
| `REQUIRE_GEOFENCE=true` | `false` | Defense-in-depth: gym battles additionally reject requests without GPS coordinates. (Attendance verification always requires coordinates — no flag needed.) |
| `REQUIRE_AUTH=true` + `ORGANIZER_SECRET=<strong-secret>` | `false` | All mutating API routes (`POST`/`PATCH`/`PUT`/`DELETE`) require the secret in the `X-Organizer-Secret` header (constant-time comparison). Reads stay open for the live dashboard. |

### Capacity and socket tuning

These have working defaults; they exist because the right value depends on the deployment,
and a wrong one is the kind of thing that only shows up under load.

| Variable | Default | What it controls |
| :--- | :---: | :--- |
| `RATE_LIMIT_MAX` | `300` | Requests per IP per window. Budget per *open dashboard*, not per person: one war-room load issues well over a dozen calls and then holds an SSE stream. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | The window. The 429 body quotes this value, so the two cannot drift apart. |
| `TRUST_PROXY_HOPS` | `0` | Proxy hops to trust for client-IP resolution. Left at `0` behind a load balancer, every client collapses into one bucket and the whole event shares a single allowance. Set it to the real hop count — trusting every proxy instead lets a client forge `X-Forwarded-For` and evade the limit outright. |
| `REQUEST_TIMEOUT_MS` | `30000` | How long one request may occupy a connection. |
| `HEADERS_TIMEOUT_MS` | `15000` | How long to wait for a complete header block. This and the one below are the slowloris bounds. |
| `KEEP_ALIVE_TIMEOUT_MS` | `10000` | Idle keep-alive lifetime. **Raise this behind a proxy.** AWS ALB, GCP LB and nginx all idle at 60 s upstream; if this process closes a socket the proxy still thinks is reusable, users get a 502. Behind a 60 s proxy use `65000` here and `70000` for headers. The invariant `REQUEST > HEADERS > KEEP_ALIVE` must hold, and the process warns at boot if it does not. |

Related invariant fixes in this release: per-volunteer reservation locks (rest-buffer/fatigue TOCTOU), single-round-trip idempotency claims, atomic bilateral-swap transactions, all-or-nothing cyclic rotations with per-leg existence checks, owner-proof cancel/checkout/resolve, DB-backed QR replay rejection (`CheckIn.nonce` unique), mandatory check-in geofence with fail-closed venue resolution (free-text locations map to the right building), ephemeral per-boot HMAC secret outside production (production refuses the committed default), gym faction locks + battle-karma cooldowns, pro-rata checkout karma, atomic HackStop cooldown claims, escaped dashboard rendering + CSP, and generic 500 messages.

## 🔎 Known gaps & verification status

Engineering judgement is easier to assess when the gaps are stated rather than found. This section
records what has been verified, how, and what is still open. Full detail lives in
`scripts/benchmarks/`, including re-runnable harnesses (`loadtest.ts`, `sse-fanout.ts`, `fuzz.ts`).

**Verified under load and attack**

| Property | Method | Result |
| :--- | :--- | :--- |
| No overbooking | 5,000 concurrent claimants against 1,000 seats | exactly 1,000 confirmed, 0 oversold, 0 counter drift |
| Waitlist ordering | same run, 50 shifts audited | positions unique and contiguous |
| Idempotency | 6 concurrent identical keys | 1 registration, 1×201, 5×409 |
| SSE fan-out | 1,000 live streams, 200-mutation burst | 100% delivery, 0 missed, p99 34 ms |
| Input validation | 1,586 hostile payloads across all 28 routes | 0 × 5xx from any shaped payload |
| QR drift window | boundary probe at ±1 slice | exactly ±30 s, rollover race covered, replay rejected |
| DB outage | real replica set paused and stopped | reconnect immediate on restore |

**Fixed in this pass** (each re-verified against a running server, not just the diff)

| Was | Now | Evidence |
| :--- | :--- | :--- |
| Inline `onclick` handlers inert under Helmet's `script-src-attr 'none'`, so 5 of 6 tabs were unreachable | All 33 shell controls routed through the delegated `data-action` map; no inline handler remains anywhere in `public/` | All 6 tabs switch on a real click; concurrency bomb and QR scan fire |
| ObjectId casing split identity across the lock, cooldown, idempotency hash and ownership checks | Normalised at the validation boundary via `objectId()` (`src/schemas/common.ts`), plus defence-in-depth at each key site | Cooldown bypass 9/12 → **1/12** spins, karma farmed 1317 → **87**; concurrent lock split 201/201 → **201/409** — 1/12 is the *correct* outcome, not a leftover hole: the first spin is legitimate and the other eleven are the casing variants, now all correctly rejected as one volunteer on cooldown |
| Rate limit hardcoded 300/min, raisable only under an env that never starts a server | `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` / `TRUST_PROXY_HOPS` | `RATE_LIMIT_MAX=1200` → `RateLimit-Limit: 1200` |
| Malformed JSON returned 500 and logged a stack trace per request | Typed `entity.parse.failed` branch → 400 | `{"error":"BAD_REQUEST","statusCode":400}` |
| No readiness signal; `/health` stayed 200 during a database outage | Added `/ready`, which reports connection state and returns 503 when not connected | `/ready` → `{"status":"READY","database":"connected"}` |
| No request/header timeouts (slowloris) | `requestTimeout` 30 s, `headersTimeout` 15 s, `keepAliveTimeout` 10 s — now configurable, with a boot-time warning if the ordering invariant is violated | set on both entry points |
| `script-src` still carried `'unsafe-inline'` after the delegation migration, so the policy permitted what the code no longer needed | Extracted the last two inline scripts (`avatar-demo`, `gl/materials-demo`) to files; policy is now a bare `script-src 'self'` | Header reads `script-src 'self'`; dashboard loads and the concurrency bomb runs with zero CSP violations |
| Ownership checks compared a caller string against a lowercase `.toString()`, and the self-swap guards used raw `===` | All six routed through `sameId()` (`src/common/utils/id.ts`) | Ownership checks fail closed on a casing mismatch; the self-swap guard no longer fails **open** to one volunteer spelled two ways |
| `?status=SWAP_PENDING` returned 400 for a status the model can hold | Added the missing enum member | `?status=SWAP_PENDING` → 200, `?status=BOGUS` → 400 |
| OpenAPI drifted three ways: `/adonix/events` documented but unrouted, `/volunteers` routed but undocumented, `/health` and `/ready` missing | Removed the phantom, documented the rest with a per-path `servers` override for the root probes | `/docs` lists `/volunteers`, `/volunteers/{id}`, `/health`, `/ready`; no `/adonix/events` |
| Cancelling a confirmed registration freed the seat *before* the waitlist cascade refilled it, so a reservation arriving in that window could take a seat the promotion then took as well | The seat is held across the cascade and released only when nobody is promoted, making a promotion a transfer rather than a release and re-acquire | `tests/concurrency.test.ts` races the two. On the old ordering it reports **3 confirmed on a 2-seat shift**; on the new ordering, 2 |
| The power-up control-point boost read the gym, computed `min(max, cp + 250)` in Node, and wrote it back — a lost update, and the one gym path that was not atomic | Rewritten as an aggregation-pipeline update so `$add` and `$min` evaluate against the document's own value | Concurrent boosts now compose instead of overwriting; the shield write bumps `version` so battle CAS re-reads |
| `sameId` stringified whatever it was given, so a populated Mongoose document compared as a field dump rather than an identity | Unwraps `_id`, rejects anything that is not a 24-hex id | 43/43 tests green, including the swap IDOR checks that exercise it |
| CSP omitted `blob:` from `img-src` while the avatar builder loads user files through `createObjectURL` | Added the scheme | The upload fallback path is no longer blocked silently |
| Six doc claims were confidently wrong — the `filledSlots` and WAITLISTED invariants, the `REQUIRE_GEOFENCE` scope, the SSE rate-limit cost, a `<symbol>` pointer to markup that does not exist, and a log line described as being above the code that logs it | Each rewritten against what the code does | See the commit; every claim re-read against its own source |

**Still open, in priority order**

1. **Certifications are self-declared**, so the skill gate documents intent rather than enforcing it.
   Until an organiser issues them, a volunteer can claim `DRIVERS_LICENSE` at signup.
2. **Identity is caller-asserted.** Ownership checks compare a client-supplied `volunteerId`; they
   are correct comparisons on an untrusted input. Binding to a real session is the next step.
3. **No compression**; the campus JSON ships 347 KB uncompressed (≈101 KB gzipped).
4. **Check-in has no shift time-window check**, so a token can be redeemed far outside the shift.
5. **`updateShift` runs no cascade**, so raising capacity strands an existing waitlist.
6. **Checkout karma is capped at one hour, not scaled to the shift.** The factor is
   `min(1, minutesServed / 60)`, so an hour of a four-hour shift pays the same as all four.
   It is an anti-farming rule inherited from an earlier flat 0.5x floor, and scaling against
   each shift's scheduled duration would be more honest — but it moves the karma economy for
   every existing record, so it is listed rather than changed quietly.

## 🐳 Docker Deployment

```bash
docker-compose up --build
```
The application will be accessible at `http://localhost:3000`.

> [!WARNING]
> **Two things must be true for this to work, and one of them is not yet.**
>
> 1. **`tsconfig.build.json` must be present in the build context.** `npm run build` is
>    `tsc -p tsconfig.build.json`, but the `Dockerfile` currently copies only `tsconfig.json`, and
>    `tsconfig.build.json` is untracked by git. In a fresh clone the image build fails with
>    `TS5058: The specified path does not exist: 'tsconfig.build.json'`. Track the file and add it to
>    the `COPY` line. CI does not catch this because the workflow runs `lint` and `test` but never
>    `npm run build`.
> 2. **Mongo must run as a replica set.** Bilateral and cyclic swaps execute inside
>    `session.withTransaction(...)`, and MongoDB only supports multi-document transactions on a
>    replica set. The `mongo:7.0` service in `docker-compose.yml` starts standalone, so swap
>    execution will fail against it. Start it with `--replSet rs0` and initiate once.

---

## 📜 License & Acknowledgements

Developed for the **HackIllinois 2027 Systems Team Coding Challenge**.  
Licensed under the MIT License.
