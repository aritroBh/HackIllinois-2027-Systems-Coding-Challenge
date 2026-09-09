# HackIllinois 2027

A volunteer operations system for a large hackathon, with the campus it runs on rendered as a game world.

A thousand people are on a campus for thirty-six hours. Some are staffing shifts, most are building things, and a few need help right now. This is the software that schedules the first group, keeps the second entertained, and gets someone to the third quickly. The scheduling half is ordinary distributed-systems work done carefully. The game half exists because a volunteer who is enjoying themselves turns up for the 3:30 a.m. cleanup shift.

Almost everything specific to HackIllinois and to the University of Illinois lives in a content pack: point the software at your own pack and it runs your event on your campus. That is enforced rather than intended: `npm run pack:check` loads the active pack, takes every string that is your event's content, and fails the build if any of it appears in `src/`. Two exceptions used to be listed here — the faction ids and a second copy of the venue gazetteer, so a fork moving a venue moved the map pin and not the geofence — and both are closed.

```sh
npm install
npm run demo          # http://localhost:3000/dashboard/
```

No configuration, no Docker, no secrets. That command starts an in-memory single-node replica set, seeds it, serves the dashboard against the same database, and signs the browser in.

That is the intended way to see this running, including at an interview: it needs no network, has no cold start, and the parts worth showing — the fifty-way registration race, the three-way trade ring, the campus map — all work. To put it on a URL instead, `render.yaml` is a one-click Render Blueprint and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has the free path, including why this needs a container host rather than a serverless one.

## What is actually here

**Scheduling that holds under contention.** Fifty simultaneous requests for two slots produce exactly two confirmed registrations and forty-eight waitlist places, every time, because the check and the increment are one atomic operation rather than a read followed by a write. The same discipline covers cancellations, the waitlist cascade that promotes the next person, three-way swap rings resolved by cycle detection, rest buffers between shifts, and daily fatigue caps. `npm run demo` ships a Chaos Lab — at `/dashboard/?chaos`, behind a query string because its buttons cancel real registrations rather than simulating them — that fires the fifty-worker race at a live server and reports whether the invariant held.

**Attendance that cannot be screenshotted.** Check-in tokens are HMAC-signed, rotate every thirty seconds, are single-use, and are bound to a shift and a person. A photograph of one in Discord is worthless: the token is single-use, so the second scan of it is a 409 whoever presents it. The rotation itself gives about a ninety-second envelope — thirty seconds a slice, one slice of clock drift either way.

**Identity with three ways in.** A badge claim code needs nothing but the badge. A magic link needs an email. HackIllinois SSO needs Adonix. All three mint the same signed session, carried only in an HttpOnly cookie, with a CSRF nonce echoed on every mutation. Adapters are the extension point: a fourth is one file in `src/auth/` plus four small edits — a member on the `IdentityProvider` union and the schema enum beside it, a login method, an entry in `providers()`, and a route.

**A campus you can walk.** Five by five kilometres of Urbana-Champaign, nine thousand buildings, baked from OpenStreetMap into five-hundred-metre tiles that stream as the camera moves. Fourteen landmarks are territory gyms with hand-written silhouettes. Heights come from OSM tags where they exist (292 buildings), from surveyed levels otherwise (773), and from a per-type default for the remaining 88% — with lidar available when you run that step yourself. It renders at sixty frames a second on a laptop and degrades to thirty on a phone by dropping quality tiers rather than detail you would notice.

