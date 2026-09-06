# Review log

Per plan Part D §D3: after each milestone the diff is reviewed read-only by muse, opencode and agy
(scratch copy for muse/opencode with the tree hash checked before and after; agy from the real repo in
plan mode). Every finding is verified against the code before it is acted on. Verdict lines are the
reviewers' own; "fix" names the commit that closed the item.

## Round A — M1 review findings (2026-09-05), reviewed by the parallel session's cross-model round

| # | Finding | Verdict | Fix |
|---|---|---|---|
| C1 | Swap accept/propose acted as a caller-asserted body id (IDOR) | confirmed live | 1804119 |
| C2 | SSE hub read `process.env.AUTH_MODE`, desync under the `REQUIRE_AUTH` alias | confirmed live | 1804119 |
| C3 | Logout did not bump `sessionVersion`, old cookie kept working | confirmed live | 1804119 |
| C4 | Adonix login matched by email, letting a foreign SSO identity take over an account | confirmed static | 1804119 |
| C5 | Adonix HS256 tokens accepted without `exp` | confirmed live | 1804119 |
| C6 | `TRUSTED_EGRESS_CIDRS` skipped limiters instead of widening them | confirmed static | 1804119 |
| C7 | Anonymous SSE connections could exhaust the shared slot table | confirmed live | 1804119 |
| — | `GET /api/v1/content` mounted before the limiter stack | confirmed (app.ts:140 at 34a23e2) | 57dc111 |

Re-review of 34a23e2 by the parallel session: PASS (opencode + muse agreeing, live probes before/after).

## Round B — full M1+M2 delta (c3a03ce..57dc111), 2026-09-05

Reviewers: **opencode** `APPROVE WITH CHANGES — P0:0 P1:6 P2:5`; **muse** `REJECT — P0:3 P1:7 P2:4`;
**agy** `REJECT — P0:2 P1:1 P2:1` (second attempt; the first died on its headless shell-permission
problem). Scratch tree hash unchanged after the round.

| Finding | Source | Verdict after verification | Resolution |
|---|---|---|---|
| `POST /adonix/sync` ungated, rewrites shift times | muse P0, parallel session | confirmed | cc29274 (parallel session) |
| `GET /sos/tickets` returns every ticket incl. coordinates/table text to any signed-in account; populate leaks assignee email | muse P0 | confirmed | staff-only (`requireVolunteerKind`), populate `name role` |
| `GET /volunteers[/:id]` returns email/phone/identities/sessionVersion to anyone | muse P0 | confirmed | projection on /volunteers: PII lead+ only, identities/sessionVersion never (the same populate leak on GET /registrations and GET /swaps was missed here and closed in round 12) |
| `organizerOrSecret` fell through to legacy-permissive `requireRole`: anonymous legacy callers could mint claim codes | opencode P1, agy P0 | confirmed | anonymous → 401 outright |
| Adonix account tying: fragment auto-exchange links an attacker's token to a signed-in victim | agy P0 | confirmed | server requires `link: true` (409 `ACCOUNT_LINK_CONFIRM` otherwise); client holds the token and asks |
| `HEAD` exempt from the required-mode gate | opencode P1 | confirmed | only `OPTIONS` exempt |
| `revoke`/`setRole` do not evict the 60 s account cache | opencode P1 | confirmed | evicted |
| Any `SHIFT_LEAD` can revoke an `ORGANIZER` | opencode P1 | confirmed | role hierarchy; self-revoke allowed |
| `GET /stats/operations` open to hackers | opencode P1 | confirmed (intent: staff data) | `requireVolunteerKind` |
| Dispatch returns the full winner document (email/phone/identities) | muse P1 | confirmed | projected to id/name/role/faction |
| `POST /swaps/cycles/resolve` any volunteer (graph scan + transactional rotation) | muse P1 | confirmed | `requireRole('SHIFT_LEAD')` |
| `karmaBounty` has no ceiling | muse P1 | confirmed | `.int().min(50).max(500)` stopgap; M6 makes it pack-driven |
| memorabilia/monuments-info served but unvalidated | muse P1 | confirmed | Zod schemas, dossier keys must be monument ids |
| CSP lacked `worker-src`/`manifest-src`, allowed remote styles/fonts | muse P1 | confirmed | added; `https:` removed (fonts are vendored) |
| No `CSRF` on auth routes in-file | opencode P1 | **not a bug**: global `requireCsrf` precedes the router | test pins 403 `CSRF_INVALID` through real wiring |
| SSE tests only exercise a fake identity shim | muse P1 | confirmed | real-cookie authz test added |
| `example-campus` never loaded by tests | muse P1 | confirmed | test added |
| Heartbeat write ignores backpressure | agy P1 | confirmed | marks `lagging` like `write()` |
| `CLAIM_BRUTE_FORCE` alarm on the public `announce` channel | opencode P2 | confirmed | moved to `ops` (plan deviation, deliberate) |
| Credential exchanges not `no-store` | opencode P2 | confirmed | all four set it |
| CSV formula injection in bulk export | opencode P2 | confirmed | `=+-@` prefixes neutralised |
| `CONTENT_PACK`/`CONTENT_DIR` bypass the env schema; no path containment | muse P2 | confirmed | env regex + resolved-prefix check |
| Font family only stripped of quotes | muse P2 | confirmed | allow-list regex |
| Onboarding mapped error codes the server never sends | muse P2 | confirmed | `CREDENTIAL_INVALID` mapped |
| Cookie parser last-wins | agy P2 | confirmed | first-wins |
| Rate-limiter test title says "skips" | muse P2 | confirmed | renamed |
| Allow-list compares mount-relative paths | opencode P2 | accepted as-is: mounted under `/api/v1`, pinned by test | — |
| Leads bypass the body-id mismatch 403 | opencode P2 | deferred: body ids are ignored for sessions; lead act-on-behalf routes arrive in M5 | — |

