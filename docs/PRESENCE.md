# Live presence

Everyone who opts in appears on the campus map, moving with their GPS. This is the multiplayer layer: what it sends, who can see whom, and what is deliberately never stored.

## The shape of it

| | |
|---|---|
| Transport | WebSocket at `/ws/presence`, SSE + `POST /api/v1/presence` as the fallback |
| Tick | 1 Hz deltas, a full snapshot every 15 s or on demand |
| Interest | 50 m cells within 300 m; the nearest 60 at full detail, the rest as cluster counts |
| Row | 8 bytes: slot, x, z (0.2 m units), heading, and flags for faction, staleness and kind |
| Budget | about 0.6 KB per client per second at full detail |
| Storage | none — positions live in memory and vanish with the process |

## Authenticating the upgrade

A WebSocket upgrade never passes through Express middleware, so it is checked three ways before the handshake completes:

1. the HttpOnly session cookie the browser attaches to a same-origin upgrade,
2. an `Origin` matching either the request's own `Host` or `PUBLIC_URL`,
3. the CSRF nonce, carried as the `nexus.v1.<nonce>` subprotocol.

Nothing travels in the query string. A failure answers 401 or 403 on the raw socket.

## Gates on a position

In order, and each for a reason:

- **opt-in** — off by default, and symmetric *on the map*: while it is off you neither publish nor receive a frame. It is not symmetric for a lead's audited reads. `GET /api/v1/presence` (`src/routes/v1/presence.routes.ts`) gates on `requireSession` and `requireRole('SHIFT_LEAD')` and checks nothing about the reader's own preference; the shift roster behaves the same way. So an opted-out lead is invisible on the map and still reads exact positions over HTTP, once per five seconds, with an audit row per call. That is intended — a lead has to be able to find somebody in an emergency whether or not they want their own dot drawn — but it is a second asymmetry, and this list previously named only the roster.
- **campus bbox** — a fix outside the pack's bounding box is refused, so nobody appears from another city.
- **accuracy** — over 50 m the sample is dropped with no penalty. Indoor GPS is routinely 50-100 m, and a dropped sample already costs the sender everything: they stay invisible. Someone reporting a fake accuracy to dodge the speed check simply never appears.
- **rate** — one accepted sample every 2 s.
- **speed** — over 15 m/s (campus buses do about 10) three times in a row is a 60 s mute, recorded in `presenceMutes` with a TTL index. The store re-reads it before `hello_ack`, so reconnecting does not clear it.

What the sender is told when one of these refuses them is the next section.

Published positions are snapped to a 20 m grid, jittered by a per-hour stable offset of up to 8 m, and released one tick late. The jitter is derived from a server secret, not from the account id and the clock: both of those are values a viewer already holds (the id ships in every join), so keying it on them would have let any viewer recompute the offset and subtract it, leaving the grid snap doing all the work. The exact position exists only in memory, and only three things read it.

## When a gate refuses you

A refused sample is answered on the socket as `{t:'nack', reason}`, for every verdict except
`RATE`. The HTTP fallback has always done this — `POST /api/v1/presence`
(`src/routes/v1/presence.routes.ts`) returns `reason` on every refusal, 403 for `OPT_OUT`, 429
for the two mute verdicts, 202 with `accepted: false` otherwise — so the two transports now
agree about whether a sender is entitled to know why they vanished.

The socket used to answer only `MUTED`, `SPEED_STRIKE` and `OPT_OUT`: the three that mean the
sender is publishing nothing until it or the clock changes something. `OFF_CAMPUS`,
`INACCURATE` and `TOO_FAST` were dropped with no frame at all, which is backwards, because
those are the verdicts an ordinary person actually meets. Someone who opted in, granted
location and sent a fix the server refused on the merits was told nothing, while the interface
went on reporting them as visible. The stated reason for the silence was noise — a phone with a
poor indoor fix would be nacked on every sample — and that concern is real; it is handled in
the client below rather than by withholding the verdict from the person it is about.