**Live multiplayer presence, at five thousand people.** Everyone who opts in appears on the map, moving with their GPS, over a WebSocket with an SSE fallback for networks that block it. The tick that builds those frames costs tens of milliseconds of CPU a second at full attendance — 59 ms at the p50 when re-measured, against 162 ms with the crowd artificially scattered — because the expensive part is computed once per fifty-metre cell and shared by everybody standing in it, which is exactly what scattering defeats. The absolute figures are a property of the machine and move by a good margin between them; the roughly 2.7x gap between the two layouts is the property of the code. What does hold everywhere measured is the slicing: the work yields every 8 ms, and the longest contiguous block measured is 12.2 ms scattered (9.4–10.8 ms clustered). `docs/PRESENCE.md` carries both measurements with their conditions and the arithmetic for re-running them. Positions are fuzzed, published one tick late, and never stored. Exactly three things read an exact position — a lead's roster, a lead's `GET /presence`, and SOS dispatch — and every one of them writes an audit row. Opting out stops you appearing to other players and stops you seeing them on the map. It does not disable a lead's two audited reads — the shift roster and `GET /presence` — so an opted-out lead still counts you and still reads exact positions over HTTP. That asymmetry is deliberate, because a lead has to be able to find somebody in an emergency whether or not they want their own dot drawn, and `docs/PRESENCE.md` names both halves of it.

**Distress calls that reach someone.** A hacker raises a ticket from their phone. Dispatch prefers a live position under thirty seconds old, falls back to the responder's shift venue, and keeps candidates with neither rather than silently skipping them. The ticket moves through a guarded lifecycle, and one nobody acknowledges within three minutes escalates to the floor. The public copy of that escalation carries the building and nothing finer — no coordinates, no table, no name — because a responder has to know where to walk and the `announce` channel is readable without a session.

**An economy with a ledger.** Karma is minted in exactly one place, capped per source per day, and recorded, so a disputed balance can be reconstructed. Quests — streaks among them — subscribe to a domain bus rather than being wired into the services that trigger them; stickers are still awarded by direct call from the quest and booth rules.

**A rival gym costs more than points.** Where a pack turns the gauntlet on — the shipped one does, `content/example-campus` ships no challenges and is unaffected — grinding a rival gym down no longer flips it: it floors at one control point and says what would finish it. The last hit is a coding challenge, served and answered inside that gym's geofence, on a server-side deadline. Nothing is executed. The judge normalises the submitted text, HMACs it and compares digests in constant time, so it verifies answers, not programs — no sandbox, no runner, no new dependency. Digests are all the pack ships, because the pack directory is served publicly, and be exact about what that buys: it stops an answer being read, not guessed, and every player of a challenge sees the same input, so answers are shareable. What bounds cheating is physical — the geofence at start and again at submit, the deadline, one submission, one open attempt per account (a partial unique index) and one capture per win (a conditional update), the last two settled by the database rather than by service code. Reinforcing an ally and taking neutral ground are unchanged, because gating those would break the first thirty seconds of play for the sake of the last one. `src/services/gauntlet.service.ts` is the whole of it.

## Making it yours

Read [docs/FORK_GUIDE.md](docs/FORK_GUIDE.md) to run it as your event, or
[docs/EXTENDING.md](docs/EXTENDING.md) to add a feature to it. The short version of the first:

```sh
cp -r content/example-campus content/my-event    # then edit event.json
npm run content:validate -- content/my-event
python3 -m design.pipeline fetch --pack content/my-event
python3 -m design.pipeline build --pack content/my-event
CONTENT_PACK=my-event npm run demo
```

A pack that does not validate does not start the server. That is deliberate: a typo in a venue key is a geofence anchored to the wrong building, and it should fail loudly at boot rather than quietly at three in the morning.

Two more steps if you want them. Gauntlet answers are authored in the clear under `design/challenges/`, which is neither served nor copied into the image; `npm run gauntlet:hashes -- my-event` writes only their digests into your pack's `challenges.json`, and `event.gauntlet.requiredForCapture` turns the requirement on — it defaults to false, so a pack without challenges keeps the capture rule it already had. `npm run icons` redraws the two PWA install icons from `design/tokens.mjs`, so a fork with its own palette gets its own mark.