Live probes at HEAD under `REQUIRE_AUTH=true` (alias path): `HEAD /shifts` 401, `OPTIONS` 204,
anonymous `POST /auth/claim-codes[/bulk]` 401, `GET /content` 200, SSE `sos` 403 / `announce` 200.

## Round C — M3 + M4 (57dc111..4652273), 2026-09-06

Reviewers: **muse** `REJECT — P0:1 P1:4 P2:8`; **opencode** `APPROVE WITH CHANGES — P0:0 P1:4 P2:3`;
**agy** produced no report (its headless mode auto-denies the shell permission it insists on;
a second run with absolute paths hit the same wall). Scratch tree hash unchanged after the round.

| Finding | Source | Verdict | Resolution |
|---|---|---|---|
| WebSocket per-account replacement freed the slot but never closed the socket, so one account could hold unbounded live connections | muse P0 | confirmed | a slot→client table closes the replaced socket with 1013; test asserts the third connection closes the first and the process count does not grow |
| `GET /presence`, the avatar queue and avatar review accepted a *claimed* identity in legacy mode, so naming a lead's id read everyone's exact position | opencode P1 | confirmed | new `requireSession` guard: those routes need a real session in both modes |
| Dispatch returned exact metre distances and the full candidate list to any caller — a ranging oracle against fuzzed positions | opencode P1 | confirmed | distances bucketed to 10 m and the candidate list withheld unless the caller is lead+; test pins both |
| Opting out left the existing entry broadcasting until it expired | opencode P1 | confirmed | the store erases the entry on an opt-out refusal, and `visible()` checks the flag |
| An identical upload by a second person aliased the first person's row, so one takedown cleared both | muse P1 | confirmed | one row per (hash, owner); unpublish touches only that owner |
| `toJsonRow` dropped `kind`, so every hacker rendered as a volunteer on the SSE fallback | muse P1 | confirmed | `kind` added to the JSON row and to the client decoder |
| The delegation probe posted to a route that does not exist, so it passed on a 404 | muse P1 | confirmed | points at `POST /attendance/:id/checkout` and asserts the victim's karma and status are unchanged |
| No tests for idx wrap, the hello timeout, the message bucket, or cross-transport replacement | muse P1 | confirmed | four tests added |
| The soak could not run its untrusted leg from one address, and the storm phase counted sockets rather than checking the sibling survived and full detail returned | muse P1 | confirmed | `--from` binds several source addresses round-robin, the storm asserts sibling survival and `notice{mode:'full'}`, and the report names which leg ran |
| Dispatch audit skipped when no live fix was used, and was fire-and-forget | muse P2 | confirmed | always written, and awaited |
| `GET /presence` ignored the `lat`/`lng`/`radiusMeters` it declares | muse P2 | confirmed | filter implemented |
| PNG dimensions checked only after a full decode | muse P2 | confirmed | IHDR pre-check before pngjs sees it |
| Tile ring was 5×5 per centre, and a far-orbit split view could hold two L0 sets | muse P2 | confirmed | 3×3 resident + prefetch ring; the player's ring is held at L1 when the camera is far away |
| Cluster dots flickered on cell boundaries | muse P2 | confirmed | membership hysteresis |
| Atlas eviction ignored the interest cap and kept departed hashes | muse P2 | confirmed | capped at 120, departed hashes evicted first |
| `recentUploads`, `recentFlags` and the per-lead listing map grew without bound | both P2 | confirmed | lazy sweeps |
| Three cheap accounts could censor any avatar | opencode P2 | accepted with mitigation | the plan chose three reporters; reports are now capped at ten per hour per account |
| Off-duty leads stayed visible to every viewer | opencode P2 | confirmed | hiding depends on the viewer's role, never the subject's |
| `docs/PRESENCE.md` said roster buckets are not audited, contradicting the plan | muse P2 | confirmed | corrected before M5 implements it |

Live after the fixes: 153 tests, the soak's storm phase passing its sibling-survival and
return-to-full-detail assertions.

## Final round — the scale work, the map work, deployment and the live bridge

Three reviewers on the same diff, each in a scratch copy of the tree. The copy was compared
byte-for-byte against a pristine extract of the reviewed commit afterwards: zero differences,
so every review was genuinely read-only.

Six findings were reached independently by more than one reviewer, which is the useful signal
here — those are the ones where the code, not the reader, was wrong. Each of the three also
found something the other two missed.