| Reason | Why the sample was refused | What the sender is told |
|---|---|---|
| `OPT_OUT` | the switch is off — and the refusal also erases any entry left behind | nothing; this is the switch doing what it was asked |
| `OFF_CAMPUS` | outside the pack's bounding box | "Off the campus map", with roughly how far outside |
| `INACCURATE` | reported accuracy worse than the pack's `maxAccuracyMeters` (50 m as shipped) | "Waiting for a sharper fix", quoting the device's own figure against the threshold |
| `TOO_FAST` | one implausible jump; costs that sample and nothing else | "Skipped a reading", and that nothing else follows |
| `SPEED_STRIKE` | the third jump in a row, which is also the 60 s mute being applied | "Paused on the map… it clears on its own" |
| `MUTED` | a mute still standing | the same, in the shorter form |
| `RATE` | under 2 s since the last accepted sample | nothing |

`RATE` stays silent, and not because it is harmless: the protocol header advertises samples
"≥ 2 s apart", so a client tripping it is out of cadence rather than merely unlucky. It stays
silent because the answer carries nothing the client can act on, and it would be sent most
often to the client that is already sending most often.

Two other nacks are not verdicts on a position at all: `BAD_JSON` for a frame that does not
parse, and `UNKNOWN` for a message type this server does not have. Both answer the message.

### What the client shows

`describeRefusal` in `public/views/players.js` turns a reason into a short chip label and one
sentence. The chip is `#presence-chip`, the button in the campus view's header that also works
the opt-in switch, and a live refusal outranks the transport state there — a chip reading "On
the map" while the server is refusing every sample asserts the opposite of what is happening,
which is what made this look broken rather than strict. The sentence also appears under the
"Show me on the campus map" switch in `public/views/me.js`.
`OPT_OUT` and `RATE` deliberately render nothing: neither is a fault.

The nack carries the reason and no numbers, so the figures in those sentences are the client's
own — the accuracy and the coordinates it last sent, kept for exactly this. That is why the
distance in an `OFF_CAMPUS` line is the client's own arithmetic against the campus bounds
rather than something the server measured for it.

Noise is bounded on the client rather than by silence. A sample goes out when the sender has
moved `SEND_DISTANCE_M` or `SEND_INTERVAL_MS` has passed, whichever comes first, and a standing
refusal is one state on one chip rather than a stream of messages, so a problem that persists
says one thing however many times it is refused. A refusal expires rather than being cleared,
because the server never acknowledges an accepted sample — success is silence, so there is no
opposite to clear it. `REFUSAL_TTL_MS` is 12 s, and `TOO_FAST` gets `TRANSIENT_REFUSAL_TTL_MS`
at 6 s: a repeating jump re-nacks and keeps talking either way, so the shorter life only
shortens how long a *recovered* one-off goes on reporting a skipped reading after the next
sample has already been accepted. Both are longer than the send interval, so a healthy sender
does not flicker between the two states.

## Who can see an exact position

Three readers, each audited once per read in `presenceAudit` (30-day TTL) — the set is
enumerated beside its reasons in `src/models/presenceAudit.model.ts`, which is the file to trust
if this list ever drifts again:

- **SOS dispatch**, which prefers a live fix under 30 s old over the shift-venue estimate. Candidates with neither are kept and ranked last with `positionSource: "unknown"`, so the lead queue shows them greyed rather than silently dropping them.
- **A lead**, through `GET /api/v1/presence` (one call per 5 s per lead, one audit document per call, never one per row).

- **A lead's shift roster**, `GET /api/v1/shifts/:id/roster`, audited once per view rather than once per volunteer listed.

Aggregates are not exact reads: cluster counts name nobody and are not audited. The roster is not an aggregate, though — its per-volunteer presence age and distance buckets are a disclosure about named people, which is why it is the third reader above rather than a footnote to it. (This section previously called the roster a future arrival and counted only two readers; it shipped, and `src/controllers/shift.controller.ts` has written its audit row since.)

Dispatch reads only opted-in, on-duty volunteers. Hackers are never dispatch candidates, and an opted-out volunteer falls back to their venue estimate, so opting out is honoured by dispatch too. The one exception to all of this is an SOS ticket's own coordinates: raising a ticket is the hacker's explicit request to share where they are.

