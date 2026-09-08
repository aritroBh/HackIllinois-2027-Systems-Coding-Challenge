# Showing this to somebody

Twenty minutes, one terminal, one browser tab. Every claim below is one you can make out
loud and then demonstrate; nothing here needs a story about what it *would* do.

```sh
npm install
npm run demo          # http://localhost:3000/dashboard/
```

That starts an in-memory single-node replica set, seeds it, serves the dashboard against the
same database, and signs the browser in. No configuration, no Docker, no secrets.

In a second terminal:

```sh
npm run e2e           # drives the live server through most of what follows
```

(Most, not all: the gauntlet in §8 is not in that script — it shipped without touching it.
`tests/gauntlet.test.ts` is what covers it.)

---

## The one-sentence version

> A thousand people are on a campus for thirty-six hours. Some are staffing shifts, most are
> building things, and a few need help right now. This schedules the first group, keeps the
> second entertained, and gets someone to the third quickly — and the campus they are
> standing on is rendered as a game world you can walk.

Then: **the interesting engineering is contention.** Everything else follows from that.

---

## 1. Lead with the race, because it is the thing that is actually hard

Open the **Chaos Lab** tab, or run `npm run e2e` and watch section 3. The tab is behind
`?chaos` — load `http://localhost:3000/dashboard/?chaos` — because its three buttons are not
simulations: they create real shifts, real accounts and real swaps, and one of them cancels a
real volunteer's seat. Add the query string before you go on stage, not during.

Fifty accounts and fifty concurrent `POST /registrations` against a shift with two seats. The
two paths get there differently and it is worth knowing which you are showing: the Chaos Lab
issues delegated `onBehalfVolunteerId` registrations under the one signed-in organiser
session, while `npm run e2e` signs all fifty accounts in for real and waits out the sign-in
limiter to do it. The contention being demonstrated is at the database, not at the cookie:
fifty requests reach the same two seats at the same moment either way.

**Exactly two confirmed. Forty-eight waitlisted. Zero oversold. Every time.**

The reason is one line, and it is worth pulling up on screen — `src/services/registration.service.ts`:

```ts
Shift.findOneAndUpdate(
  { _id, $expr: { $lt: ['$filledSlots', '$capacity'] } },
  { $inc: { filledSlots: 1 } },
)
```

The condition and the increment are the same operation. There is no window between checking
and taking, so there is no race to lose. Say that, and then say what it replaced: a read,
then a write, with several `await`s in between.

**If they push:** the honest edges are worth volunteering before they find them.

- `filledSlots` is a denormalised counter, not a row count — deliberately, because a
  volunteer who checks in keeps their seat while the CONFIRMED count falls.
- `reserveShift` is not transactional. A crash between the `$inc` and the row insert leaves
  the counter one high, and there is no reconciliation job yet. It fails toward *undersell*,
  which is the direction you want.
- The compensating decrements in the catch blocks assume a rejected promise means the write
  did not land. That is not knowable from a rejected promise. It is a real hole and it is
  small; the release path was already hoisted out of the catch for exactly this reason.

## 2. Cancellation, which is the subtle one

Cancel a confirmed seat on the contested shift. Watch the waitlist go 48 → 47 and the seat
refill in the same request.

The point to make: freeing a seat and refilling it from the waitlist used to be two steps
with several awaits between them, and a reservation arriving in that window saw a seat that
was already promised. **The seat is now held across the cascade** and released only if
nobody is promoted — so it is never briefly claimable.

## 3. The three-way ring

`POST /swaps/cycles/resolve`, or the **Resolve 3-way trade** button in the Chaos Lab tab
(`?chaos` again).

Alice wants Bob's shift, Bob wants Charlie's, Charlie wants Alice's. The resolver builds the
directed wants-graph, enumerates elementary cycles of length 2–4 by depth-first search, and
executes the rotation inside one transaction: every leg moves or none does.

**Call it a bounded DFS, not Tarjan.** There is no strongly-connected-components pass and no
canonical-rotation hash — deduplication falls out of refusing to traverse below the start
node, so each ring is found exactly once from its smallest member. (ARCHITECTURE.md claimed
Tarjan for a while. It was wrong, and it is fixed.)

Worth showing: every leg is validated *before* the transaction opens — the receiver must
hold the incoming shift's certifications and must not collide with it. A ring that fails
validation is marked FAILED with the reason, and nobody moves.