| Finding | Raised by | Verdict | Fix |
|---|---|---|---|
| The person who raised an SOS ticket could resolve it and collect their own bounty | agy | confirmed | the creator is refused outright; test raises, tries to self-resolve, and asserts nothing was paid |
| Only hackers were charged against the daily bounty budget, and any account may raise a ticket | muse | confirmed | every creator draws on the budget; test drives a volunteer past it and sees 409s, never 500s |
| A stale escalation put the raw table text on the public `announce` channel labelled as the venue key | all three | confirmed | resolved to a building key or null; two tests, one resolvable location and one not |
| In cluster-only mode the nearest sixty were withheld as rows *and* excluded from the counts, so a full room reported zero | opencode, agy | confirmed | the cohort carries a second, all-inclusive count list for viewers getting no rows |
| An off-duty volunteer subtracted itself from a crowd count it was never part of | muse, agy | confirmed | the adjustment applies only when the viewer is actually in the list it is adjusting |
| Expired players' slots were released before the frame was built, so no `expire` was ever sent | agy | confirmed | released slots queue and the next frame drains them; test asserts the frame arrives |
| Dispatch stopped one shell after the quota; a corner of ring R is √2·R away while an edge of ring R+3 is R+3 | all three | confirmed | continues until the next shell's nearest possible point is further than the worst held; new test fails against the old rule |
| Dispatch ignored opt-out entirely | muse | confirmed | the flag is checked; the promise made to somebody who opts out is now kept |
| The dispatch bound was 6 km against a 7.1 km pack diagonal | muse, opencode | confirmed | raised to 9 km, with the loop leaving long before it whenever anybody is findable |
| Props were placed with a `rot` key nothing reads, in degrees where radians were wanted | muse, opencode | confirmed | `ry`, converted; every bench had been facing east |
| Fences were passed world units to a builder that divides by ten again | muse, opencode | confirmed | a 1.2 m railing was rendering at 12 cm |
| Rooftop plant was handed options the generator does not read | opencode | confirmed | railings were all one 10 m square at a centroid; monuments got vents on their crowns |
| `fract(sin(...))` is not bit-identical across platforms, so the pack hash churned between ARM and x86 | muse | confirmed | hashes the coordinate bytes; two consecutive rebuilds now agree |
| The load ladder ordered a full snapshot from every session on the way *down* | muse | confirmed | only a climb resyncs; the shed-load mechanism was creating the largest burst of the event |
| A demoted lead kept lead vision until reconnect | opencode | confirmed | the flag is refreshed each tick from the cached facts |
| Comments asserting the opposite of the code: props not generated, props instanced, a 30 ms ladder | all three | confirmed | corrected rather than deleted |
| A crash between a booth scan's insert and its award strands the bounty | opencode | accepted, not fixed | the once-only guarantee is the important half and is sound; recovering a crashed award needs an outbox, which is a larger change than the window justifies |

Two lockstep checks were added because both of these fail in silence: every server event type
must be forwarded to the client bus and every forwarded name must be one the server emits
(`scripts/checkEvents.mjs`), and the renderer's metres-per-unit must match the pack's
(`scripts/checkProps.mjs`).

Live after the fixes: 208 tests, five consecutive clean runs, `scripts/verify.sh` green, the
pack rebuild byte-reproducible across runs.


## Round two — a re-review of the round-one fixes

The same three reviewers, on the diff that closed the previous round, against a fresh scratch
copy. The bar was different: not "is this code correct" but "is each of these fifteen claimed
fixes actually a fix, and did it introduce anything new". That is the round that found the
most, because a fix that moves a bug rather than removing it reads as correct.

| Finding | Raised by | Verdict | Fix |
|---|---|---|---|
| The middle rung of the load ladder left thirty neighbours in neither the rows nor the counts — the previous fix handled the top and bottom rungs and reproduced the bug in the middle | opencode, agy | confirmed | the cohort is built with the effective row budget, so its counts exclude exactly what is sent; the second count list is gone and a test asserts rows + counts accounts for everybody at every rung |
| The dispatch search ignored fuzz displacement: cells are indexed by the published position and ranked by the exact one, so somebody can be eighteen metres nearer than their shell implies | agy | confirmed | the floor allows for the pack's own fuzz grid; the existing fuzz test did not catch it because it set the published position equal to the real one, and now does not |
| A ticket nobody could be charged for still carried a payable bounty — a creatorless ticket in legacy mode, or a pack with the budget set to zero | opencode | confirmed | both file the ticket and attach no reward; the model's minimum of fifty made "no reward" unrepresentable, and the range belongs at the API boundary |
| Two simultaneous first-of-day tickets raced the ledger upsert and one got a 500 | opencode | confirmed | duplicates branch by collection as the plan says; twenty-way contention then exhausted five retries, so the bound is twelve with full jitter and genuine exhaustion is a typed 409 |
| A demotion took up to thirty seconds, not a tick: the per-tick refresh reads a cache with a life of its own | opencode | confirmed | the role routes invalidate it |
| The avatar service kept `ownerId` optional, so a future caller could reintroduce the wrong-row takedown the routes were fixed to prevent | opencode | confirmed | required |
| The crown-suppression guard was dead three times over and its comment promised protection it could not deliver | opencode | confirmed | removed, with the real reason stated: monuments never reach the tile building list |
| `?kind=ALL` let any signed-in volunteer enumerate hacker accounts | opencode | confirmed | lead-gated |
| The budget-exhausted message suggested raising a ticket without a bounty, which every layer rejects | agy | confirmed | reworded to something the reader can act on |
| The event checker's header claimed more than it checks | opencode | confirmed | scoped to the emit-forward-subscribe chain it actually walks |
| `hash01`'s quantum is centimetres, not millimetres, because its callers pass world units | opencode | confirmed | one word |
| One human holding two accounts can raise on one and collect on the other | agy | **accepted, not fixed** | closing it needs identity linking the event does not have, and every heuristic substitute refuses honest people to catch a rare dishonest one. It is bounded by the raiser's daily budget and leaves a row in both ledgers, so it is auditable rather than invisible. Stated in the code beside the guard it is a limit of. |
| A crash between a booth scan's insert and its award strands the bounty | opencode | **accepted, not fixed** | the once-only guarantee is the important half and is sound; recovering a crashed award needs an outbox, which is a larger change than the window justifies |

