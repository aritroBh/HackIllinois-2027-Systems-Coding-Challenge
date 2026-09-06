# The workflows, start to end

Six things happen in this system that involve more than one request, more than one person, or
more than one machine. This is what each of them does from the first tap to the last write,
where the guarantees live, and what happens when a step fails.

It is written for somebody who has to run the event, debug it at three in the morning, or
fork it. Each section names the files, so you can go and read the thing rather than trust the
description.

---

## 1. Getting in

**Who:** everybody, once. **Where:** `src/auth/`, `src/middleware/identity.ts`, `public/session.js`.

A badge, an email, or HackIllinois SSO. All three end in the same place.

1. The browser loads `/dashboard/` and `session.js` asks `GET /auth/providers` which ways in
   are configured. The sign-in screen is rendered from that answer, so a deployment with no
   SMTP server never offers a magic link.
2. **Badge claim.** The badge carries `#claim=<10 Crockford characters>` as a URL *fragment*,
   which browsers do not send to servers and proxies do not log. The page POSTs it to
   `/auth/claim`, the server compares a hash, and the code is spent atomically — a second
   claim of the same code finds nothing. Fifty bits of entropy against thirty guesses a minute
   per address is not a lock anybody picks; a global alarm fires on the fiftieth failure in an
   hour anyway.
3. **Magic link.** `/auth/magic-link` always answers 202, whether or not the address exists,
   because the alternative is an account-enumeration oracle. The link lands on `#magic=<token>`
   and is single-use for fifteen minutes.
4. **Adonix.** The HackIllinois identity service returns a token in the fragment. The server
   verifies it locally when it has the shared secret and otherwise exchanges it, with a four
   second timeout. An unknown role fails closed rather than defaulting to something.
5. All three mint the same thing: an HMAC session in an **HttpOnly cookie**, which JavaScript
   cannot read and therefore cannot leak, plus a second readable cookie holding a CSRF nonce.
   Every mutation echoes that nonce in `X-CSRF-Token`; the WebSocket upgrade echoes it in
   `Sec-WebSocket-Protocol`. There is no bearer token anywhere and no token in any response
   body, and a test asserts that.

**When it fails:** Adonix down is reported as a disabled provider, and badge codes still work.
SMTP down is the same. The event has never depended on one way in.

**Revocation** is a version number on the account, checked against a sixty-second cache. A
revoked session dies within a minute across the whole process without a database read per
request.

---

## 2. Taking a shift, and the fifty-way race

**Who:** volunteers. **Where:** `src/services/registration.service.ts`, `src/models/shift.model.ts`.

The interesting part is what happens when two hundred people tap the same shift in the same
second, which is exactly what happens when a shift is announced.

1. `POST /registrations` carries an `Idempotency-Key`. The key is inserted first, so a phone
   that retries on a flaky connection gets the original answer rather than a second seat.
2. The seat is claimed with **one atomic update**, not a read followed by a write:

       findOneAndUpdate(
         { _id, $expr: { $lt: ['$filledSlots', '$capacity'] } },
         { $inc: { filledSlots: 1 } }
       )

   `$expr`, not `{ filledSlots: { $lt: capacity } }` — the latter compares a field to a
   JavaScript literal captured before the query, which is the read-then-write this exists
   to avoid. Two fields of the same document can only be compared inside `$expr`.

   The condition and the increment are the same operation, so there is no window between
   checking and taking. Fifty simultaneous requests against two seats produce exactly two
   winners, every time, and the losers are told they are on the waitlist rather than told the
   request failed.
3. **Cancelling** is the subtle one. Freeing a seat and refilling it from the waitlist used to
   be two steps with several awaits between them, and a reservation arriving in that window
   saw a free seat that was already promised. The seat is now **held across the cascade** and
   released only if nobody is promoted, so it is never briefly claimable.
4. **Swaps** are a directed graph. A three-way ring — A wants B's shift, B wants C's, C wants
   A's — is found with cycle detection and executed in one transaction, so either everybody
   moves or nobody does.

**See it happen:** the Chaos Lab tab fires the fifty-worker race at the live server and
reports the result, and `npm run e2e` does the same from the command line with fifty real
signed-in sessions. The invariant is what to watch — exactly two confirmed, the rest
waitlisted or refused, never oversold. Refusals are the rate limiter, not the scheduler, so
their number moves with how the run is driven; `tests/concurrency.test.ts` runs it in-process
where no limiter applies and gets two confirmed and forty-eight waitlisted, every time.

---

## 3. Turning up

**Who:** volunteers, at a desk. **Where:** `src/services/checkin.service.ts`.

1. The volunteer's phone asks for a token for their shift. The server returns an HMAC over
   (shift, person, time slice) that expires in seconds.
2. A desk scanner reads it and POSTs it with the scanner's coordinates. The server checks the
   signature, the expiry, the geofence, and a replay store.
3. A photograph of somebody's screen is worthless: the token has rotated, and if it has not,
   it has already been spent. Tampering with a character produces `INVALID_SIGNATURE`, not a
   confusing failure.
4. **Check-out pays.** The award is the shift's karma times its surge multiplier, computed
   against the moment the volunteer *arrived* rather than the moment they left, so nobody is
   paid the rate the shift decayed to while they worked. It is then scaled by time served:
   a full hour earns the full award and a one-minute presence earns a sixtieth of it.
5. Check-out is idempotent. Ten simultaneous requests settle it once and pay once.