## 4. Attendance that cannot be screenshotted

Mint a token from **Me → Check in**. It is minted against the signed-in account, so it lives
beside that account rather than in the staff-only Trainer tab, which carries only the desk's
side of the exchange and a link across. Scan it. Scan it again.

- HMAC-SHA256 over `version:volunteerId:shiftId:timeSlice:nonce`, compared with
  `timingSafeEqual`, and the comparison happens *before* the replay check so it is not an
  oracle.
- Rotates every thirty seconds, with one slice of drift tolerance either way — so the honest
  envelope is about ninety seconds, not twenty. **Say ninety.** The thing that actually stops
  a photograph in Discord is single-use: an in-process nonce cache plus a unique index on
  `CheckIn.nonce`, so two simultaneous scans produce one check-in and one 409.
- Bound to a shift *and* a person, and the binding is re-queried rather than trusted from
  the payload, so a token for shift A cannot be replayed on shift B.

**Volunteer the gap:** the geofence cannot tell a spoofed GPS fix from a real one. A scanner
that sends the venue's published coordinates satisfies it from anywhere, so the geofence is a
convenience check against honest mistakes, not an attestation. Binding a scan to the scanner's
own attested position is the fix, and it is not built.

*(This section used to say there was no shift time-window check. There is one:
`src/services/checkin.service.ts` refuses a check-in more than thirty minutes either side of
the shift, and `docs/WORKFLOWS.md` §3 ("Turning up") describes it. The gap was real when this page was
written and the sentence outlived the fix — exactly the failure this document exists to avoid
on stage.)*

## 5. Distress

Raise a ticket from a phone. Dispatch. Acknowledge. On scene. Resolve.

Dispatch prefers a live position under thirty seconds old, falls back to the responder's
shift venue, and keeps candidates with neither rather than silently skipping them — a
first-aid call routed to the nearest person who cannot give first aid is a slower
non-answer, so it is nearest *qualified*.

The lifecycle is a real state machine with a transition table, and each move is a
compare-and-set against the status that was read, so two responders acknowledging produce
one winner and one clean 409. A ticket nobody acknowledges within three minutes escalates to
the floor — by a database sweep on the scheduler's tick rather than a per-ticket timer, so it survives a restart and cannot double-fire
— and the public copy of that escalation carries the building and never the table, the name
or the coordinates.

## 6. Presence, and the privacy model

Opt in on two devices and watch them appear on the campus.

If one of them does not appear, the map now says why instead of looking broken — useful on
stage, where a phone indoors is the likeliest thing to go wrong. The socket answers a rejected
position with a nack for every verdict except `RATE` (`src/presence/wsTransport.ts`), and
`describeRefusal` in `public/views/players.js` turns `INACCURATE`, `OFF_CAMPUS`, `TOO_FAST`,
`SPEED_STRIKE` and `MUTED` into one chip with a sentence. It used to answer only the three
punitive reasons, so the two an ordinary person actually meets — a poor indoor fix, and standing
outside the campus box — vanished them silently while the interface went on reporting them as
visible.

The number to lead with is a **ratio, not a millisecond count**: an artificially scattered crowd
costs roughly **2.7x** what a venue-clustered one does, because the expensive part is computed
once per fifty-metre cell and shared by everyone standing in it. Scattering is precisely what
defeats that sharing. The ratio is the property of the code and it is the one that survives being
run on somebody else's machine.

Give absolute numbers only with the machine attached, because the two runs in `docs/PRESENCE.md`
disagree by 40%. A laptop recorded ~50 ms clustered and ~115 ms scattered per second at five
thousand sessions; a re-measurement on 2026-09-07, on a dev machine that had been running test
suites and three review agents all day, gave p50 **59 ms** clustered and p50 **162 ms** scattered.
Quote the re-measurement and name it as a loaded machine — this is a hardware gap, not a
regression. Do not quote "about 115 ms": it is not a fair description of 162 ms, and the older
figure is the one a demo audience will write down.

The slice budget is 8 ms and the longest contiguous hold measured is **12.2 ms**. Both are true
and the second is not a violation of the first: the tick checks the clock every thirty-second
session (that is, every 32nd) rather than every one (`src/presence/service.ts:620`), because reading it five thousand
times would cost a measurable share of the budget it is policing — so a slice can run past 8 ms
before the next check sees it. Slicing bounds the block; it does not pin it under the budget.

