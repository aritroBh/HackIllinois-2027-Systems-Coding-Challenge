# What is not solved, and why these numbers

Everything here is known, deliberate and unfixed. It exists as one page because the honest
answer to "what would you do differently?" should not have to be assembled from twelve
scattered comments under interview pressure — and because a list like this is more convincing
than a README that only describes what works.

Two things this page is **not**: it is not the review log (`docs/REVIEWS.md` records what was
found and fixed across seventeen rounds), and it is not a roadmap. These are the things a
careful reader will find, stated before they find them.

---

## 1. The gaps that are real

### The reserve path can leave `filledSlots` one too high, and nothing repairs it

`RegistrationService.reserveShift` increments `Shift.filledSlots` with a conditional update and
then inserts the registration row. Those are two documents, and there are no multi-document
transactions on this path (the swap engine and the SOS bounty debit are the two exceptions,
and they pay for a replica set to get them). A process that dies between the two leaves the
counter claiming a seat that no row occupies. The seat is lost until someone notices.

The compensating decrement lives in a `catch`, and a rejected promise cannot prove the write
did not land — so the compensation is best-effort, not a guarantee. **What is missing is not
the fix but the detection:** nothing in production reports counter drift. The reconciliation
this wants is a periodic job comparing `filledSlots` against
`countDocuments({ shiftId, status: { $in: [CONFIRMED, CHECKED_IN] } })`, alarming on a
mismatch and repairing it — cheap to write, and deliberately not written rather than written
untested. The proper fix for the class is an outbox: write the intent and the row in one
document, and let a worker apply it.

`scripts/benchmarks/loadtest.ts` audits the counter under load, which is how the invariant is
currently known to hold. That is a test-time check, not a production signal.

### A geofence cannot tell a spoofed GPS fix from a real one

Check-in and gym capture both compare a **client-supplied** coordinate against a venue. A
scanner that sends the venue's published latitude and longitude satisfies the check from
anywhere on earth. The geofence is a guard against honest mistakes and casual cheating, not an
attestation.

Closing it properly means binding the scan to the *scanner* rather than to the coordinates it
claims: a desk device with its own credential, or a token minted against a reading the server
trusts. `POST /attendance/verify` already requires `SHIFT_LEAD`, which limits who can be at
that desk in `AUTH_MODE=required`; it does not make the coordinate honest.

### The fatigue cap ignores the pack's timezone

`chicagoDayRange` in `src/services/registration.service.ts` decides what "today" means for the
8-hour daily fatigue cap, and it writes `America/Chicago` as a literal.

The pack already carries the right value. `event.timezone` is required by `src/content/schema.ts`,
`docs/FORK_GUIDE.md` tells a fork to set it, and the two ledgers honour it: `eventDay` in
`karmaLedger.model.ts` and `eventDayKey` in `bounty.service.ts` both format against
`pack.event.timezone`. The fatigue cap is the one rule that reads past it.

That is worse than a missing setting rather than better. A fork in Berlin sets its timezone,
watches its karma and bounty days land on the right nights, and never learns that the
daily-hours cap is still cutting its day at Illinois midnight. The fix is an argument, not a
new pack field — it is unwritten here rather than written untested, like the reconciliation
above.

### Multi-document crash windows, accepted as a class

Between any two writes there is a window where a crash leaves the pair inconsistent: an
attendance row with no payout, a booth scan recorded with the reward not yet granted. Each has
a compensating path, and the paths that matter are ordered so the survivable failure is the one
that happens (see the ordering argument in `src/services/checkin.service.ts`). The general fix
is an outbox, and patching individual windows would only move them.

### `SWAP_PENDING` is defined and never written

The status exists in the model and is treated as schedule-occupying, but swaps rewrite the
registration in place, so nothing sets it. Anyone wiring it up must change
`CheckInService.generateToken` and `verifyAndCheckIn` — which accept only `CONFIRMED` and
`CHECKED_IN` — at the same time, and must cancel the pending swap on check-in, or a trade could
hand the shift away underneath an attendance row. Noted at both ends in the code.

### A published heading is derived from the unfuzzed track