Writing the tests for these found three more that no reviewer saw: the shell scan walked the
whole square each ring rather than its perimeter, which is O(R³) and made one dispatch on an
empty campus nearly eight million cell lookups; a zero row budget popped an empty array and
read past its end; and two edits from the previous round had silently not applied, one of them
a security guard reverted by a snapshot restored during an A/B check.

Both accepted findings are recorded here rather than closed silently, because a reader who
finds them later should be able to tell a decision from an oversight.

---

## Round C — demo-readiness pass, 2026-09-06

Not a milestone review: a pass aimed at the question "what would embarrass us in front of
somebody who reads the code". Six reviewers — five internal (concurrency, identity/perimeter,
presence, SOS/privacy, economy/game) and **muse** on a hashed scratch copy (tree hash
`7066e8e0…` unchanged before and after) — plus a full documentation fact-check, plus
`npm run e2e`, which was written for this round and drives the live HTTP surface with real
cookies and real concurrency.

Verdicts: muse `CHANGES — 0 P0, 7 P1, 1 P2`. The internal reviewers reported 5 P0, 15 P1 and
~30 P2 between them, with several exploits executed rather than argued.

### Closed

| Finding | Source | Verdict | Fix |
|---|---|---|---|
| `ORGANIZER_SECRET` kept its committed default outside production while the other two secrets were randomised. `X-Organizer-Secret` is accepted regardless of AUTH_MODE, so the string in this repository minted a claim code for any account, and a claim code is a session. | identity reviewer, executed live | confirmed | 9619b05 |
| Check-out wrote `COMPLETED` with no precondition, resurrecting a registration cancelled while checked in into a seat already given to the waitlist | concurrency reviewer | confirmed, reproduced | 9619b05 |
| Check-in set the status with a read-modify-save, clobbering a cancellation that committed in the window | concurrency reviewer, muse | confirmed | 9619b05 |
| `cancelRegistration` accepted a `COMPLETED` row, took neither branch, and walked it backwards while `filledSlots` kept counting it | concurrency reviewer | confirmed | 9619b05 |
| `POWERUP`, `CHECKOUT` and `BOOTH` had no `karmaCaps` entry, and `capFor` fails **open** — three uncapped mints. `content/example-campus` had no `karmaCaps` at all. | economy reviewer, executed live | confirmed | d52b4de |
| The seeded three-way trade ring could never execute: two legs handed a volunteer an uncertified shift, so `executedCount` was always 0 | `npm run e2e` | confirmed | d52b4de |
| Seeded `filledSlots` disagreed with the rows (one shift claimed 2 filled seats with 0 registrations); a volunteer was waitlisted on a shift with a free seat | `tests/seededDemo.test.ts` | confirmed | d52b4de |
| In `legacy` mode a caller-asserted `volunteerId` satisfied `organizerOrSecret`, `revoke`, `setRole`, the lead PII projection and `/me` — and account ids are public | identity reviewer, executed live | confirmed | 5d8d2a1 |
| `GET /sos/tickets` returned coordinates, table text and hacker name to every volunteer, undoing the `sos` channel's own redaction | SOS reviewer + `npm run e2e` | confirmed | 5d8d2a1 |
| A lead could acknowledge a ticket and go on-scene but not resolve it, stranding it | `npm run e2e` | confirmed | 5d8d2a1 |
| A refused scan spent the token: a geofence miss left the volunteer's next honest scan reporting a replay attack | muse | confirmed | 6b2f1b4 |
| `GET /swaps` was the one list route with no `validate()` — `?status[$regex]=` reached Mongo as an operator object | identity reviewer | confirmed | 6b2f1b4 |
| `/auth/claim-codes` had no credential limiter, so guessing the organiser secret got the 600/min anonymous budget | identity reviewer | confirmed | 6b2f1b4 |
| Booth scan and quest settlement each removed their once-only guard in a `catch` that runs *after* the award, making a once-ever reward repeatable | economy reviewer, executed live | confirmed | ff45fc3 |
| `NEUTRAL` skipped the gym faction lock entirely, letting a bound account attack any gym including its own | economy reviewer, executed live | confirmed | ff45fc3 |
| The per-volunteer mutex could be released by a request that no longer held it | muse | confirmed | 1436a99 (parallel session) |
| Ten simultaneous scans of ten fresh tokens produced ten attendances and later ten payouts | parallel session, by writing the test | confirmed | d87a691 (parallel session) |

