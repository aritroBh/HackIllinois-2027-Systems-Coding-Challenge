# Nexus Quest

A volunteer operations system for a large hackathon, with the campus it runs on rendered as a game world.

A thousand people are on a campus for thirty-six hours. Some are staffing shifts, most are building things, and a few need help right now. This is the software that schedules the first group, keeps the second entertained, and gets someone to the third quickly. The scheduling half is ordinary distributed-systems work done carefully. The game half exists because a volunteer who is enjoying themselves turns up for the 3:30 a.m. cleanup shift.

Everything specific to HackIllinois and to the University of Illinois lives in a content pack. Point the software at your own pack and it runs your event on your campus.

```sh
npm install
npm run demo          # http://localhost:3000/dashboard/
```

No configuration, no Docker, no secrets. That command starts an in-memory single-node replica set, seeds it, serves the dashboard against the same database, and signs the browser in.

## What is actually here

**Scheduling that holds under contention.** Fifty simultaneous requests for two slots produce exactly two confirmed registrations and forty-eight waitlist places, every time, because the check and the increment are one atomic operation rather than a read followed by a write. The same discipline covers cancellations, the waitlist cascade that promotes the next person, three-way swap rings resolved by cycle detection, rest buffers between shifts, and daily fatigue caps. `npm run demo` ships a Chaos Lab that fires the fifty-worker race at a live server and reports whether the invariant held.

**Attendance that cannot be screenshotted.** Check-in tokens are HMAC-signed, rotate every thirty seconds, are single-use, and are bound to a shift and a person. A photograph of one in Discord is worthless twenty seconds later.

**Identity with three ways in.** A badge claim code needs nothing but the badge. A magic link needs an email. HackIllinois SSO needs Adonix. All three mint the same signed session, carried only in an HttpOnly cookie, with a CSRF nonce echoed on every mutation. Adapters are the extension point: writing a fourth is one file.

**A campus you can walk.** Five by five kilometres of Urbana-Champaign, nine thousand buildings, baked from OpenStreetMap into five-hundred-metre tiles that stream as the camera moves. Fourteen landmarks are territory gyms with hand-written silhouettes. Heights come from tags where they exist, from surveyed levels otherwise, and from lidar when you run that step yourself. It renders at sixty frames a second on a laptop and degrades to thirty on a phone by dropping quality tiers rather than detail you would notice.

**Live multiplayer presence.** Everyone who opts in appears on the map, moving with their GPS, over a WebSocket with an SSE fallback for networks that block it. Positions are fuzzed, published one tick late, and never stored. Exactly two things read an exact position — a lead, and SOS dispatch — and both write an audit row. Opting out is symmetric: you neither appear nor see.

**Distress calls that reach someone.** A hacker raises a ticket from their phone. Dispatch prefers a live position under thirty seconds old, falls back to the responder's shift venue, and keeps candidates with neither rather than silently skipping them. The ticket moves through a guarded lifecycle, and one nobody acknowledges within three minutes escalates to the floor with no location in the public copy.

**An economy with a ledger.** Karma is minted in exactly one place, capped per source per day, and recorded, so a disputed balance can be reconstructed. Quests, streaks and stickers subscribe to a domain bus rather than being wired into the services that trigger them.

## Making it yours

Read [docs/FORK_GUIDE.md](docs/FORK_GUIDE.md). The short version:

```sh
cp -r content/example-campus content/my-event    # then edit event.json
CONTENT_PACK=my-event npm run content:validate
python3 -m design.pipeline fetch --pack content/my-event
python3 -m design.pipeline build --pack content/my-event
CONTENT_PACK=my-event npm run demo
```

A pack that does not validate does not start the server. That is deliberate: a typo in a venue key is a geofence anchored to the wrong building, and it should fail loudly at boot rather than quietly at three in the morning.

| Document | What it covers |
|---|---|
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
scripts/verify.sh full # the above plus the geometry winding audit
npm run bench:presence -- --clients 1200 --devices 2 --seconds 120
```

The tests are the interesting part of the suite rather than coverage filler: ten concurrent bounty reservations against a budget for three granting exactly three, fifty racing registrations against two slots, a lead who cannot spin another player's HackStop, a roster that reports presence as buckets and never a coordinate.

## Requirements

Node 20 or newer. Python 3.11 with `shapely` and `numpy` only if you are rebaking a campus. MongoDB in production as a single-node replica set, because transactions need one; the demo starts its own in memory.

## Licence

MIT, in [LICENSE](LICENSE). The campus model is built from OpenStreetMap data under ODbL 1.0 and the fonts are OFL 1.1; attribution and the full list are in [NOTICE](NOTICE).
