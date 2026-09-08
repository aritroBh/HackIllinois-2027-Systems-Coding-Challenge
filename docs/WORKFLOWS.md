# The workflows, start to end

Seven things happen in this system that involve more than one request, more than one person, or
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

**When it fails:** the button stays offered and the exchange fails about four seconds later with
`503 Adonix is unreachable; use a badge claim code instead.` Badge codes keep working throughout.

`adonixEnabled()` returns `env.ADONIX_ENABLED` and never probes upstream, so an outage cannot
report itself as a disabled provider — this said it did, and `docs/DRILLS.md` has described the
real behaviour all along. Steering a user to badge codes before the four-second wait would need a
health probe behind `providers()`, which is a change worth making deliberately rather than
implying in a sentence.
SMTP down is the same. The event has never depended on one way in.

**Revocation** is a version number on the account, checked against a sixty-second cache. A
revoked session dies within a minute across the whole process without a database read per
request. A demotion is the same mechanism seen from the other side, and it has to bite on a
socket that is already open: the presence service is told to forget the account's cached facts
and treats "not yet re-read" as *not a lead* until the refresh lands, because losing a
privilege has to be immediate even though gaining one can wait.

**Signing out is not the only handover.** These are shared laptops, and people close the lid.
Anything a departing account leaves on the device is cleared on sign-out *and* whenever the
browser changes hands without one — the remembered SOS ticket, the face drawn from a
photograph, the sticker book, the service-worker copy of the trainer card (the worker
acknowledges the delete, so the page waits for it rather than racing its own reload), the
presence socket, and every copy of those held in memory by a tab that is still open. The
device preference for lite mode is deliberately kept: it is a fact about the laptop, not about
the person.

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
   signature, the expiry, the geofence, a replay store — and **the clock**: a scan is accepted
   only within half an hour either side of the shift. The token binds a person to a shift and
   to a thirty-second slice, and the geofence binds the scan to a place, but until that window
   existed nothing tied any of it to the shift actually happening: a volunteer confirmed for
   tomorrow could mint a token today, stand at the venue, check in and check out for the full
   award, having worked nothing.
3. **The desk, not the person.** Minting a token and redeeming one are different privileges:
   the scan is `requireRole('SHIFT_LEAD')`, so the volunteer being checked in cannot present
   their own token to their own scan. The scanner's free-text id is still recorded, but the
   answer to "who did this" comes from the session beside it.
4. A photograph of somebody's screen is worthless: the token has rotated, and if it has not,
   it has already been spent. Tampering with a character produces `INVALID_SIGNATURE`, not a
   confusing failure.
5. **Check-out pays.** The award is the shift's karma times its surge multiplier, computed
   against the moment the volunteer *arrived* rather than the moment they left, so nobody is
   paid the rate the shift decayed to while they worked. It is then scaled by time served:
   a full hour earns the full award and a one-minute presence earns a sixtieth of it.
6. Check-out is idempotent. Ten simultaneous requests settle it once and pay once — and ten
   simultaneous *check-ins* produce one attendance, because `CheckIn.registrationId` carries a
   unique index. Ten distinct valid tokens is not a replay, so nothing else would have caught
   it.

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
   with the full ticket going to leads. A reassigned ticket can escalate again: the sweep
   filters on `escalatedAt`, so reassignment clears it along with the other timestamps.
6. **Coming back to it.** The hacker's browser remembers the ticket, stamped with whose it is,
   and reconciles against `GET /me/sos` on every sign-in — which answers with their own live
   call or `null`. The `null` is the important half: without it, a ticket that was resolved
   while the tab was shut came back stuck at `DISPATCHED`, a state with no Cancel and no
   Clear, and the device could never raise another call.
7. **What dispatch costs to ask.** Every dispatch writes one audit row naming the account that
   asked, and a non-lead is told a distance bucketed to 25 m and derived from the *published*
   position, not the exact one — a range quoted finely enough, from three chosen points, is a
   trilateration of somebody the fuzz was supposed to protect.

---

## 5. Everybody on the map

**Who:** everyone who opts in. **Where:** `src/presence/`, `public/views/players.js`,
`public/gl/players.js`. Full detail in `docs/PRESENCE.md`.

1. A phone opens a WebSocket, authenticated by the session cookie the browser attaches to a
   same-origin upgrade, plus an origin check and the CSRF nonce. Networks that block
   WebSockets fall back to server-sent events after two failures, with identical rows.
2. Positions are sent when the phone has moved ten metres or five seconds have passed. The
   server runs each through gates in this order: opted in, on campus, accurate enough, not
   muted, not sampling more often than every two seconds, not moving faster than a bus. The
   order is what decides which refusal a client is told about, and the mute is deliberately
   ahead of the rate and speed gates so a silenced sender hears the same answer whatever
   else is wrong with the sample.
3. **What is published is not what was sent.** The position is snapped to a twenty-metre grid,
   jittered by a per-hour stable offset, and published one tick late.