### Documentation, corrected in c03e552

The fact-check found 16 false, 13 misleading and 3 unsupported claims against 48 that were
true and well-supported. The ones that mattered: ARCHITECTURE.md described a **Tarjan
strongly-connected-components** implementation tracking `dfn[u]`/`low[u]` and a
canonical-rotation cycle hash — the code has never contained either, and an interviewer
asking to walk through it would have found nothing there. FORK_GUIDE opened with "nothing in
`src/` names a building" while `resolveVenue` reads a hard-coded UIUC gazetteer that makes
every check-in in a fork fail. PLUGINS.md described a sandboxed iframe slot, in the present
indicative, that does not exist anywhere in the repository. CONTENT-PACKS documented three
geofence knobs that nothing reads.

### Accepted, not fixed

Recorded so a later reader can tell a decision from an oversight. See the open list in the
session report: the dispatch distance oracle (10 m buckets against ~20 m fuzz), the audit row
that records `'dispatch'` rather than the reader, SSE authorisation snapshotted at connect,
the per-volunteer lock covering only `reserveShift`, the cascade's bare `catch`, the cycle
finder's handling of a volunteer holding two pending proposals, and the absence of a shift
time-window check on check-in.

---

## Round four — the files nobody had read, 2026-09-06

The first three rounds concentrated on the concurrency primitives, because that is where the
interesting failures were expected. Round four pointed **muse** and **opencode** at the files
those rounds had never opened, and took the standing list of verified-but-unclaimed findings
from the parallel session working in the same tree. Both reviewers ran read-only against a
scratch copy whose tree hash was verified unchanged afterwards.

Every fix below has a test, and every test was checked by reverting the fix and confirming it
goes red. The three that could not be given a deterministic test are named as such.

### Closed

| Finding | Source | Fix |
|---|---|---|
| A lead resolving a ticket collected the dispatched volunteer's bounty, badge and quest credit. Closing a call on a responder's behalf is a normal thing for a lead to do, so the payout went silently to the person with the power to take it. | agy | cdc7f0c |
| A shift already worked and paid could be registered for again while it was still open — `COMPLETED` sat outside the partial unique index. A fresh QR token, a second check-in and a second check-out paid twice, and each round consumed a seat permanently. | agy | cdc7f0c |
| The daily fatigue cap weighed only the day a shift *starts*. The overlap split exists to divide an overnight shift across the two days it spans; half of it was discarded, so seven hours booked on Saturday plus a 22:00–06:00 shift was thirteen hours in a day. | agy | cdc7f0c |
| `GET /shifts/:id` populated the name, certifications, karma and prestige of every confirmed and waitlisted volunteer, behind no middleware at all — while `/:id/roster` beside it is lead-only, session-only and audited. The gate was one path segment wide. | opencode | 86f5079 |
| `?kind=ALL` read the lead role off a *claimed* identity, so naming any lead's id in legacy mode enumerated every attendee account. The projection on the same handler already required a proved session. | opencode | 86f5079 |
| Dispatch quoted a distance measured to the **exact** position, bucketed at 10 m — finer than the 20 m fuzz grid. Anyone who can raise a ticket chooses its coordinates and any volunteer can dispatch it, so three tickets trilaterated a colleague to within the bucket, with the fuzz bypassed and no exact-read audit row anywhere, because no exact position was ever returned. | parallel session | 86f5079 |
| The dispatch audit recorded `readerId: 'dispatch'`, so every dispatch in the event collapsed onto one indistinguishable reader and `docs/PRESENCE.md`'s "who read whom and why" was untrue for that reader. | parallel session | 86f5079 |
| The candidate pool had no clock in it: a `CHECKED_IN` row from a shift that ended yesterday stayed a candidate for ever, so at 3 a.m. the "nearest on-duty volunteer" was somebody asleep — and the ticket was marked `DISPATCHED`, which stops anybody else looking at it. | parallel session | 86f5079 |
| `reassign` cleared every timestamp except `escalatedAt`, which the sweep filters on, so a ticket that escalated, was reassigned and was ignored again could never escalate a second time. | parallel session | 86f5079 |
| SOS resolution and quest completion both announced the *advertised* reward rather than the granted one, so a responder past their daily cap was told they had earned 150 while their balance did not move. | opencode | 86f5079 |
| `reindexWaitlist` wrote positions unconditionally, stamping a queue position onto a row a concurrent cascade had already promoted out of the queue — which the next cascade's `sort({ waitlistPosition: 1 })` reads as order. | muse, opencode | 86f5079 |
| The waitlist cascade's candidate probe caught everything, reading a replica-set stepdown or a dropped socket as "this candidate is busy" and silently passing over the head of the queue with no log and no retry. | parallel session | 86f5079 |
| Two settle writes on an idempotency record were unconditional, so an owner that stalled past the steal window could stamp its result over the stealer's, and the stealer's failure path could mark a committed record `FAILED`. | muse | 86f5079 |
| Two first-ever gym battles declaring different factions both read `faction == null` and both wrote, so one account fought a whole battle for a side it was not on. | opencode | 86f5079 |
| `allowWaitlist` and its `SHIFT_FULL` branch were unreachable over HTTP — the schema did not accept the field and the controller never forwarded it — so confirm-or-fail always queued instead, and a documented 409 was dead code. | opencode | 86f5079 |
| In the presence layer, a viewer subtracted itself from a cluster count it was already absent from, deleting a neighbour (and, where the cell held one other person, the whole cluster); and at rungs where the viewer fell outside `detail`, one person was excluded from the counts as a row and then never sent. | parallel session | e0c8964 |