One number to know before somebody else finds it: scattered p95 was 211 ms, which is *above* the
200 ms rung-1 degradation threshold. That run stayed on rung 0 with no skipped ticks, but on a
machine like that one the scattered layout sits at the boundary rather than comfortably inside it.
Re-measure with `scripts/benchmarks/presenceTick.ts` before quoting any of this at an event.

The privacy rules are the part worth being proud of:

- Positions are fuzzed to a twenty-metre grid, published one tick late, and never stored.
- Three things read an exact position — `GET /presence`, SOS dispatch, and the lead roster —
  and all three write an audit row *before* the data is returned, so a failed audit is a
  failed read.
- The shift roster reports buckets (`at venue` / `nearby` / `away`, `now` / `recent` /
  `stale`) and never a coordinate.
- Opting out is symmetric **on the map**: you neither appear nor receive a frame.

**Volunteer the asymmetry, and give both halves of it.** An opted-out *lead* still reads exact
positions two ways: the shift roster, and `GET /presence` once per five seconds — neither checks
the reader's own opt-in, and both write an audit row. That is deliberate, because a lead has to be
able to find somebody in an emergency whether or not they want their own dot drawn. Saying only
"the roster" understates it, and this bullet said "symmetric" flatly until `README.md` and
`docs/PRESENCE.md` were corrected and this page was missed.

## 7. The campus

Five by five kilometres of Urbana-Champaign, 9,188 buildings, baked from OpenStreetMap into
124 five-hundred-metre tiles that stream as the camera moves. Fourteen landmarks are
territory gyms with hand-written silhouettes.

`npm run campus:check` re-derives the index hash from the tile contents and compares it, so
the bake is reproducible and a hand edit is detected. Run it — it takes a second and it is a
good answer to "how do you know the data is right".

Heights: **88.5% are a per-type default.** 773 come from surveyed levels, 292 from OSM tags,
and lidar is a step you run yourself. The README used to imply the good sources dominated.

## 8. The gauntlet, which you have to be standing there to win

In the shipped `hackillinois-2027` pack, control points alone no longer take a rival gym. Grind
one down and it stops at 1 CP with *"down to its last point. Win its coding challenge to take
it."* The flip needs a challenge win, answered from inside that gym's geofence. Reinforcing an
ally and taking neutral ground are untouched — gating those would break the first thirty seconds
of play for the sake of the last one.

