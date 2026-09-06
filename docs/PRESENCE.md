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

- **opt-in** — off by default, and symmetric: while it is off you neither publish nor receive.
- **campus bbox** — a fix outside the pack's bounding box is refused, so nobody appears from another city.
- **accuracy** — over 50 m the sample is dropped with no penalty. Indoor GPS is routinely 50-100 m, and a dropped sample already costs the sender everything: they stay invisible. Someone reporting a fake accuracy to dodge the speed check simply never appears.
- **rate** — one accepted sample every 2 s.
- **speed** — over 15 m/s (campus buses do about 10) three times in a row is a 60 s mute, recorded in `presenceMutes` with a TTL index. The store re-reads it before `hello_ack`, so reconnecting does not clear it.

Published positions are snapped to a 20 m grid, jittered by a per-hour stable offset of up to 8 m, and released one tick late. The exact position exists only in memory, and only two things read it.

## Who can see an exact position

Two readers, both audited once per read in `presenceAudit` (30-day TTL):

- **SOS dispatch**, which prefers a live fix under 30 s old over the shift-venue estimate. Candidates with neither are kept and ranked last with `positionSource: "unknown"`, so the lead queue shows them greyed rather than silently dropping them.
- **A lead**, through `GET /api/v1/presence` (one call per 5 s per lead, one audit document per call, never one per row).

Aggregates are not exact reads: cluster counts name nobody and are not audited. The roster is not an aggregate, though — its per-volunteer presence age and distance buckets are a disclosure about named people, so a roster view is audited once per view (plan §A4). It arrives with M5.

Dispatch reads only opted-in, on-duty volunteers. Hackers are never dispatch candidates, and an opted-out volunteer falls back to their venue estimate, so opting out is honoured by dispatch too. The one exception to all of this is an SOS ticket's own coordinates: raising a ticket is the hacker's explicit request to share where they are.

Volunteers are additionally hidden from ordinary viewers while off shift; hackers are hidden only by opting out or leaving campus.

## Avatars

A sheet is uploaded as a raw PNG (at most 64 KB, 20 per hour), decoded, and **re-encoded from its pixels** before anything is stored. The bytes served are ours, not the uploader's, so metadata chunks and polyglot files do not survive; anything trailing the `IEND` chunk is refused outright. The sha256 is taken over the re-encoded bytes, so it identifies the image rather than the file. The same person uploading the same sheet twice gets one row; two different people get one row each, so a takedown against one never clears the other's avatar.

Sharing is opt-in and reviewed. An avatar is visible to its owner and to leads while `PENDING`, and to everyone once `APPROVED`. Three distinct reporters, or one lead, unpublish it immediately and emit `AVATAR_UNPUBLISHED` on the `game` channel, which is what evicts the texture from every connected renderer. Bytes are served `private, max-age=60, must-revalidate` with an ETag, never `immutable`, because that URL becomes a 404 the moment the avatar comes down.

The presence wire carries only the hash.

## Degradation

If two consecutive ticks exceed 30 ms the service drops every client to cluster-only rows and sends `notice{mode:"clusters"}`; it returns to full detail after 10 s of ticks under 15 ms. The M4b soak exists to prove this never fires at the event's real size.

## Running the soak

```
npm run demo                                    # a server with seeded accounts
npm run bench:presence -- --clients 1200 --devices 2 --seconds 120
npm run bench:presence -- --clients 1200 --storm 10
```

The harness provisions hacker accounts through a desk session, opens real sockets, walks each client, and reports the gate: tick p95 under 30 ms, outbound under 1 MB/s, the cluster fallback never triggered, and no 1013 close for an account inside its slot budget. Run it once with the generator's addresses in `TRUSTED_EGRESS_CIDRS` and once without, to exercise both the trusted path and the 800-streams-per-IP ceiling.

It provisions hackers rather than volunteers on purpose: an off-shift volunteer is invisible to their peers, so a crowd of them would measure an empty map.

## Act on behalf

One flow lets a lead act for someone else: registration, for the roster desk signing a volunteer up at the table. It needs a signed-in lead-or-above session and the dedicated `onBehalfVolunteerId` field, and every use is logged.

It is deliberately **not** part of `resolveActorId`, which six controllers call. Putting it there would let a shift lead spin another player's HackStop, resolve an SOS as them and take the bounty, or bank their karma on checkout. Delegation is opt-in per route instead.