### Corrected in the reviewers' own findings

Two reported findings did not survive checking, and are recorded because the reasoning
matters more than the verdict.

- **muse H2** described `reindexWaitlist`'s `save()` as writing a stale `status: WAITLISTED`
  back over a concurrent `CONFIRMED`. Mongoose sends a delta for a loaded document, so only
  the modified path is written and the promotion survives. The *position* was still stamped
  onto a row that had left the queue, which is enough to promote the wrong person next time,
  so the fix stands on the narrower ground.
- **agy F1** and **opencode F1** both described the quest settlement re-paying karma when the
  sticker award fails. That was true when they read it and had already been fixed in
  `ff45fc3` by the parallel session: `settle()` now carries a `paid` flag and un-completes the
  row only when nothing has moved.

### Accepted, not fixed

- **The crash window between a check-out's CAS and its payout.** `checkOutTime` is CAS-set
  first, and a crash before `awardKarma` leaves a closed check-in that the idempotent-replay
  guard reports as done, unpaid, with the registration stuck `CHECKED_IN`. Closing it needs an
  outbox, not a patch — the same shape as the booth-scan window already accepted above, and
  the same answer.
- **A demoted lead keeps lead vision for up to 60 seconds** through the account-facts cache.
  The role routes call `presenceService.invalidate` on a demotion, which closes the presence
  half; the residual window is the facts cache itself and is documented rather than removed,
  because a per-request account read is exactly the cost that cache exists to avoid.

### Test quality

The parallel session's criticism of `tests/scale.test.ts` was correct and is fixed: the
neighbour-accounting test re-derived the search span with the implementation's own formula and
asserted on the cohort's internal bookkeeping, so it could not have failed on either presence
bug — both of which live one layer out, in the per-session corrections. The replacement seats
thirty people inside a single cell, so the universe is not a function of the search geometry,
drives a real `PresenceSession`, and asserts on the frame the client receives: rows plus
cluster counts equal everybody but the viewer, at five rungs, with the viewer seated both at
the centre of its cell and on the rim — because the two corrections are triggered by opposite
seatings, and one seating alone tests only half of the fix.

---

## Round five — the client-facing services and the wiring, 2026-09-06

**muse**, **opencode** and **agy**, all three read-only on one scratch copy. The copy was
verified afterwards two ways: its tree hash matched the pre-review hash exactly, and a full
`diff -rq` against the commit it was taken from (`e0c8964`) showed no tracked file changed.

Verdicts: opencode 2 findings, muse 2 plus a stale comment, agy 7. Nine survived checking.
All three reported the presence layer, the SSE hub, the swap ring, the auth stack and the
rate limiter sound, which is the first round where the concurrency work drew no findings at
all.

### Closed

| Finding | Source | Fix |
|---|---|---|
| **`RaidService.subscribe()` and `RaidService.tick()` had no caller.** For the whole of M6 a raid window opened and closed in the pack with no `RAID_OPENED` and no `RAID_CLOSED` on the wire, and nobody was ever enrolled — `RaidJoin` stayed empty and every board reported zero joins. The scheduler's own docblock had promised since M6 that raid timers lived there. | agy | 128cea9 |
| Replay ignored the audience filter the live send applies. `announce` is the one channel needing no session, so reconnecting with a `Last-Event-ID` — anonymously — read back the last minute of staff-only announcements. The buffer recorded what was said and not who it was said to. | agy | 128cea9 |
| `GET /pokeshift/hackstops` returned `lastSpunUsers` on every beacon: an unauthenticated who-was-at-which-beacon-when timeline for the whole event, joinable against ids that are public by design, with no audit row anywhere. | opencode | 128cea9 |
| `POST /avatars/:hash/flag` used `requireAccount` rather than `requireSession`, and one lead flag unpublishes on its own. In legacy mode `?volunteerId=<any lead id>` censored any attendee's avatar in one unauthenticated request, and rotating the claimed id also walked past the per-reporter hourly cap. | agy | 128cea9 |
| `presenceService.invalidate()` deleted the cached facts, and the tick only acts when it *has* facts — so invalidating an account destroyed the evidence that would have demoted its live session. A lead demoted mid-event kept lead vision for as long as the socket stayed open. | agy | 128cea9 |
| Tier-2 dispatch checked only that a shift had not *ended*. A volunteer confirmed for tomorrow afternoon has an `endTime` in the future, so at 3.30 a.m. the ticket went to somebody not at the event — and was marked `DISPATCHED`, which stops anybody else looking at it. | agy | 128cea9 |
| The booth's compensating delete was guarded by a flag tracking the karma award alone, and the reward is three things. A booth paying zero karma that grants a power-up left the flag false, so a failure after the grant handed the booth back with the power-up already in the inventory, and the retry `$inc`d a second one. | muse | 128cea9 |
| `boothCatalog` validated `venue` and `powerUp` but not `reward.sticker`, so a pack typo surfaced as a 404 at scan time — after the karma had been paid — instead of at pack load. | muse | (see below) |
| Three stale comments: two claiming `POST /adonix/sync` is unauthenticated when it has been organiser-only since the identity round, and one of mine in `resolveTicket` saying the bounty follows the actor, directly above the code that makes it follow the assignment. | agy, muse | 128cea9 |

