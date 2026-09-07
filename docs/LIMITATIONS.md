# What is not solved, and why these numbers

Everything here is known, deliberate and unfixed. It exists as one page because the honest
answer to "what would you do differently?" should not have to be assembled from twelve
scattered comments under interview pressure — and because a list like this is more convincing
than a README that only describes what works.

Two things this page is **not**: it is not the review log (`docs/REVIEWS.md` records what was
found and fixed across thirteen rounds), and it is not a roadmap. These are the things a
careful reader will find, stated before they find them.

---

## 1. The gaps that are real

### The reserve path can leave `filledSlots` one too high, and nothing repairs it

`RegistrationService.reserveShift` increments `Shift.filledSlots` with a conditional update and
then inserts the registration row. Those are two documents, and there are no multi-document
transactions on this path (the swap engine is the exception, and it pays for a replica set to
get them). A process that dies between the two leaves the counter claiming a seat that no row
occupies. The seat is lost until someone notices.

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

### Timezone is hard-coded to `America/Chicago`

`chicagoDayRange` in `src/services/registration.service.ts` decides what "today" means for the
8-hour daily fatigue cap, and the ledgers key their `day` field the same way. The value is a
literal, not a pack setting.

Everything else about running this for another event is in a content pack
(`docs/FORK_GUIDE.md`), so **this is the one thing a fork cannot configure**, and a fork in
Berlin would compute its day boundaries against Illinois midnight. It belongs in
`event.json` beside the karma caps. It is called out here because the fork guide currently
implies packs cover everything.

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

Three cases, all bounded by the 120-second store expiry and none of them instant:

- **A handover leaves a ghost.** The client stops without telling the server (deliberately —
  the cookie already belongs to the new account, and a `DELETE` from there would erase *them*),
  so the departing account's last fuzzed position lingers until the idle sweep or expiry.
- **`DELETE /presence` is not sticky against an open WebSocket.** It removes the entry and drops
  the SSE session, but a socket that keeps publishing recreates the entry, because the
  database's `presenceOptIn` is untouched by that route. Only a client that also closes its
  socket — which the shipped one does — makes it hold. `PATCH /me/presence { optIn: false }` is
  the one that persists.
- **Going off shift hides you within a tick or two, not immediately.** `onDuty` is refreshed
  from a 30-second roster read and applied on the account's next sample, so a stationary
  volunteer whose shift has just ended can remain visible to ordinary viewers briefly.

`docs/PRESENCE.md` describes all three as immediate. They are eventual, within two minutes.

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