**Worth knowing:** check-out is final. The registration moves to `COMPLETED` and the token
endpoint refuses it, so a volunteer who steps out and scans back in is refused and needs a
lead. That closes the obvious farm at a real cost in convenience; the pro-rata payout is what
makes the farm worthless, so that is the rule to keep if this one is ever relaxed.

---

## 4. Somebody needs help

**Who:** a hacker, then a volunteer, then a lead. **Where:** `src/services/sos.service.ts`,
`public/views/sos.js`, `public/views/lead.js`.

1. A hacker taps a large button, picks a category, and their phone sends one coarse position.
   The ticket is created **inside a transaction** with the bounty debited from their daily
   budget, so there is never a ticket without a debit or a debit without a ticket.
2. **Dispatch** prefers a live position under thirty seconds old, found by expanding rings over
   the presence grid. It falls back to the responder's shift venue. A candidate with neither is
   kept and shown greyed with "no location" rather than silently dropped, because a responder
   who has not opted into presence is still a responder.
3. The ticket walks a guarded lifecycle: `OPEN → DISPATCHED → ACKNOWLEDGED → ON_SCENE →
   RESOLVED`, with `CANCELLED` available to the creator while open and to a lead at any point
   before the end. A transition table guards every edge, so a ticket cannot be dragged sideways
   into a state nobody can act on.
4. **What each person sees is different.** Leads, the hacker who raised it and the volunteer
   assigned to it get the whole ticket. Everybody else on the stream gets a redacted copy:
   ticket id, status, venue, category, urgency and the bounty. No coordinates, no table
   position, no name. The venue is a resolved building key, never the free-text table field,
   because "Table 9, back left" is exactly what the redaction exists to remove.
5. **Nobody answering** is the failure that matters. A ticket unacknowledged for three minutes
   escalates to the floor announcement channel — redacted, because that channel is public —
   with the full ticket going to leads.

---

## 5. Everybody on the map

**Who:** everyone who opts in. **Where:** `src/presence/`, `public/views/players.js`,
`public/gl/players.js`. Full detail in `docs/PRESENCE.md`.

1. A phone opens a WebSocket, authenticated by the session cookie the browser attaches to a
   same-origin upgrade, plus an origin check and the CSRF nonce. Networks that block
   WebSockets fall back to server-sent events after two failures, with identical rows.
2. Positions are sent when the phone has moved ten metres or five seconds have passed. The
   server accepts at most one every two seconds and runs each through gates in order: opted
   in, on campus, accurate enough, not moving faster than a bus, not muted.
3. **What is published is not what was sent.** The position is snapped to a twenty-metre grid,
   jittered by a per-hour stable offset, and published one tick late.
4. Once a second the server builds the world once, shares one interest computation per
   fifty-metre cell, and sends each client the nearest sixty players as eight-byte rows plus
   crowd counts for the rest. At five thousand clients that is about fifty milliseconds of CPU
   a second, sliced so it never holds the event loop for more than about ten.
5. **Privacy is symmetric.** Opting out hides you and stops your map showing others. Exactly
   two things read an exact position — a lead looking at a named person, and SOS dispatch —
   and both write an audit row that is deleted after thirty days. Positions themselves are
   never written to disk at all.

---

## 6. The campus, from OpenStreetMap to a phone

**Who:** whoever forks this. **Where:** `design/pipeline/`, `public/gl/`.

This runs once, offline, and produces a file. It is not in the request path.

1. **Fetch.** Overpass is queried per sub-box of the campus, four queries over a four-by-four
   grid, cached on disk with the URL, the query hash and the response digest recorded in a
   manifest. A build can say exactly what it was built from.
2. **Assemble.** Footprints come from OpenStreetMap first, filled from Overture, filled from
   Microsoft, deduplicated by overlap. Heights come from a tagged height, then lidar, then a
   floor count, then a type default — and which one was used is recorded per building.
3. **Generate.** Street trees and lamps are placed along the footway network; benches, bins and
   bike racks are placed the way a grounds department places them. OpenStreetMap has two
   hundred benches for the whole city, so the survey alone gives beautiful buildings on empty
   ground. Every generated placement comes from a hash of its own position, so the build is
   reproducible and the pack hash means something.
4. **Tile.** The model is cut into five-hundred-metre tiles, content-addressed by digest and
   served immutable. Only the index is revalidated.
5. **Stream.** The browser holds a ring of tiles around the camera, bakes each into GPU buffers
   on a worker thread, and draws them at one of three levels of detail chosen by distance.
   Rooftop plant is generated on the client from a hash of the building id, so it costs the
   download nothing and every player sees the same roofs.

**Checked by:** `npm run campus:check` validates the committed pack offline — schema, per-tile
digests, monument ids, the prop vocabulary — and `scripts/verify.sh full` adds a winding audit
over every geometry generator and a reproducibility rebuild.

---

## What runs on a timer

One scheduler module (`src/scheduler.ts`), one interval, several jobs: the no-show sweep that
resets streaks, the SOS escalation, raid windows opening and closing, and the presence roster
refresh. It is deliberately a single process — the event runs one instance, and a leader lock
is documented as the path to a second rather than built for one that does not exist.

## What to watch during the event

`GET /health` answers from memory and `GET /ready` pings the database; a health probe should
use the second. The numbers worth an alert are in `docs/DEPLOYMENT.md`, but the short version
is: `presence.skippedTicks` climbing means a whole second was not enough,
`streams.slots.total` approaching its ceiling means real people will be refused, and
`authMode` reading `legacy` in production means something is very wrong.