When a client does not supply a heading, the server computes one from the difference of two
**exact** positions and publishes it beside the **fuzzed** one. It is quantised to a byte
(~1.4°) on the wire, so it is not a position and does not by itself invert the 20 m grid — but
it is a quantity derived from coordinates the layer otherwise promises never leave memory, and
enough of them describe a path more precisely than the fuzz intends. Deriving it from the
published track instead would close it, at the cost of a sprite that turns in 20 m steps.

### Presence entries outlive the event that should end them

Three cases, none of them instant. The first two are bounded by the store's 120-second expiry;
the third is bounded by a fifteen-minute grace in the roster read, which is far longer:

- **A handover leaves a ghost, but only on the fallback.** The client stops without sending a
  `DELETE` (deliberately — the cookie already belongs to the new account, and a `DELETE` from
  there would erase *them*). On the WebSocket path that costs nothing: closing the socket is
  itself the signal, and the service drops the store entry when an account's last session goes.
  On the SSE fallback there is no socket whose closing anybody could notice, so the departing
  account's last fuzzed position lingers until the idle sweep reaps the session, sixty to
  ninety seconds later.
- **`DELETE /presence` is not sticky against an open WebSocket.** It removes the entry and drops
  the SSE session, but a socket that keeps publishing recreates the entry, because the
  database's `presenceOptIn` is untouched by that route. Only a client that also closes its
  socket — which the shipped one does — makes it hold. `PATCH /me/presence { optIn: false }` is
  the one that persists.
- **Going off shift does not hide you for at least a quarter of an hour.** The roster read
  counts a volunteer as on duty from fifteen minutes before their shift until fifteen minutes
  after it, and counts a `CHECKED_IN` registration as on duty whatever the clock says. Only
  once that grace has run out does the 30-second roster refresh drop them, and the new answer
  reaches the map on their next accepted sample. The grace itself is deliberate — somebody
  walking off a shift is still on the floor, the same reasoning as `ON_DUTY_GRACE_MS` for
  dispatch — but it is minutes, not ticks.

`docs/PRESENCE.md` reads as though each of these is immediate. They are eventual: the first two
within two minutes, the third not until the roster's grace has expired.

### `store.cells` never deletes an emptied cell

The spatial index removes an id from its cell's set but never deletes the set when it empties,
so the map grows monotonically. It is bounded by campus geometry — the bounding-box gate refuses
any sample outside it, so the key space is a few thousand cells, not the globe — which is why it
is recorded here rather than fixed.

### `presenceAudit`'s `lead-view` reason is designed and unbuilt

The union member exists; no route writes it. Left in place so a future per-player lead view has
an audited reason already named, and flagged in the model so nobody reads its presence as
evidence the path exists.

---

## 2. Why these numbers

Every constant below is a judgement call. None is derived from data, because there is no data
yet — the event has not run. They are written here with their reasoning so that "why 30 and not
15?" has an answer that is not improvised.

| Constant | Value | Where | Why this value |
|---|---|---|---|
| Rest buffer | 30 min | `REST_BUFFER_MS` | Long enough to cross the Quad between two buildings and eat something; short enough that a volunteer can work a morning and an afternoon shift without the scheduler refusing them. Note the arithmetic consequence recorded in `checkin.service.ts`: because the buffer permits a gap of *exactly* thirty minutes, two adjacent shifts can both be inside their check-in windows at once. |
| Daily fatigue cap | 8 h | `MAX_DAILY_HOURS_MS` | A working day. The cap is about the organisers' duty of care at a 36-hour event, not about throughput, and 8 is the number a university would recognise if asked to justify it. |
| Geofence radius | 75 m | `GEOFENCE_RADIUS_METERS`, `geo.ts` | Consumer phone GPS is routinely 10–30 m out and worse indoors, which is where every one of these venues is. A radius under about 50 m rejects honest people standing at the desk; much above 100 m starts to include the next building. 75 m is the middle of that band. It is not a security boundary — see the spoofing note above. |
| Check-in grace | ±30 min | `CHECK_IN_GRACE_MS` | Volunteers turn up early and desks run late; refusing somebody standing in front of you because the clock says 16:31 would make the rule the reason attendance goes unrecorded. Matches the rest buffer so the two cannot disagree. |
| On-duty grace for dispatch | 30 min | `ON_DUTY_GRACE_MS` | A volunteer who has just finished a shift and not yet checked out is still on the floor and still the nearest responder. Without it, dispatch would skip the people physically closest to an incident. |
| SOS escalation | 3 min | `escalateStale` | Long enough that a responder walking across a building is not written off; short enough that a medical call is not sitting unacknowledged. |
| Presence tick | 1 Hz, 8 ms slice budget | `PresenceService` | One second is the slowest update that still reads as "live" on a map. The slice budget keeps the tick off the event loop for long enough to matter to unrelated requests; measurements are in `docs/PRESENCE.md`. |

