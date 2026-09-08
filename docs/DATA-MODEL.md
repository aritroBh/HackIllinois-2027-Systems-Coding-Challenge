# The data model

Twenty-four collections. `ARCHITECTURE.md` §2 draws the entity-relationship diagram for the
scheduling core; this page is the complete list, including the ledgers, the auth tables and the
audit tables that the ERD does not draw, and it explains *why each one exists as its own
collection* rather than as a field on something else.

If you only read one section, read **[The three primitives](#the-three-primitives)**. Almost
every design decision below is one of those three, and knowing which one a collection is makes
the rest of it predictable.

## The three primitives

Multi-document transactions are used in exactly **three** places, and everywhere else is built
from three single-document mechanisms that MongoDB guarantees on its own. The three are
`SwapService`'s bilateral swap and its cyclic rotation (`session.withTransaction` directly), and
SOS ticket creation, which goes through `withTransactionRetry` so that reserving the bounty
against the daily budget and inserting the ticket either both happen or neither does. Those
three are why `docs/DEPLOYMENT.md` insists on a replica set: MongoDB offers transactions only
there, and a standalone `mongod` boots cleanly and then fails exactly these paths at runtime.

The mechanisms everything else uses:

| Primitive | What it buys | Where you see it |
|---|---|---|
| **A unique compound index** | "at most one of these, ever" — enforced by the database, not by a check in application code that two concurrent requests can both pass | `boothScan(accountId, boothId)`, `stickerLedger(accountId, stickerId)`, `karmaLedger(accountId, source, day)`, `questProgress(accountId, questId, windowKey)`, `raidJoin(raidId, accountId)`, `powerup(volunteerId, itemType)` |
| **A conditional update (CAS)** | "change this only if it is still in the state I read" — the check and the write are one operation, so there is no window between them | `Shift.filledSlots` against `capacity`, every `Registration` status transition, `PowerUpInventory.quantity >= 1`, `BountyLedger.spent` against the daily budget, `ChallengeAttempt` from `WON` to `SPENT` |
| **A TTL index** | "this row deletes itself" — no sweeper job, no cleanup bug, no unbounded growth | `claimCode`, `authToken`, `reservationLock`, `idempotency`, `announcement`, `presenceMute`, `presenceAudit` |

The recurring reason for a separate collection is the first one. A cap, a cooldown or a
once-ever rule expressed as a field is a read-then-write; expressed as a unique index it is a
fact the database refuses to duplicate. That is the difference between "we check whether they
already scanned this booth" and "they cannot scan this booth twice".

---

## Identity and sessions

### `volunteer`
The account. One document per person, whether they staff shifts or attend the hackathon —
`kind` (`VOLUNTEER` | `HACKER`) is the axis that separates them, and `role`
(`VOLUNTEER` | `SHIFT_LEAD` | `ORGANIZER` | `ADMIN` | `HACKER`) is what authorisation gates read.

Carries the denormalised counters the leaderboard and the offline card read without a join:
`karmaPoints`, `hoursServed`, `prestigeTier`, `badges`, `faction`, `avatarHash`.
`sessionVersion` is the revocation lever — bumping it invalidates every session cookie ever
minted for the account, because each cookie carries the version it was signed for and every
request compares them.

**Interview-relevant:** the counters are denormalised copies. The ledgers below are the record
of truth, which is what makes a disputed balance reconstructable rather than a matter of trust.

### `claimCode`
The badge adapter. An organiser mints one code per account; entering it once mints a session and
burns the code. **Only the SHA-256 of the code is stored**, so a leaked database yields nothing
typeable into the login screen. Codes are 10 characters of Crockford base32 — 50 bits, which at
the limiter's 30 guesses a minute puts the expected time to a hit around 10⁷ years. That is also
why there is no per-code attempt counter: a wrong guess matches no document at all, so there is
nothing to decrement. TTL on `expiresAt`.

### `authToken`
The email magic-link adapter, same storage discipline: only the hash is stored, 15-minute TTL,
burned on use (`usedAt`). The token travels in the URL **fragment** (`#magic=…`) and never in a
query string, so it does not reach server or proxy logs.

---

## Scheduling — the core of the challenge

### `shift`
A slot of work: time window, `location` (free text, resolved to a venue by a gazetteer),
`capacity`, `filledSlots`, `requiredSkills`, `baseKarma`, `manualSurgeMultiplier`.

`filledSlots` is a counter on the shift rather than a `count()` over registrations, and that is
deliberate: it lets the capacity guard be a single conditional update
(`$expr: filledSlots < capacity` with `$inc`), which is what makes fifty simultaneous requests
for two seats produce exactly two confirmations. A `count()` would be a read followed by a
write, and every one of the fifty would read the same number.

### `registration`
One person's claim on one shift, and the state machine that governs it:
`CONFIRMED` → `CHECKED_IN` → `COMPLETED`, with `WAITLISTED`, `CANCELLED` and `SWAP_PENDING` off
to the side. Every transition is a conditional update predicated on the state being left, never
a read-modify-save — a cancellation landing mid-flight then loses the race instead of being
silently overwritten.

The model file groups the statuses two ways, and the grouping matters more than the list:
**index-active** (`CONFIRMED`, `WAITLISTED`, `CHECKED_IN`, `SWAP_PENDING`, `COMPLETED` — the
five the partial unique index counts, so one row per shift and volunteer across all of them)
and **schedule-occupying** (`CONFIRMED`, `CHECKED_IN`, `SWAP_PENDING` — the three that block a
conflicting shift). There is no third, terminal grouping: `CANCELLED` is simply the one status
the index leaves out, which is what lets somebody who dropped out sign up again.

`SWAP_PENDING` is defined but never written today: swaps rewrite the registration in place.
Whoever wires it up must change `CheckInService.generateToken` and `verifyAndCheckIn` at the
same time, which accept only `CONFIRMED` and `CHECKED_IN`.

### `swap`
A proposed trade. Bilateral swaps and three-way (or longer) rings both live here. The cycle
finder keys its graph on **offers** (`volunteerId::shiftId`), not on volunteers: a person with
two pending proposals had the first one's edges overwritten by the second's when it was keyed by
volunteer, so the edge that formed the ring and the shift that got rotated came from different
proposals. Two of the three transactional paths in the system live here — the bilateral swap and
the cyclic rotation — which is part of why the deployment docs insist on a replica set.

### `reservationLock`
A short-lived per-volunteer mutex, held for the duration of a reservation. The rest-buffer and
fatigue checks are read-then-act, so two concurrent `reserveShift` calls for overlapping shifts
by one person could both pass validation before either wrote. The lock lives in MongoDB rather
than process memory so it holds across replicas. TTL on `expiresAt` is the safety net: a process
that dies holding one does not deadlock the volunteer.

### `idempotency`
Exactly-once semantics for reservations. Phones on congested event wifi produce requests that
succeed server-side and time out client-side; the natural client behaviour is to retry, and
without this table a retry double-books. A repeat carrying the same `Idempotency-Key` replays the
stored `responseBody` instead of re-executing, and the controller answers it `200` where the
first attempt got `201` — a difference it takes from the service's `cached` flag, not from the
record. `responseStatusCode` is written beside the body and read by nobody, so treat it as a
stored field with no reader rather than as part of the replay. `requestHash` is what stops one account replaying another's, because it is a digest over the
shift id, the volunteer id **and** `allowWaitlist` — so the same key sent for a different
request, or by a different person, is a conflict rather than a replay. `ownerToken` solves a
different problem: it fences a *stalled attempt* out of the record a later attempt has since
claimed. 24h TTL.

---

## Attendance

### `checkin`
One attendance record per registration: `checkInTime`, `checkOutTime`, `durationMinutes`,
`karmaAwarded`, `nonce`, `verifiedBy` and `verifiedByAccountId`.

Two unique indexes, and they mean different things. On `nonce`: a QR token is single-use, so a
photograph of one in a group chat is worthless. On `registrationId`: ten scanners racing with ten
*distinct* tokens would pass the nonce index and become ten attendances and ten payouts — this is
the index that stops that, and losing that race is not an attack, so the loser is handed the row
that won rather than an error.

The paid interval is clamped at **both** ends, though not symmetrically: the start is floored at
the shift's `startTime` exactly, and the end is capped at `endTime` **plus** the check-in grace.
That asymmetry is deliberate — arriving early is not work, but a shift that overruns by twenty
minutes is — so neither the early scan nor the forgotten tap-out is paid.

---

## The economy — why the counters are not the record

The README's claim is that karma is minted in exactly one place, capped per source per day, and
recorded so a disputed balance can be reconstructed. These collections are that claim.

### `karmaLedger`
One row per **(account, source, day)** holding what that source has already paid that account
today. The unique compound index is what makes the cap enforceable rather than advisory: two
concurrent awards cannot both pass a conditional `$inc` against one unique row, whereas both
would read the same total if the cap were a query.

`day` is a calendar key (`YYYY-MM-DD`) in the **event's** timezone, not UTC and not a timestamp.
A hackathon runs through the small hours; a UTC boundary would reset everyone's allowance in the
middle of the night.

The design note worth stating out loud: gyms had a per-volunteer cooldown, HackStops a per-beacon
one, check-out a time factor — three defences in three places, none of which stopped someone
walking a loop of twelve beacons all night. One spent-from row states the rule once, and the
per-feature cooldowns go back to being about pacing rather than about solvency.

### `bountyLedger`
One row per **(account, day)** holding karma committed to SOS bounties. Same argument, different
resource: the ceiling lives in the update predicate and the uniqueness in the index, so two
tickets raised at the same instant cannot both spend the last of the budget.

### `stickerLedger`
One row per **(account, sticker)**, plus *when* and *what earned it*. `Volunteer.badges` is the
denormalised copy the card and leaderboard read; this is the record behind it. Awarding is an
upsert against the unique index, so "give this hacker the Alma Mater pin" is safe to run twice,
from two rules, concurrently — the second is a no-op and the service reports it as not-new rather
than announcing the same sticker again.

### `boothScan`
One row per **(account, booth)**. The rule is "once per account per booth, **ever**" — not a
cooldown and not a daily cap, so neither the HackStop map nor the karma ledger can express it:
both forget. This collection is the memory and the unique index is the enforcement.

### `questProgress`
One row per **(account, quest, window)**. The window key is what makes a repeating quest
repeatable: "spin two beacons this hour" is not one quest with a timer, it is a new row every
hour — so yesterday's finished row stays finished and today's starts at zero with nothing having
to reset it. Event-long quests use the single key `event`.

### `raidJoin`
One row per **(raid, account)**. Nobody presses a join button: a raid is joined by doing the thing
the raid asks for while the window is open, so the row is written by a domain-bus listener rather
than by a request. That is the difference between a raid roster and a scoreboard filter — the
roster is a fact recorded at the time, so it survives the window closing, the account changing
faction, and the karma being spent.

### `powerup`
Consumable items. Stacked rather than row-per-item: one document per **(volunteer, itemType)**
with a `quantity`. Awarding is an upsert with `$inc`; consuming is a conditional decrement
(`quantity: { $gte: 1 }`), so a double-tap cannot spend an item the account no longer has.

---

## Operations

### `sosTicket`
A distress call: `hackerName`, `tableLocation`, `coordinates`, `category`, `urgency`,
`description`, `karmaBounty`, and a guarded lifecycle
(`OPEN` → `DISPATCHED` → `ACKNOWLEDGED` → `ON_SCENE` → `RESOLVED`, plus `CANCELLED`) with a
transition table rather than free assignment. `escalatedAt` is set once by the scheduler when
nobody acknowledges in time.

Creating one is the **third** transactional path: reserving the bounty against the day's budget
in `bountyLedger` and inserting the ticket go through `withTransactionRetry` together, so a
ticket never exists with budget uncommitted and budget is never spent on a ticket that failed to
insert.

**This is the most privacy-sensitive collection in the system.** It says where a named person is
and what is wrong with them. Reads are redacted for anyone who is not a proved lead or a party to
the ticket — and "proved" is load-bearing: see `docs/IDENTITY.md` and the review log, because the
sibling branches of that check have been the source of more findings than anything else here.

### `announcement`
A lead's broadcast to the floor. `audience` (everyone / volunteers / hackers / staff) is filtered
**on delivery by the server**, not by the client, so a staff-only message never reaches a hacker's
stream. TTL on `expiresAt`, because a stale "pizza is here" banner is worse than no banner.

---

## The game world

### `gym`
One of fourteen campus landmarks held as territory. `faction`, `defenders`, control points, and a
`version` field used for optimistic concurrency so two simultaneous captures cannot both win.

### `challengeAttempt`
One player's run at one gym's coding challenge. When a pack sets
`event.gauntlet.requiredForCapture`, taking a **rival** gym means winning one of these first;
ally and neutral play is unchanged, the flag defaults false in `src/content/schema.ts`, and a
pack that ships no `challenges.json` — `content/example-campus/` is one — never writes a row
here at all.

The row is both the state machine and the receipt: `accountId`, `gymId`, `challengeId` (which
challenge was served — the pick is a digest of the gym id, so re-opening asks the same question
rather than letting a player reroll), `status`, `openKey`, `startedAt`, `expiresAt`,
`answeredAt`, `spentAt`, `perCase`, and the `createdAt`/`updatedAt` pair from `timestamps`.
`perCase` is one boolean per test case, which is what lets a loser be told *which* case they
missed without being told the answer. No answer and no digest is ever stored on the row — those
live in the pack, and only as HMACs.

**The state machine.** `CHALLENGE_ATTEMPT_STATUSES` is `OPEN`, `WON`, `LOST`, `EXPIRED`,
`SPENT`, and every legal move is written by `src/services/gauntlet.service.ts`:

| From | To | Written by |
|---|---|---|
| *(insert)* | `OPEN` | `GauntletService.start`, after the geofence check |
| `OPEN` | `WON` / `LOST` | `GauntletService.submit`, after the *second* geofence check |
| `OPEN` | `EXPIRED` | `submit` when the deadline has passed, and the sweep in `start` that clears the caller's own lapsed rows before opening a new one |
| `WON` | `SPENT` | `GauntletService.spend` |

`LOST`, `EXPIRED` and `SPENT` are terminal — nothing writes a transition out of them, and
`submit` refuses any attempt that is not `OPEN`, which is what makes one submission per attempt
a fact rather than a convention.

**Why `WON` and `SPENT` are two states and not one boolean.** A win is a single-use token, and
burning it is a separate conditional update (`{ status: 'WON' }` → `SPENT`) from the one that
awarded it. Twenty requests carrying the same attempt id therefore produce one capture and
nineteen conflicts, decided by the database rather than by a read followed by a write. Collapsing
them into `WON` plus a `spent` flag would put that decision back in application code. State the
limit with it: `SPENT` records that the token was burned, **not** that the gym changed hands —
`GymController.spendGauntlet` burns first and then calls `GymService.battleOrContribute`, so a
capture that throws afterwards leaves a `SPENT` row and a lost win.

**Two declared indexes, and they are not doing equal work.**

- `{ accountId, openKey }`, unique, with `partialFilterExpression: { openKey: { $type: 'string' } }`.
  This is the "one open attempt per account" rule, and it is the same primitive as `boothScan`
  with one twist: the partial filter turns "at most one ever" into "at most one *at a time*".
  `openKey` holds the constant `OPEN_ATTEMPT_KEY` while the attempt is open and is set to `null`
  on every exit, and the filter keeps nulls out of the index, so finished rows accumulate without
  colliding. Twenty concurrent starts produce one insert and nineteen duplicate-key errors, which
  `start` translates into a `409`. `tests/gauntlet.test.ts` asserts exactly that.
- `{ accountId, gymId, createdAt: -1 }`, not unique. Its comment names two readers — "has this
  player already beaten this gym" and a cooldown after a loss — and **neither exists**: no query
  in the service filters on `gymId`, so today this index serves nothing that the single-field
  `accountId` index would not already cover. It is a slot for a rule that has not been written.

The schema also sets `index: true` on `accountId` and on `gymId` individually.

**`expiresAt` here is a deadline, not a TTL.** It is compared in `submit` and by the sweep in
`start`; there is no `expireAfterSeconds` on this collection and it is absent from the TTL row of
the primitives table for that reason. Rows are permanent. The open-attempt cap is bounded per
account, but finished attempts are never deleted and nothing sweeps them, so this collection
grows with play. For a weekend hackathon that is
fine; for a long-lived fork it is the first thing to add.

One caveat that belongs in a data-model page rather than in a release note: this model is **not**
exported from `src/models/index.ts`. That barrel is what `scripts/migrate.ts` and `tests/setup.ts`
import before walking `mongoose.models` to build indexes, so the migration does not sync the two
indexes above — in a fresh deployment they are left to Mongoose's background `autoIndex`, which
is the exact race the migration's own header argues against. The tests are unaffected because
`tests/gauntlet.test.ts` imports the model directly, which registers it before the index build.

### `hackstop`
A supply beacon with a 75 m geofence. Spinning one grants a power-up, rate-limited per beacon per
account, with the daily solvency ceiling enforced by `karmaLedger` rather than by the cooldown.

---

## Presence, media and audit

### `presenceAudit`
**Positions are never stored.** This collection is the record of *who read an exact position,
whose, and why* — one document per read, never one per row read. Deleted after 30 days by TTL.

Exactly three code paths can read an exact position (a lead's roster, a lead's `GET /presence`,
and SOS dispatch) and every one of them writes a row here. That pairing is the privacy claim the
README makes, and this collection is what makes it checkable instead of aspirational.

### `presenceMute`
The only place a mute lives. A sender whose samples exceed the speed gate three times running is
muted for 60 seconds; the TTL on `until` makes the document vanish on its own, and the presence
store re-reads it before `hello_ack` so a reconnect cannot dodge it.

### `avatar`
The pixel-art trainer face: `bytes`, `ownerId`, `status` (`PENDING` / `APPROVED` / `REJECTED` — the third set both by a
reviewer and by a flag takedown), `shareOptIn`,
`flags`. Several rows can share a `hash` (same pixels, different owners), so publication is
per-row. An unpublished avatar is readable only by its owner or a lead — **both proved by
session**, because the hash is broadcast publicly on the presence wire and account ids are public,
so an id-only check is not a check at all.

---

## What is deliberately not a collection

- **Live positions.** They are held in memory, fuzzed, published one tick late, and never
  written. There is no table to subpoena, leak or forget to purge.
- **Sessions.** The cookie is a signed token; validity is `sessionVersion` on the account,
  compared per request. Revocation is a counter bump, not a delete across a session store.
- **The campus geometry.** Baked into tiles under `content/<pack>/campus/` at build time and
  served as static files. It is content, not state.

## Where to look next

| Question | File |
|---|---|
| How does the capacity guard actually work? | `ARCHITECTURE.md` §3, `src/services/registration.service.ts` |
| Why is the waitlist a cascade? | `ARCHITECTURE.md` §4 |
| How do three-way swaps resolve? | `ARCHITECTURE.md` §6, `src/common/utils/cycleFinder.ts` |
| What stops a screenshotted QR code? | `ARCHITECTURE.md` §7, `src/services/checkin.service.ts` |
| What stops a gym being taken from off site? | `src/services/gauntlet.service.ts` |
| Who can see whose position? | `docs/PRESENCE.md` |
| What does `AUTH_MODE=legacy` permit? | `docs/IDENTITY.md` |
| What did external review find, and what was wrong? | `docs/REVIEWS.md` |