4. Once a second the server builds the world once, shares one interest computation per
   fifty-metre cell, and sends each client the nearest sixty players as eight-byte rows plus
   crowd counts for the rest. The cost of that tick depends on how the crowd is spread far more
   than on any figure quotable here: a scattered crowd costs ~2.7x a venue-clustered one, because
   scattering is what defeats the per-cell sharing. Measured p50 on a loaded dev machine was
   59 ms clustered and 162 ms scattered per second at five thousand sessions; an earlier laptop
   run gave ~50 ms and ~115 ms. Work is sliced against an 8 ms budget, but the clock is checked
   once every thirty-two sessions rather than every one, so a slice can overrun it — the longest
   contiguous block measured is 12.2 ms. `docs/PRESENCE.md` carries both runs, the ladder
   thresholds, and the tool to re-measure; treat the milliseconds as a property of the machine and
   the ratio as the property of the code.
5. **Privacy is symmetric between players, with one exception.** Opting out hides you from
   other players and stops your map showing them. An opted-out lead still reads exact
   positions two ways — the shift roster and `GET /presence` — which is the asymmetry
   and is stated in `docs/PRESENCE.md`.

   Exactly **three** things read an exact position, and each writes an audit row that is
   deleted after thirty days: a lead's roster (`GET /shifts/:id/roster`), a lead's
   `GET /presence`, and SOS dispatch. `src/models/presenceAudit.model.ts` enumerates all three
   beside the reasons they log, and is the file to trust if these ever disagree again — this
   list previously said "two" and named a per-player lead view that was designed and never
   built, while omitting the roster, which is real.

   Positions themselves are never written to disk at all.

---

## 6. Taking a rival gym

**Who:** any signed-in player. **Where:** `src/services/gauntlet.service.ts`,
`src/models/challengeAttempt.model.ts`, `src/services/gym.service.ts`, `public/game.js`.

Spending enough control points on a rival stronghold no longer takes it. The last blow is a
coding challenge, answered while standing inside that gym's own geofence.

This is a pack decision. `event.gauntlet.requiredForCapture` defaults to **false** in
`src/content/schema.ts`; the shipped `content/hackillinois-2027/event.json` sets it true;
`content/example-campus` neither sets the flag nor ships a `challenges.json`, and either of those
alone would be enough, because `GauntletService.requiredForCapture()` refuses to honour the flag
for a pack that ships no challenges. Reinforcing an ally and taking neutral ground are untouched either way — the flag
gates the flip of a rival gym and nothing else.

1. **Walk there.** Every step below sends coordinates and every one of them is checked against
   the gym's position server-side. The client refuses first: `requirePlayerCoords` in
   `public/app.js` stops the request and says "Taking a gym needs your position. Open Campus and
   place your trainer first."
2. **Grind it down.** FIGHT is unchanged — `battleOrFortifyGym` in `public/app.js` posts
   `power: 150` to `POST /pokeshift/gyms/:id/battle`, and each strike takes that many control
   points off. What changed is the strike that would have flipped the gym: with the flag on, it
   floors the gym at **1 control point** instead, and the server's own message says what is
   left to do — "… is down to its last point. Win its coding challenge to take it."
3. **Open the challenge.** CHALLENGE in the encounter modal (`public/game.js`), disabled on
   allied and unclaimed gyms. It posts to `POST /pokeshift/gyms/:id/gauntlet`, and a 201 carries
   the title, the prompt, the difficulty, the choices for a `MULTIPLE_CHOICE` question or the
   per-case inputs for a `PREDICT_OUTPUT` one, `expiresAt`, and the `capturePower` the win is
   worth. No answer travels in any form. The question is chosen by hashing the gym id, so
   closing the modal and re-opening the same gym asks the same thing — there is no reroll.
4. **Answer it, still inside the fence.** The countdown is drawn from the server's `expiresAt`
   rather than a timer started in the browser, and the client re-reads the player's position for
   the submit. `POST /pokeshift/gauntlets/:attemptId/submit` re-checks the geofence, checks the
   deadline against the server clock, and judges: normalise the text, HMAC it, compare it to the
   digest the pack ships with `timingSafeEqual`. **Nothing is executed** — there is no sandbox
   here because there is nothing to sandbox; it verifies answers, not programs. The reply is a
   per-case verdict list and a count, never the expected answer.
5. **Spend the win.** A win is a single-use token, not a capture: the attempt sits in `WON` until
   `POST /pokeshift/gauntlets/:attemptId/spend` exchanges it, and that exchange is a conditional
   update from `WON` to `SPENT`, so twenty requests carrying the same attempt id produce one
   capture and nineteen refusals. The spend calls the ordinary capture path,
   `GymService.battleOrContribute` with `viaGauntlet` set and the challenge's `capturePower` as
   the strike — same compare-and-set, same shield rule, same faction binding, same payout. There
   is no second capture path to drift.

**Grind first, then answer.** The spend is an ordinary strike carrying the challenge's
`capturePower`, so a win spent on a gym that still holds more control points than that is spent
on damage rather than on a capture — and the token is gone. The floor at 1 control point is what
makes the intended order work.