**If this ran for real,** the first three would be the ones to revisit with data: the rest
buffer and fatigue cap against how many legitimate sign-ups they actually refuse, and the
geofence radius against how many honest check-ins it rejects at each venue.

---

## 3. Things deliberately not built

- **No Redis, no multi-process presence.** One Node process holds every WebSocket and the tick.
  Presence state is in memory; a restart drops it, and the clients re-publish within a second.
  This is sized for one event of a few thousand people, and the cluster fallback is the escape
  hatch if that assumption breaks.
- **No background sync or offline write queue.** An offline claim, check-in, SOS or swap fails
  loudly while the volunteer can still react. A queued reservation replaying minutes later
  against a slot somebody else has taken is worse than an error message.
- **No email/SMS delivery guarantees.** The magic-link send is dispatched, not awaited — that
  is deliberate, so the response time does not disclose whether an address exists — and a
  failure is logged rather than retried.
- **Positions are never persisted.** No history, no replay, no heat maps. Anything that wanted
  those would be a new design decision, not a feature toggle.

---

## 4. Where the rest is written down

| Question | File |
|---|---|
| What did external review find, and what was wrong about it? | `docs/REVIEWS.md` |
| What are the concurrency primitives and why those? | `docs/DATA-MODEL.md`, `ARCHITECTURE.md` §3 |
| What does `AUTH_MODE=legacy` permit, exactly? | `docs/IDENTITY.md` |
| Who can read whose position? | `docs/PRESENCE.md` |
| What should an operator watch? | `docs/DEPLOYMENT.md` |

## Checkout writes badges that no ledger row backs

`StickerService` is documented — in `docs/DATA-MODEL.md`, in `src/models/stickerLedger.model.ts`
and in the service's own header — as the only way a row enters the sticker book, with
`Volunteer.badges` as the denormalised copy and `StickerLedger` as the auditable record behind
it. That invariant is what makes an award reconstructable and a duplicate detectable.

`CheckInService.checkOut` does not go through it. On a check-out between 02:00 and 05:00 UTC, or
one whose surge multiplier reached 3.0, it pushes a string straight into `Volunteer.badges` with
`$addToSet` and writes no ledger row at all. Two consequences, and the second is the worse one:

- **The audit trail has holes by construction.** A badge earned this way cannot be dated,
  attributed, or explained, and an audit that reconciles `badges` against `StickerLedger` will
  always show a discrepancy that is not a bug in the audit.
- **The strings are not stickers.** `MIDNIGHT_KRAKEN` and `SIEBEL_GUARDIAN` are `PrestigeTier`
  members, not ids from `memorabilia.json`. So the badge array mixes two vocabularies — earned
  sticker ids and prestige-tier names — and anything rendering it has to know both. The seed
  writes tier names into `badges` as well, which is where the pattern came from.

Not fixed here because it is a data-model decision rather than a defect with an obvious repair:
either those two become real memorabilia entries awarded through `StickerService`, or `badges`
is formally two fields. Both change what the offline card and the leaderboard read, and both
want the owner's agreement first. Recorded rather than left for the next reader to rediscover.

The hour comparison used to be in UTC as well, so "2 a.m. to 5 a.m." was 8 p.m. to 11 p.m. at a
Chicago event and the graveyard badge was unreachable by the graveyard shift. That half is fixed:
both it and the surge curve read the event's wall clock through `src/common/utils/eventClock.ts`, and
the clock is shared rather than copied so the next thing that needs it cannot drift from them.

What remains open here is only the ledger question above — which badge strings belong in
`Volunteer.badges`, and whether an award without a `StickerLedger` row is acceptable.