### Test quality

`tests/masterEndToEnd.test.ts` had nobody genuinely on duty at its SOS step — Ada checks out
in System 4 and every other registration is for a shift hours away. The old dispatch answered
that by sending the ticket to a volunteer whose shift was the next day, so the fixture passed
while describing something that could not happen. It now puts a certified responder on a shift
that is actually running, which is what it always meant.

`tests/wiring.test.ts` is new and exists for one class of defect: a function that works,
is tested directly, and is connected to nothing. Its tests assert the wiring — that the bus
listener is attached, that the scheduler job runs, that teardown detaches — rather than the
behaviour behind it, because the behaviour was never what was broken.

---

## Round six — the client and the toolchain, 2026-09-06

Five rounds had read the server. This one pointed **muse**, **opencode** and **agy** at
`public/`, `scripts/`, `design/pipeline/` and the pack — the code that had been reviewed
least and that the previous rounds' conclusions all depended on. Read-only on one scratch
copy, tree hash verified identical afterwards.

All three found the same thing first, independently.

### The geofence could not fail

`spinHackStop` and `battleGym` both sent `playerCoords() ?? <the target's own coordinates>`.
A client that had never placed its trainer therefore told the server it was standing exactly
on the beacon or the gym it was acting against; the server measured the distance from a point
to itself, got zero, and the 75 m check passed. `game.js` completed the circle by force-
*enabling* every Spin button in precisely the case where there was no position to measure —
its comment called that "the demo path, nothing to measure", which is true and is not a reason
to allow the action.

The effect is not a weak proof of presence but the absence of one: a fresh profile could spin
every beacon and contest every gym on campus from one chair, and the check written to stop it
could not fire. Both fallbacks are gone; the button now says what would enable it; and the
comment on `playerCoords` states plainly what a browser-supplied position is worth, which is
less than a GPS fix and considerably more than the target's own coordinates.

### A shared laptop kept the last person

`localStorage` and the service-worker cache both survive the reload that `logout` relied on,
and this is a hackathon: the laptops are shared. Left behind were a distress call's seat
number and the name attached to it (`nexus.sos.ticket`), a face drawn from somebody's
photograph (`nexus.avatar.v1`), a sticker book (`nexus.stickers.v1`), and the trainer card in
the worker's cache — which `sw.js` had a handler to purge on sign-out, listening for a message
that nothing in the repository had ever sent.

Logout now clears all four and waits for the worker to acknowledge, because posting a message
and calling `location.replace` in the same turn is a race the cache usually wins — which is
indistinguishable from never sending it, and is why the handler went years unnoticed. Two
further guards, because people do not log out at four in the morning: `setUser` clears the
same keys when the browser changes hands, and the remembered SOS ticket carries its owner's id
and is refused when it is not the reader's.

### Gates that could not fail

The most uncomfortable part of the round, because these are the things that were supposed to
be catching the rest.

| Gate | What it actually did |
|---|---|
| `verify.sh` "frontend syntax" | A hand-written list, nine files behind the per-tab split — including `views/sos.js`, which owns the SOS lifecycle, and `sw.js`, which owns offline. A glob now: 36 files, up from 22. |
| `verify.sh` × 2 | Two checks still ended in `2>/dev/null`, directly beneath a comment explaining that discarding stderr is exactly how a real breakage once survived this script. |
| `checkEvents.mjs` | Could not parse ``onEvent(`SOS_TICKET_${suffix}`)``, so the file owning seven lifecycle events was invisible to the audit whose header claims no name is invented on either side. |
| `sw.js` SHELL | Nine scripts out of date, so the offline shell served a page whose Me, Quests, SOS and Lead tabs failed at `ERR_INTERNET_DISCONNECTED` — worse than no offline shell, because it looks like it worked. `scripts/checkShell.mjs` keeps the two in lockstep now. |
| `loader.ts` | `quests.json` was never read at boot, although `quests.schema.ts` says the shapes that cannot advance "are rejected at load instead". Booth and raid venue keys were never checked against `venues.json`, although both schemas say they are. |

### Also closed

- Deploy always targeted `gymsCache[0]`: an item inspected against one stronghold was spent
  on another, usually an enemy-held one, with no way to choose and nothing saying which. It
  goes to the nearest gym now and the log names it.