**What the karma is.** A gauntlet capture pays exactly what any capture pays: the fixed capture
bonus through the existing `GYM` karma source, under the existing cap and the existing
per-account cooldown. No new source was added, because `crossValidate` refuses a pack that
leaves a declared source unpriced and adding one would boot-break every fork that pulled the
commit without editing its pack. A pack may declare `rewardKarma` on a challenge and the submit
response reports it, but nothing credits it today: that number reaches no ledger.

### What each refusal means

All three routes require a signed-in session, unlike `/battle`. Every message below is the
server's own; the client shows it verbatim rather than replacing it with something friendlier,
because "something went wrong" is how a player walks away not knowing to move.

| What you see | Why | What to do |
|---|---|---|
| `Out of range: You are …m from …. Must be within …m to attempt its challenge.` | You are outside the gym's geofence, at start or again at submit. The radius is the one `geofenceMetersFor()` resolves, not a literal. A spend from out of range is refused too, in the capture path's own wording ("… to contest this Gym"). | Walk closer. The message quotes the distance and the radius it was measured against. |
| `You already have a challenge open. Finish it or let it run out first.` | One open attempt per account, across all gyms, enforced by a partial unique index rather than by a count. Backing out of the modal does not close the attempt — the clock keeps running. | Answer the one you have, or wait for its deadline; starting again after it lapses sweeps it first. |
| `Time is up on that challenge. Start another one.` | The server-side deadline passed. A correct answer arriving late still loses; that is what a deadline means. | Start another attempt. |
| `That challenge is already finished.` | The attempt is no longer `OPEN` — usually a second submit of the same one. | Read the first reply; if it was a win, spend it. |
| `That challenge win has already been used.` | The `WON` → `SPENT` update matched nothing: the win is spent. | Nothing to recover. Win another. |
| `Gym is currently protected by an active Boba Shield. Cannot contest!` | A live shield on the gym, checked at start and again by the capture path. | Wait for it to expire. |
| `Faction allegiance is locked to …. It is chosen once and cannot be changed.` | The spend named a different faction from the one this account is bound to. | Spend for your own faction. |
| `This event ships no coding challenges.` | The pack has no `challenges.json`. | Nothing a player can do; the pack decides. |
| `No such challenge attempt.` | No attempt with that id **belonging to you** — the lookup is scoped to the account, so another player's attempt reads as absent rather than as forbidden. | Start your own. |
| `Gym contestation was interrupted by high-concurrency write contention. Please retry.` | Five compare-and-set attempts all lost to other writers. | Retry — but if this arrives on a spend, the win was already burned and is not returned. The message is the capture path's own and does not say so. |

**What is not solved, stated plainly.** The pack directory is served publicly at
`/dashboard/content`, so answers ship only as digests, keyed on a per-pack `answerSalt` rather
than on `QR_HMAC_SECRET` — outside production an unset `QR_HMAC_SECRET` is replaced with a fresh
per-boot value (`src/config/env.ts`), so a pack keyed on it would stop judging correctly the next
morning. Be exact about what the salt buys:
**it stops the answer being read, not guessed.** The answer space is small and candidates can be
hashed offline against a salt anybody can download. Every player of a challenge also sees the
same input, so a correct answer is a constant and can be passed around. Nothing makes a player
wait after a loss, either, and the question is the same one next time. What actually bounds all
of this is physical: the geofence at both ends, a server-side deadline, one submission per
attempt, and one open attempt per account.

**Checked by:** `tests/gauntlet.test.ts`, which fires concurrent starts and concurrent spends and
asserts exact counts, because "one open attempt" and "one spend per win" are claims about the
database and counting is the only way to make them.

---

## 7. The campus, from OpenStreetMap to a phone

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

One scheduler module (`src/scheduler.ts`), one interval, three jobs, and this list is the
whole of it:

| Job | Every | What it does |
|---|---|---|
| `sos-escalation` | 30 s | A dispatched ticket nobody has acknowledged for three minutes is shouted about once — redacted on the public channel, in full to leads. |
| `presence-sse-sweep` | 30 s | The SSE fallback has no socket to close, so a client that stops posting is reaped on a timer. |
| `raid-windows` | 30 s | Announces a raid window opening and closing, once each. |

It is deliberately a single process — the event runs one instance, and a leader lock is
documented as the path to a second rather than built for one that does not exist.

This paragraph used to name a no-show sweep that resets streaks and a presence roster refresh,
and neither is a scheduled job: no no-show sweep exists at all, and the roster refresh is a
lazy re-read inside the presence service rather than something on this timer. It also named
raid windows, which *was* wrong until the ticker was given a caller — `RaidService.tick` had
none for the whole of M6. The table above is generated from nothing; it is checked instead, by
`scripts/checkPlanGates.sh`, which asserts these three names are registered.

## What to watch during the event

`GET /health` answers from memory and `GET /ready` pings the database; a health probe should
use the second. The numbers worth an alert are in `docs/DEPLOYMENT.md`, but the short version
is: `presence.skippedTicks` climbing means a whole second was not enough,
`streams.slots.total` approaching its ceiling means real people will be refused, and
`authMode` reading `legacy` in production means something is very wrong.