Volunteers are additionally hidden from ordinary viewers while off shift; hackers are hidden only by opting out or leaving campus.

## Avatars

A sheet is uploaded as a raw PNG (at most 64 KB, 20 per hour), decoded, and **re-encoded from its pixels** before anything is stored. The bytes served are ours, not the uploader's, so metadata chunks and polyglot files do not survive; anything trailing the `IEND` chunk is refused outright. The sha256 is taken over the re-encoded bytes, so it identifies the image rather than the file. The same person uploading the same sheet twice gets one row; two different people get one row each, so a takedown against one never clears the other's avatar.

Sharing is opt-in and reviewed, and publication needs both halves. An avatar is visible to its owner and to leads while `PENDING`, and to everyone once it is `APPROVED` **and** its owner set `shareOptIn` — approval on its own does not publish it. Three distinct reporters, or one lead, unpublish it immediately and emit `AVATAR_UNPUBLISHED` on the `game` channel, which is what evicts the texture from every connected renderer. Bytes are served `private, max-age=60, must-revalidate` with an ETag, never `immutable`, because that URL becomes a 404 the moment the avatar comes down.

The presence wire carries only the hash.

## How five thousand clients stay affordable

Three things carry the tick, and each of them replaced a per-client cost with a shared one.

**One index per tick, not one scan per client.** Every publishable position is bucketed by 50 m cell once, at the top of the tick. Off-shift volunteers are separated from the public view in the same pass, so the per-viewer path never re-asks who is allowed to see whom.

**One interest pass per cell, not per client.** The interest span is `floor(x / cell) ± span`, so everybody standing in the same cell scans the same cells and sees the same candidates. That computation is done once and shared. Twelve venues' worth of a five-thousand-person event is about a hundred and seventy shared passes against five thousand clients. The price is that the nearest-sixty cut is ranked from the cell centre rather than from each viewer's exact position, which reorders the tail of a three-hundred-metre ring and changes nothing anybody can see.

**A coarse block index over the cells.** A 300 m radius over 50 m cells is 169 lookups whether or not anybody is there, and at three in the morning most of a 25 km² campus is car parks. Cells are grouped into 400 m blocks, and the scan asks which blocks are occupied before it asks which cells are. On a thinly spread campus that turns a hundred and sixty-nine misses into a handful.

The tick is also **sliced**. The work is the same, but it yields to the event loop every 8 ms, so the worst latency presence adds to an unrelated HTTP request is a slice rather than a whole tick. Measured with five thousand sessions and five thousand publishers, all moving every second.

| | venue-clustered | artificially scattered |
|---|---|---|
| originally recorded (a laptop) | ~50 ms | ~115 ms |
| re-measured 2026-09-07 (loaded dev machine, two runs) | p50 **59 ms**, p95 94–104 ms | p50 **162 ms**, p95 211 ms |
| longest contiguous block | 9.4–10.8 ms | 12.2 ms |

**The slicing guarantee holds and the scattered figure does not.** Contiguous blocking stayed
within a slice of the 8 ms budget in every run, which is the property the slicing exists to
provide and the one worth trusting. The clustered figure is ~18% above what was recorded; the
scattered one is ~40% above, and "about 115 ms" is not a fair description of 162 ms.

Both sets are honest and neither is portable — the first was a laptop, the second a machine that
had been running test suites and three review agents all day. **Treat the absolute milliseconds as
a property of the machine and the ratio as the property of the code**: the scattered layout costs
roughly 2.7x the clustered one here against 2.3x as first recorded, because sharing one cohort
pass per occupied cell is exactly what scattering defeats. That is the claim that survives being
run somewhere else.

One consequence worth seeing, because it is the number the ladder cares about: scattered p95 of
211 ms is *above* the 200 ms rung-1 threshold below. This run stayed on rung 0 with no skipped
ticks, but on a machine like this the scattered layout sits at the degradation boundary rather
than comfortably inside it. Re-measure before quoting either figure at an event.