- Three comments that overclaimed. `CLAIM_BRUTE_FORCE` moved to the `ops` channel and
  `IDENTITY.md` still said `announce`. `app.js` called acting as `volunteersCache[0]` "not an
  identity claim" when legacy mode believes precisely that. `me.js` said there is "no way to
  mint a token for somebody else", which is true of that tab and not of the client.

### Reported sound

Between them the three reviewers read every file under `public/`, every script in `scripts/`,
the pipeline and the pack, and reported sound: the plugin loader's SRI conversion, the
onboarding escaping, `nexus.js`'s registry and focus trap, `a11y.js`, `lite.js`, the tile
streamer's LOD and hysteresis, the bake worker's unit conversions, `checkCampus`,
`checkProps`, `cspAudit`, the pipeline's determinism, and every cross-reference in the shipped
pack.

---

## Round seven — reviewing the fixes, 2026-09-06

The brief put the round-six changes first and said so plainly: *a fix that introduces a worse
problem than it closed is the most valuable thing you can find here.* That instruction earned
its keep twice over.

### The gate that could not fail

`scripts/verify.sh` ended its suite step with:

```sh
npm test --silent 2>&1 | grep -E "Tests:|Suites:|✕|FAIL" || true
```

`set -euo pipefail` is on at the top of the file, and `|| true` discards the pipeline status
it would otherwise have used. A run with red tests printed `FAIL`, `grep` matched it and
exited 0, and the script walked on to `step "done"` and exited green. Every claim this gate
has made about the suite — in this log, in commit messages, in the README — rested on a human
reading the summary it printed rather than on the gate itself.

It now captures the status before filtering, still prints the summary, and on failure dumps
the whole log and exits non-zero. Verified the only way worth verifying: by adding a failing
test and watching `scripts/verify.sh full` exit 1.

### The hole the previous round's fix was covering

Round six made the client pick the nearest gym for a power-up deploy, which looked like the
fix and was not the problem. `POST /pokeshift/inventory/use` took a gym id, **no coordinates,
and no faction check**. Spins and battles have enforced the 75 m geofence server-side since
the beginning; this path enforced nothing, so a volunteer who earned a core at the event could
spend it days later from home — +250 control points and its karma bonus for an action nobody
performed — or drop a two-hour shield on any gym on campus, which makes every legitimate
on-site attacker's battle throw a conflict.

Both gym items *strengthen* their target, so there is a faction rule too: spending one on a
rival's stronghold hands the other side two hours of immunity out of your own inventory.

The same change fixed the other half of it, which agy found from the opposite direction:
requiring a position for *every* item locked out the ones that need none — a Cold Brew Elixir
is drunk, not aimed — and locked out lite mode entirely, where there is no renderer and
therefore never a player position.

### Closed

| Finding | Source | Fix |
|---|---|---|
| `verify.sh`'s test step could not fail. | muse, agy | ab0f8c3 |
| Gym-targeted power-up deploy had no geofence and no faction check, server-side. | opencode | ab0f8c3 |
| Requiring a position for personal items locked out lite mode and the items that need no gym. | agy | ab0f8c3 |
| A hacker whose ticket settled while their tab was shut was permanently stuck: no Cancel (OPEN only), no Clear (settled only), and no further SSE for a finished call. `sos.routes.ts` had claimed since M5 that `/me` carries a hacker's own ticket; no such route existed. | agy | ab0f8c3 |
| The round-six handover teardown cleared three `localStorage` keys and left the service-worker card, `sessionStorage` and every in-memory copy — so the next person still saw the previous person's face, sticker book and open ticket, and the next `saveFlags()` wrote the old flags back into the key just emptied. | muse | ab0f8c3 |
| Sticker and power-up vocabularies were cross-checked inside a *lazy* catalog read, so a pack typo surfaced at the first scan — after the karma was paid — rather than at boot, which three docblocks claimed. | opencode | ab0f8c3 |
| The beacon cooldown was reported to whatever identity the request carried; in legacy mode that is a query parameter, so polling with a victim's public id rebuilt their last-spin time at every beacon, and beacon locations are public. | opencode | ab0f8c3 |
| `checkShell.mjs` scanned only quoted strings, so `SHELL`'s first entry — the `INDEX` constant — was skipped and the one file the offline shell exists for was never checked. | agy | ab0f8c3 |
| Two stale comments: the hackstop controller still described the geofence fallback round six removed, and `sos.js` claimed staff take a path only hackers reach. Its `hackerName === displayName` match went with it — a display name is not an identifier and defaults to "A hacker". | opencode, muse | ab0f8c3 |

### Browser verification

The round-six client fixes have no jest coverage, so they were checked in Chrome against the
running demo:

- 24 Spin buttons, all disabled, titled "Walk to within 75 m to spin".
- With `campus.getPlayer` stubbed to null — the exact bug case — `playerCoords()` returns
  null, the guard refuses, and **no spin, battle or deploy request leaves the page**. Before
  the fix, spin and battle each sent the target's own coordinates and were paid.
- Logout clears `nexus.sos.ticket`, `nexus.avatar.v1` and `nexus.stickers.v1`, and leaves
  `nexus.lite.v1` — a device preference, not a fact about a person — in place.
- The service worker deletes the cached trainer card and acknowledges on the port, so the
  `await` in `logout` is a real handshake rather than a timeout.