| Document | What it covers |
|---|---|
| [DATA-MODEL.md](docs/DATA-MODEL.md) | Every collection, and why each is its own |
| [LIMITATIONS.md](docs/LIMITATIONS.md) | What is not solved, and why every constant is the number it is |
| [WORKFLOWS.md](docs/WORKFLOWS.md) | The six end-to-end journeys, from first tap to last write |
| [EXTENDING.md](docs/EXTENDING.md) | The six seams, in order of blast radius — start here to build on this |
| [FORK_GUIDE.md](docs/FORK_GUIDE.md) | Running this for a different event, in order |
| [CONTENT-PACKS.md](docs/CONTENT-PACKS.md) | Every pack file, field by field |
| [IDENTITY.md](docs/IDENTITY.md) | The two auth modes, the three adapters, the runbook |
| [PRESENCE.md](docs/PRESENCE.md) | The multiplayer wire, the privacy rules, the soak |
| [PLUGINS.md](docs/PLUGINS.md) | The trust model and the hooks |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Secrets, replica set, proxy, what to watch |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the concurrency primitives work, with diagrams |
| [design/pipeline/README.md](design/pipeline/README.md) | The campus bake, including the lidar step |
| [docs/REVIEWS.md](docs/REVIEWS.md) | Every external review round and what it found |

## Verifying it

```sh
npm test              # the suite, against a real replica set
npm run lint          # tsc --noEmit
npm run build
npm run content:validate
npm run campus:check   # schema, per-tile hashes, monument ids — offline
npm run csp:audit      # no inline scripts, no external origins
scripts/verify.sh full # typecheck, frontend imports, token/material lockstep, winding audit, campus check, suite
npm run bench:presence -- --clients 5000 --devices 2 --seconds 120   # needs `npm run demo` running
```

The tests are the interesting part of the suite rather than coverage filler: ten concurrent bounty reservations against a budget for three granting exactly three, fifty racing registrations against two slots, a lead who cannot spin another player's HackStop, a roster that reports presence as buckets and never a coordinate.

## Requirements

Node 20 or newer. Python 3.10 or newer with `shapely` and `numpy`, only if you are rebaking a campus. MongoDB in production as a single-node replica set, because transactions need one; the demo starts its own in memory.

## About this submission

This is an answer to the **HackIllinois 2027 Systems Coding Challenge, API track** — "using
TypeScript, Express and MongoDB, implement a volunteer backend API for creating and managing
volunteer shift signups". It deliberately overshoots that brief: the scheduling core is the
answer to the question asked, and the campus, the game layer and the presence system are there
because the interesting engineering in a volunteering system is what makes people turn up.

**Where to look if you are reviewing it.** The concurrency work is the part I would defend
first: `src/services/registration.service.ts` (the atomic capacity guard and the waitlist
cascade), `src/common/utils/cycleFinder.ts` and `src/services/swap.service.ts` (three-way trade
rings), and `src/services/checkin.service.ts` (the ordering of the check-in gates, and why each
one is where it is). `ARCHITECTURE.md` explains the primitives; `docs/DATA-MODEL.md` is the
schema reference and starts with the three database mechanisms every collection is built from;
`docs/WORKFLOWS.md` walks the journeys end to end. **`docs/LIMITATIONS.md` is the page to read
if you want to find the holes** — it lists what is unsolved and justifies every tuned constant,
because the interesting question about a system like this is what it does not handle.

**On tooling.** This was built with AI assistance — Claude Code, used throughout for
implementation and for adversarial review. The review process is not hidden: `docs/REVIEWS.md`
is a full log of every review round run against three independent external models (muse,
opencode, agy), every finding, which were real, which were wrong, and what each fix was. Several
of the most interesting bugs in this repository were found that way, and the log says so. Every
design decision, the calibration those reviewers were given, and every accept/reject on their
findings is mine. External data and libraries are credited in [NOTICE](NOTICE).

## Licence

MIT, in [LICENSE](LICENSE). The campus model is built from OpenStreetMap data under ODbL 1.0 and the fonts are OFL 1.1; attribution and the full list are in [NOTICE](NOTICE).