```
npx tsx scripts/benchmarks/presenceTick.ts               # in-process, no network
npx tsx scripts/benchmarks/presenceTick.ts --spread scatter
```

## Degradation

The old behaviour was a cliff: one threshold, and past it every sprite on every map vanished at once. It is now a ladder with three rungs, judged on CPU spent per tick rather than on wall clock, because a sliced tick's wall-clock span says more about what else the process was doing than about presence.

| Rung | Trips at | What a player sees |
|---|---|---|
| 0 full | — | the nearest sixty players, individually |
| 1 reduced | two ticks over 200 ms | the nearest thirty, plus counts for the rest |
| 2 clusters | two ticks over 500 ms | counts only, no individual positions |

Every change sends `notice{mode}` so the interface can say "showing crowd counts only" rather than letting a player conclude the campus emptied. Recovery climbs one rung at a time after 10 s of ticks under 120 ms, so one busy moment does not strand the event on the bottom rung. The soak exists to show that rung 0 holds at the event's real size.

## Running the soak

```
npm run demo                                    # a server with seeded accounts
npm run bench:presence -- --clients 5000 --devices 2 --seconds 120
npm run bench:presence -- --clients 5000 --storm 10
```

The harness provisions hacker accounts through a desk session, opens real sockets, walks each client, and reports the gate: tick CPU p95 under 30 ms, peak outbound under 1 MB/s, no 1013 close for an account inside its slot budget, and the accounts and sockets it was asked for actually provisioned and held. Two things it does not check, both of which an earlier version of this paragraph claimed it did. It samples the server's own tick statistics and nothing else, so the longest event-loop block is measured by the in-process `scripts/benchmarks/presenceTick.ts` above rather than here; and the rung it watches is the server's `clusterMode` flag, which is the bottom rung alone, so a run that spent its whole two minutes on the middle rung would still pass. Run it once with the generator's addresses in `TRUSTED_EGRESS_CIDRS` and once without, to exercise both the trusted path and the 3,000-streams-per-IP ceiling.

Two things learned by running it, both about setup rather than about the gate.

**Provisioning is slow, and setting it up is most of the run.** Each client costs two rate-limited calls: `POST /volunteers` through the desk session, guarded by a 90-per-minute *mutation* bucket keyed on that account — which `TRUSTED_EGRESS_CIDRS` cannot widen, because it widens per-IP ceilings and this is per-account — and `POST /auth/dev-login`, a *credential exchange* at 30 a minute per address, ten times that on trusted egress. The desk bucket is therefore the ceiling: roughly ninety accounts a minute at best, so a thousand clients is a quarter of an hour of setup before a sixty-second measurement. That is why the file suggests four hosts at `--clients 1250` rather than one at 5,000.

Both calls now wait the limiter out. They did not always: the sign-in had no retry at all, so past the first thirty accounts of each minute the client was dropped, and a 1,200-account run provisioned about 370 while printing gate rows for all of them. The gate asserts the count now — a soak that measures a third of the event is not a soak that failed, it is one that answered a different question.

**Point `--url` at the address you allow-listed.** `localhost` resolves to `::1` first on macOS and `TRUSTED_EGRESS_CIDRS` is IPv4-only, so `--url http://localhost:3000` with `127.0.0.1/32` in the list silently leaves the *stream* ceilings on the untrusted path. Use `http://127.0.0.1:<port>`, and watch the boot log for the "ignoring" warning if you pasted an IPv6 range.

It provisions hackers rather than volunteers on purpose: an off-shift volunteer is invisible to their peers, so a crowd of them would measure an empty map.

## Act on behalf

One flow lets a lead act for someone else: registration, for the roster desk signing a volunteer up at the table. It needs a signed-in lead-or-above session and the dedicated `onBehalfVolunteerId` field, and every use is logged.

It is deliberately **not** part of `resolveActorId`, which six controllers call. Putting it there would let a shift lead spin another player's HackStop, resolve an SOS as them and take the bounty, or bank their karma on checkout. Delegation is opt-in per route instead.