**On stage, in order.** Open **Campus** and walk the trainer to a landmark another faction holds
(WASD or the arrow keys; the radius is this pack's 75 m). Click the landmark and press **Engage**
— or open the same gym from the **Turf Wars** list. Press **FIGHT**, which is 150 CP a strike,
until the message says the gym is on its last point: show that before you open the challenge,
because it is the only visible evidence the rule exists. Then press **CHALLENGE**. The prompt and
a countdown replace the message box; the countdown runs off the server's `expiresAt` rather than a
timer the browser started, because the browser clock is not evidence and the server refuses a late
answer either way. Answer, Submit. On a win the client spends the win immediately and the gym
flips in the same breath.

Which question a gym asks is a sha256 of the gym's id, so the same gym always asks the same thing.
You can rehearse against the real one, and a player cannot reroll until they get one they know.
The shipped pack has five, `PREDICT_OUTPUT` and `MULTIPLE_CHOICE`, with 3–5 minute clocks.

**Say what the judge is, plainly, before somebody assumes something better.** Normalise the
submitted text, HMAC-SHA256 it under the pack's own `answerSalt`, compare against a digest that
shipped in the pack with `timingSafeEqual`. That is the whole judge. Nothing is executed — no
`vm`, no worker, no container, no new dependency — so there is nothing to sandbox. **It verifies
answers, not programs.** Reading a snippet and predicting what it prints is a real filter; calling
it a code runner would be a lie, and it is the kind of lie that outlives the person who told it.

Three guarantees the database makes rather than the service, each one line to point at:

- One open attempt per account, from a partial unique index on the account plus an `openKey`
  that is a constant while OPEN and null afterwards — `src/models/challengeAttempt.model.ts`.
  Twenty concurrent starts produce one attempt and nineteen duplicate-key errors.
- A win is a single-use token: the spend is a conditional update from WON to SPENT, so twenty
  requests carrying the same attempt id produce one capture and nineteen conflicts.
- The geofence is checked at start **and** at submit (`src/services/gauntlet.service.ts`), and a
  third time by the capture, which is the ordinary `GymService` path with a `viaGauntlet` flag
  rather than a second capture implementation. Checking only at the start lets you answer from the
  bus; checking only at submit lets the question set be harvested from anywhere.

**If they push** — and these are worth getting in first, because each of them is findable in ten
minutes by anyone who downloads the pack:

- **Every player of a challenge sees the same input**, so the answer is a constant and travels in
  a group chat. Deriving the input per attempt is the fix and it would move challenge authoring
  out of the pack and into server code. It is not built.
- **The salt stops the answer being read, not guessed.** `answerSalt` sits in the pack file, and
  the pack directory is served publicly under /dashboard/content, so anyone can hash candidate
  answers against it offline until one matches — and "what does this print" has a small answer
  space. It is keyed on the pack rather than on `QR_HMAC_SECRET` deliberately: that secret is
  regenerated on every non-production boot, so a pack keyed on it would stop judging correctly the
  next morning.
- **What actually bounds cheating is physical**: two geofence checks, a server-side deadline, one
  submission, one open attempt at a time. And on a laptop the geofence is the sprite you walked
  there, which is the same spoofing gap §4 already admits and has the same answer — a convenience
  check, not an attestation.
- **Backing out does not close the attempt.** The Back button leaves it OPEN with the clock
  running, and no other attempt can be started until it expires — up to five minutes in this pack.
  Do not press it during a rehearsal you intend to repeat.
- **The plaintext answers are not shipped.** They live in `design/challenges/hackillinois-2027.json`,
  which `npm run gauntlet:hashes` reads to write the digests into the pack, and which the
  `Dockerfile` does not copy. The generator refuses to write a pack in which a `PREDICT_OUTPUT`
  answer appears anywhere a player can read.
- A gauntlet capture pays the ordinary gym karma — 35% of the power spent, through the existing
  `GYM` source and its existing daily cap. Not a new source key: a pack that declares a source it
  does not price refuses to boot, so a new key would break every fork on the next pull. The pack's
  `rewardKarma` is reported by the submit response and nothing pays it.
- A pack that ships no `challenges.json` — `content/example-campus` does not — captures on control
  points exactly as before, and the flag defaults off so a fork keeps the behaviour it had. But the
  **CHALLENGE** button is still drawn on every rival gym there, and pressing it gets "This event
  ships no coding challenges." That is the enabled-button-that-always-fails shape this repository
  has fixed twice elsewhere, and it is not fixed here.

---

## What to say about how it was built

The suite is 35 files and 390 tests as of 2026-09-07 — a snapshot, not a claim; `npm test`
prints the authoritative figure — and the interesting ones are invariants rather than
coverage: fifty racing registrations against two seats, ten concurrent bounty reservations
against a budget for three granting exactly three, twenty phones on one sponsor poster
producing one winner and nineteen refusals, twenty simultaneous starts on one gym's challenge
opening exactly one attempt, a lead who cannot spin another player's HackStop, a roster that
reports buckets and never a coordinate.

`npm run e2e` is the other half: it drives the real HTTP surface of a running process with
real cookies and real concurrency, and asserts the same invariants end to end. It is worth
mentioning that it **waits out the rate limiter** rather than disabling it — fifty phones on
a campus are fifty addresses, but a single-host acceptance run is one, so the run sleeps
through the 30/min sign-in window on purpose. What it exercises is the code an attacker
would meet.

### The failures worth admitting

An interviewer who asks "what did you get wrong" should get real answers. These were all
found in this repository, by review and by the end-to-end run, and fixed:

- The committed-default `ORGANIZER_SECRET` stayed live on every non-production boot while
  the other two secrets were randomised. That string minted a claim code for any account,
  and a claim code is a session. One request from anywhere to ADMIN.
- Check-out wrote `COMPLETED` with no precondition on the state it was leaving, so a
  volunteer who checked in and then cancelled had their row walked forward into a seat that
  had already been given to somebody else.
- Three of the seven karma sources had no daily cap, and the cap lookup fails *open*, so
  they were minting without limit. The shipped fork template had no caps at all.
- The demo's own three-way trade ring was seeded so that two of its legs handed a volunteer
  an uncertified shift. Cycle detection found the ring on every run and correctly refused it.
  Every swap test passed throughout, because the unit suites build their own fixtures and
  nothing tested the seed.

The last one is the best story: **the tests tested the code and nobody tested the demo.**
That is now `tests/seededDemo.test.ts`.
