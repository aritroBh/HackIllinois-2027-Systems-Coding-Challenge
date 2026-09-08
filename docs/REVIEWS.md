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

---

## Round eight — reviewing round seven's fixes, 2026-09-06

The pattern from round seven held, and so did its lesson: **nearly every finding this round
was in code written the round before.** Three reviewers, ten findings, eight of them mine
from round seven. Read-only on one scratch copy, hash verified identical afterwards.

### The one that mattered

All three found it independently. `GET /me/sos` — the route added in round seven to unstick a
hacker whose ticket settled while their tab was shut — was gated on `requireAccount` rather
than `requireSession`. In the shipped `AUTH_MODE=legacy` posture an "account" can be a
`?volunteerId=` in the query string, and account ids are public: the unauthenticated
leaderboard hands them out.

So the route returned a named person's live `tableLocation` and `category` — where they are
sitting right now, and whether they called for medical help — to a caller with no cookie and
no audit row. Even `null` versus a ticket is an oracle for whether somebody is in trouble.

The same file already nulls the email for a claimed identity, `listBeacons` already withholds
a cooldown from one, and `GET /presence` already uses `requireSession`. The pattern was known
and the new route missed it, which is the most ordinary way a hole gets opened: not by
disagreeing with the rule, but by writing something new next to it.

### The rest

| Finding | Source | Fix |
|---|---|---|
| `GET /me/sos` answered a claimed identity with a live distress call's seat and category. | muse, opencode, agy | (this round) |
| The new rival-gym check read "no faction" as "not a rival", so the one account that had never picked a side could buff every side — `faction` defaults to null and only a gym battle binds it. | muse, opencode | (this round) |
| `setPlayerSprite(null)` threw on `source.width`, into a `catch` that assumed the renderer was down — so the handover reset never uploaded the default face and the previous user's photograph kept walking around the map. | agy | (this round) |
| The SOS handover cleared the ticket and kept the previous occupant's GPS fix, so the next person's call went out with somebody else's seat on it. Their 429 cooldown carried over too. | opencode | (this round) |
| The SOS view reconciled only on `session:ready`, which fires once at boot — so a hacker signing in at a registration desk saw an idle form while their DISPATCHED ticket sat live, and "I need help" raised a second call to the same table. | agy | (this round) |
| Nothing handed the presence socket over: it kept publishing the previous account's position, and `api.start()` refuses while `mode !== 'off'`, so the new user could never connect. One ghost, one invisible person. | muse | (this round) |
| The creator's unsaved photograph and palette previews survived the handover in memory, so pressing Keep wrote the previous person's face into the new account's avatar. | muse | (this round) |
| Me and Quests repainted the new name over the previous account's shifts, inventory and **live attendance token** — a credential a scanner accepts — until the fetch returned. Quests also kept a running camera stream. | muse | (this round) |
| `verify.sh`'s new frontend glob printed its count and never asserted it, so a scan that found zero files would have passed green. | muse | (this round) |
| The `restore()` docblock still described the round-six staff fetch it no longer makes. | agy | (this round) |

### What this round says about the loop

Round seven's fixes were good fixes and they opened one serious hole and seven smaller ones.
That is not an argument against fixing things; it is an argument for the rule that produced
this round — *review the last round's changes first* — and for the discipline that every fix
carries a test that fails without it, which is what stopped any of these from being the second
time the same mistake was made.

### The M4b soak, actually run

`docs/PRESENCE.md` has described how to run the presence soak since M4b without recording a
run. It has now been run, and two things about it cost an hour to learn.

Provisioning settles at about thirty accounts a minute, so a 1,200-client run is forty
minutes of setup before a sixty-second measurement. My first explanation for that was the
credential limiter, and I had written it into the doc before checking — the harness's own
comment names the real cause, which is the desk session's 90-mutations-per-minute bucket on
`POST /volunteers`. The difference matters: that bucket is keyed on the *account*, so
`TRUSTED_EGRESS_CIDRS` cannot widen it, and a reader who believed my first version would have
spent the evening editing an allow-list that was never going to help. Corrected before it
shipped, and recorded here because it is the same defect class this log is full of — a
confident comment about a mechanism nobody re-read.

The second: `--url localhost` resolves to `::1` first on macOS while `TRUSTED_EGRESS_CIDRS`
is IPv4-only, so the two together silently leave the *stream* ceilings on the untrusted path.
Use the IPv4 literal. Both notes are now in `docs/PRESENCE.md`.

---

## Round nine — the first clean verdict, and six more from the round before, 2026-09-06

**muse: clean.** The first empty round of the loop, and not an empty read: it traced every
round-eight change and reported each sound with the reasoning — `requireSession` running
before `requireAccount` on `/me/sos`, `holder !== mine` refusing a factionless actor
deterministically, the `setPlayerSprite` null branch, the handover event ordering in all three
cases (fresh sign-in, handover, same-account refresh). Its verdict: *"nothing left in what I
read."*

**agy: six**, two of them serious, and the pattern held — both were in round-eight code.

### The handover deleted the presence of the person who had just sat down

`api.stop()` ends with `DELETE /api/v1/presence`. By the time `session:handover` is emitted,
`session.user` and the session cookie already belong to the **new** account — that is what
makes the event detectable at all — so the stop was authenticated as *them*. It landed after
their socket had connected and removed them from the store: opted in, publishing, and
invisible to everybody, caused by the code written to hand the device over cleanly.

The handover now stops without telling the server. The departing account is not left
publishing: their socket is closed locally and the store drops an entry whose sender has gone
quiet, which is the same path a closed laptop takes and needs no request signed by somebody
else.

### A rota is a position with a timetable attached

Round eight gated `GET /me/sos` and I reasoned explicitly that the other `/me` routes carried
less — opencode had said the same. `GET /me/shifts` returns the venue, the building and the
window of every shift a named person holds, and in legacy mode an "account" is a query
parameter while account ids are public. It is now `requireSession` too.

### Closed

| Finding | Source | Fix |
|---|---|---|
| The handover's `api.stop()` issued `DELETE /presence` under the new account's cookie, erasing them from the presence store while their socket was live. | agy | 1da4401 |
| `GET /me/shifts` disclosed a named volunteer's schedule and locations to a claimed identity. | agy | 1da4401 |
| `players.js` listened only to `session:ready`, which fires once at boot — so a runtime sign-in (a badge scan at the desk; the only path in `AUTH_MODE=required`) never started presence. | agy | 1da4401 |
| `me.js` and `quests.js` painted but never loaded on `session`, leaving both tabs empty after a runtime sign-in until the user navigated away and back. | agy | 1da4401 |
| `checkEvents.mjs` was not in `verify.sh`, although it is one of the lockstep audits that gate exists to run. | agy | 1da4401 |
| A `load()` already in flight when the browser changed hands could land afterwards and repaint what the handover had just cleared. muse declined to rank it; a generation counter removes the class. | muse | 1da4401 |

### The M4b soak, and what running it found

The soak had never been executed despite being a plan gate. Running it found that the harness
**silently under-provisions**: `POST /auth/dev-login` is a credential exchange at 30/min per
address and had no 429 retry at all, so past the first thirty accounts of each minute the
client was dropped. A 1,200-account run provisioned about 370 and printed gate rows for all of
them — a gate that cannot fail, in the one place nobody had thought to look.

Both provisioning calls wait the limiter out now, and the gate asserts the count. Measured
after the fix, provisioning succeeds 1:1 (101/101, 201/201, 301/301) where it had been roughly
1:3. The full 1,200-client measurement was not completed in this session; the harness defect
and its fix are the result recorded here.

Two documentation corrections came out of the same exercise, and one of them is mine twice
over: I wrote the wrong cause for the throttle into `docs/PRESENCE.md`, checked before it
shipped, and found the harness's own comment naming the real one — then found *that* was also
incomplete, because two different buckets bite and only one of them is the desk account's.

### Reviewers that could not run

`codex` and `cursor-agent` are both installed. `codex` reaches the API and returns *"You have
no credits remaining"*; `cursor-agent` requires a login. Neither has produced a verdict in this
session, and earlier rounds' note that they were unavailable "until credentials exist" remains
accurate — the blocker is an account, not a missing tool.

---

## Round ten — three reviewers, three disjoint sets, and one planted control, 2026-09-06

The machine this work was running on shut down mid-round. Round ten existed only as
uncommitted changes in the working tree; this entry covers finishing it, reviewing it, and
what the review found.

**The suite was not green when it was picked back up** — 3 failures in 293. Two were the
round's own regression and one was a stale assertion, and the regression is the more
interesting of the two.

### The privacy fix that turned every lead off

`isProvenLead()` was introduced to stop a *claimed* `?volunteerId=` role unlocking the exact
dispatch distances and the unredacted ticket list. It reads `viewer.source === 'session'`.
`sos.controller.ts` builds its viewer as `{ id, role }` and has never passed `source`, and
`dispatchNearestVolunteer`'s signature did not even accept it — so `isProvenLead` was false
for **every** caller, including a real signed-in lead. The lead console lost its exact
distances and its "who else could go" column, and `GET /sos/tickets` returned redacted rows
to the one role entitled to the whole thing. Fail-closed, so nothing leaked; the feature was
simply off. Two reviewers found it independently and the existing suite had already caught it.

### The hole the fix was covering

Tightening the lead path moved the disclosure one branch down rather than closing it.
`listTickets` also returns the ticket whole to a **party** — the person who raised it or the
responder sent to it — and that test was `sameId(t.createdById, viewer.id)` on a bare id. In
`legacy` an id is claimed, not proved, and `GET /volunteers` hands account ids to anonymous
callers. So `GET /sos/tickets?volunteerId=<any public id>` returned that person's ticket whole
— coordinates, table text, hacker name, description, medical category — with no credential and
no session. muse and opencode reported it independently, both as P0.

Verified live against a running server before and after. After: `{"status":"OPEN",
"venueKey":null,"category":"MEDICAL_FIRST_AID","urgency":"HIGH","karmaBounty":150}` and
nothing else.

### The planted control

The brief listed the round's changes and its calibration, and deliberately did **not** mention
one known-real, long-open finding: `checkOut`'s `CHECKED_IN -> COMPLETED` CAS had its return
value discarded while the hours `$inc` and `awardKarma` ran unconditionally underneath it. It
had been recorded in the inter-session notes since the afternoon and never fixed.

**agy found it.** muse and opencode did not — both had been told that crash windows between
two documents are an accepted class, and this one is adjacent enough to that shape to be read
as covered. It is not: it needs no crash, only a cancellation committing in a two-round-trip
window, and the result is one seat paid twice — the volunteer who cancelled *and* the
waitlister promoted into their seat. It is fixed here, and losing the CAS now rolls the
`checkOutTime` back so a retry can still observe the settled state rather than being told it
already checked out.

The control is worth recording as a fact about the reviewers, not only about the code: a brief
that tells reviewers what to skip will be obeyed, including where the exclusion does not
actually apply.

### The three reviewers barely overlapped

| | muse | opencode | agy |
|---|---|---|---|
| Findings | 7 | 4 | 4 |
| P0 | 1 | 2 | 0 |
| Agreed with another reviewer | 3 | 3 | 0 |
| Unique | 4 | 1 | 4 |

muse and opencode agreed on the party disclosure, the `source` threading, and the in-flight
QR refresh. agy overlapped with neither and found four nobody else did. Fifteen reports, ten
distinct findings, and every one of them held up against the code.

### Closed

| Finding | Source | Severity |
|---|---|---|
| `GET /sos/tickets?volunteerId=<public id>` returned a stranger's ticket whole — coordinates, table, name, description — to a caller with no session, through the party exception. | muse, opencode | P0 |
| `sos.controller.ts` never passed `source`, so `isProvenLead` was false for everyone and real leads lost exact distances, the candidate list and the unredacted ticket list. | muse, opencode, suite | P1 |
| An in-flight `refreshQrToken()` landing after a handover wrote the departed account's live attendance credential back into `#qr-local` and restarted the countdown — a desk scan inside the window would check the wrong person in and pay them. `clearQrToken()` closed the idle window, not this one. | muse, opencode | P0 |
| `checkOut`'s `COMPLETED` CAS discarded its result while hours and karma were paid unconditionally: a cancellation in the window paid one seat twice. **Planted control — deliberately withheld from the brief.** | agy | P1 |
| The handover cleared the inventory cache and never reloaded, and the incoming user's own request was discarded by the generation bump — so every A→B handover left B's bag and sticker book empty. `me.js` and `quests.js` both reload here; `app.js` only cleared. | muse | P1 |
| `checkOut`'s new clamp capped the end of the paid interval and not the start, so checking in thirty minutes early was paid as work — and because `timeFactor` saturates at an hour, a five-minute appearance after an early scan paid 0.58 of the award instead of 0.08. | opencode | P2 |
| The `SOS_TICKET_RESOLVED` frame carried the *actor's* id beside the *earner's* name, karma and balance, so a lead closing a ticket for a responder saw the responder's totals written over their own header. | agy | P1 |
| `stop()` detached `onclose`, `onerror` and `onmessage` but not `onopen`, so a socket stopped while still CONNECTING opened afterwards, set `mode = 'ws'` with `state.ws === null`, sent a `hello` as the departed account, and left presence dead until reload because `start()` then refuses. | muse | P2 |
| The idempotent "already checked in" short-circuit was moved above the coordinate requirement and the geofence, so a 200 and an attendance row — a disclosure that this person is checked in right now — could be had with no coordinates, from anywhere, at any hour. It belongs above the shift window and below those two. | muse | P2 |
| `GET /me` set no `Cache-Control` while every sibling sets `no-store`; with an ETag and no directives it is heuristically cacheable, so a shared laptop could answer the next account's request from disk with the previous account's profile. The `/me/card` fix was one route short. | muse | P2 |
| The torn-state repair CAS in the duplicate-key catch was conditional on `CONFIRMED`, left over from when the claim ran after the create. The claim runs first now, so it could never match and the loser of two simultaneous scans left the registration and the attendance row stamped with different clocks. | agy | P2 |

### Recorded, not fixed

`GET /me/shifts` treats `SWAP_PENDING` as workable while `generateToken` and `verifyAndCheckIn`
accept only `CONFIRMED` and `CHECKED_IN`, so a shift offered as "next" would refuse to mint a
token at the desk. agy ranked it P1. It is unreachable: `SWAP_PENDING` is never written —
swaps rewrite the registration in place — and both plausible fixes are speculative, because
checking in would also have to cancel the pending swap or the trade could hand the shift away
underneath an attendance row. The coupling is now written down at both ends rather than
guessed at.

A residual on the check-in short-circuit is recorded in the code rather than closed: a caller
who sends the venue's published coordinates satisfies the geofence, because a geofence cannot
tell a spoofed fix from a real one. In `AUTH_MODE=required` that caller must already hold
`SHIFT_LEAD` to reach `/verify`, and a lead can read the roster anyway. Closing it properly
means binding the scan to the scanner, not reordering gates.

### Reviewer mechanics, updated

- **muse** and **opencode** both ran clean in a scratch copy; the tree hash was identical
  before and after, so neither wrote anything. opencode worked this round, on a brief file
  plus an explicit file list — the shape memory already records as the one that works.
- **agy** produced nothing on the first attempt: headless mode auto-denies the `command`
  permission and it had decided to run a shell command. Re-running with the prompt explicitly
  forbidding shell and naming the files to read produced the report. It was given its own
  `git init`-ed scratch copy, which removes both the "fails without git" problem and any risk
  to the real tree.
- The **live server** was used as a reviewer of last resort: the P0 was reproduced and then
  disproved against a running instance, and the whole client was driven through all seven tabs
  in a real browser with zero console errors. The campus tab reports `WEBGL2 UNAVAILABLE` in a
  headless browser and degrades to a legible message with every other panel working, which is
  the fallback behaving as designed rather than a defect.

---

## Round eleven — the pre-deploy sweep, and one bug class in nine places, 2026-09-06

The last review before this repository was published as an interview deliverable and deployed.
Each reviewer got a different half of the system rather than the same diff, because round ten
had shown they barely overlap: muse took the request surface and identity, opencode took the
client and the demo path, agy took the production path and documentation.

**Twenty findings across the three, and seventeen were real.** The headline is not any single
one of them.

### One bug class, nine sites, four rounds

Round C, round four, round eight, round nine and round ten each closed a version of the same
defect: a **disclosure** decision made on a *claimed* identity. `AUTH_MODE=legacy` lets a caller
assert `?volunteerId=<public id>`, `GET /volunteers` and the leaderboard hand those ids to
anonymous callers, and the standing rule is that legacy may be believed for an **action** and
never for a **disclosure**. Every round found one or two instances, fixed exactly those, and
left the siblings — because each site was written independently, with its own
`/SHIFT_LEAD|ORGANIZER|ADMIN/.test(role)` or `kind === 'VOLUNTEER'`.

This round swept the class instead of the instances. Nine sites:

| Site | What a caller with no cookie could read |
|---|---|
| `eventHub.registerClient` — `fullSos` | An **unredacted SOS stream**: hacker names, table text, medical categories, and full-ticket `SOS_ESCALATED_FULL` with coordinates. `listTickets` redacts exactly those fields over REST, so the stream was undoing the REST fix live. |
| `eventHub.reauthorise` | The same, re-granted on the heartbeat — a connection that opened redacted was *upgraded* a minute later by the code written to downgrade it. |
| `eventHub.mayJoin` — `presence:exact` | The channel named for exact positions, open to anonymous callers in the default mode. Latent: nothing publishes to it yet, which is precisely why the missing gate would not have been noticed by the first thing that did. |
| `audienceReaches` (SSE) + `announcementReaches` (REST) | Staff-only announcements, with author name and venue, to anyone naming a lead's id. `POST` and `DELETE` already required a session; the reads did not. |
| `AvatarService.fetch` | The **bytes of an unpublished face photo** — pending review or never shared — to a claimed lead. The hash is broadcast publicly on the presence wire, so the attacker already has the URL. |
| `ShiftService.getShiftById` | Every rostered volunteer's name, certifications, karma, prestige and avatar hash. Anonymous got redacted counts; naming one public id upgraded that to the full roster. |
| `GET /me/inventory`, `/quests`, `/stickers`, `/card` | A named person's bag, quest progress, sticker book and trainer card. Two rounds had put `requireSession` on the two `/me` routes carrying a location and left the four beside them. |
| `DELETE /presence` | Removes any named person from the presence store and drops their SSE session — no session, and because a claimed identity is not a session, no CSRF check. `PATCH /me/presence` was fixed for this attack in round ten; the `DELETE` beside it does the same thing more directly. |

The fix is `isProvenSession` / `isProvenLead` / `isProvenKind` in `src/common/types/account.ts`,
beside `isLeadOrAbove`, with the rule stated once where the next person will read it: **an
action may believe a claimed identity; a disclosure may not.** Every site above now calls one
of the three. `presence:exact` was found by re-scanning for the class after fixing the eight
the reviewers named — which is the argument for fixing classes rather than instances.

### The client kept the previous person's distress calls

opencode's two client P0s are the same shape as round nine's and round ten's handover work,
in the two places that had never been looked at.

`app.js` cleared the inventory cache on handover and left `openSosTicketsCache` — a lead's
**unredacted** open tickets, seat numbers and medical categories — sitting in memory and
painted in the DOM for whoever sat down next. And `views/lead.js`, the view holding the roster
and the SOS queue, subscribed to **no session event at all**: it was the only view without a
handover listener, and the one with the most to lose. Both now clear, repaint, and reload under
the new session, so what comes back is what the new account is actually entitled to.

### `/health` was a surveillance endpoint

agy and my own probe of the running container agreed. `GET /health` is on `ANONYMOUS_ALLOW`
because an orchestrator must reach it without a cookie, and it returned the whole operational
picture: live stream counts, the exact number of tracked people, the slot ceilings, presence
tick timings, the plugin list, and `jobs[].lastError` — a background job's error text, the one
field that can carry an internal detail nobody chose to publish. On a laptop that is a
convenience; on a public URL it is a live read on how busy the event is and how much load
exhausts it. Anonymous callers now get liveness; a proved lead gets the rest.

That fix needed a second one to work at all: `attachIdentity` is mounted on `/api/v1`, so on
`/health` `req.account` was always undefined and the lead branch would have been dead code
that read as a working gate.

### Documentation that lies

Weighted P1 this round, because the author will be asked to explain this repository out loud.
Nine corrections, and the two that would have cost real time:

- `docs/DEPLOYMENT.md` told operators to run `npx tsx scripts/migrate.ts` **inside the
  production container**. `scripts/` is excluded from the build and not copied into the image,
  and `tsx` is a dev dependency, so the documented command cannot run there. Verified by
  listing the built image: there is no `/app/scripts`.
- `docs/DEPLOYMENT.md` said `TRUSTED_EGRESS_CIDRS` addresses are "exempt from the per-IP stream
  and rate ceilings". The code gives them **10x**, and gives the anonymous ceilings **no**
  allowance at all. An operator hitting 429s at the door would have widened a list that was
  never going to lift the limit they were actually hitting. `docs/IDENTITY.md` had it right.

The rest: README claimed two exact-position readers where there are three, and claimed opting
out is symmetric when a lead's roster still counts you (`docs/DEMO.md` already volunteered both
truths — the two documents disagreed with each other); `docs/IDENTITY.md` promised magic-link
always answers 202 when production without SMTP answers 403; `docs/DEMO.md` narrated "fifty
real signed-in sessions" for what the Chaos Lab does as fifty delegated registrations under one
organiser session, and pointed at a "Swaps panel" that does not exist; a `checkin.controller.ts`
docblock still said token minting was unauthenticated and should sit behind organiser auth,
which stopped being true when `/verify` was gated instead; and the seed logs "5 Volunteers"
while creating six.

**One reviewer claim was wrong, and checking mattered.** agy reported that `ARCHITECTURE.md`
lies about `public/gl/uiuc-campus.json` no longer existing, citing `.gitignore` as the
contradiction. The file genuinely does not exist and nothing loads it: `ARCHITECTURE.md` is
correct and **`.gitignore`'s comment** was the stale one, along with a comment in `seedData.ts`.
Fixed at the two places that were actually wrong, rather than the one that was reported.

### Verification this round

| Check | Result |
|---|---|
| `npm test` | **305 passed, 0 failed**, 29 suites |
| `npm run lint` | clean |
| `npm run e2e` — live HTTP surface, real cookies, real concurrency | **83 passed, 0 failed** (two new assertions: the anonymous `/health` discloses nothing, the lead's does) |
| `npm run gates:check` | **58 passed, 0 failed** |
| `npm run csp:audit`, `props:check`, `events:check` | clean |
| `docker build` | 249 MB image |
| Production boot rehearsal: image + real Mongo replica set, secrets from env only | boots clean, `/ready` 200 |
| Hostile probe of the running production container | every anonymous and claimed-identity read 401; `dev-login`/`dev-accounts` 404; CSP, HSTS, nosniff, frame-options present; no stack traces |
| Browser playthrough — all seven tabs, token mint, account handover | zero console errors; handover clears the token and reloads the new account's data |

### Reviewer mechanics

All three were read-only, proved by comparing every tracked file in each scratch copy against
`git archive` of the reviewed commit: zero differences. agy needed the same
"do not run any shell command" prompt round ten found; without it headless auto-denies the
`command` permission and it produces nothing.

**A hygiene note against myself:** the `rsync` that built the scratch copies swept `.gstack/`
local runtime state, including a terminal token, into three directories handed to external
review CLIs. Nothing appears to have read them, and they were scrubbed, but the exclude list
should have had `.gstack` and `.claude` in it from the start.

---

## Rounds twelve and thirteen — reviewing the fixes, then the prose, 2026-09-06

Two rounds run back to back, both prompted by the same question: the previous round's *fixes*
had never been reviewed by anyone, and the fix set was nine authorisation changes of exactly the
kind that had already gone wrong once.

### Round twelve — the fixes, checked in both directions

The brief named the failure mode instead of describing the code: two rounds earlier,
`isProvenLead()` had been introduced and the controller never passed `source`, so the predicate
was false for **every** caller including a real lead. It failed *closed*, so nothing leaked and
nothing errored — the lead console silently lost its data and it shipped. Reviewers were asked
to check every changed gate twice: can the entitled caller still pass, and is the unentitled one
actually blocked.

**muse found the P0 the fix set had left behind, and it is the same shape as round ten's.**
`AvatarService.fetch` has two branches that hand over an unpublished face photo: a *lead* branch
and an *owner* branch. Round eleven tightened the lead branch to require a proved session and
left the owner branch matching on `ownerId === viewer.id` — a bare id comparison, and in
`legacy` the id is claimed. So `GET /avatars/<hash>?volunteerId=<victim>` still returned the
victim's unpublished photograph with no cookie: identical outcome, identical attacker cost, one
`if` earlier. opencode traced the same file and did not find it.

Both reviewers independently found the client bug I had already found and fixed while they read:
`views/lead.js`'s new handover handler called `refreshAll()` unconditionally, so a lead→volunteer
device handover fired a 403 and raised a **global toast** — "your account is not a shift lead" —
at somebody who had never opened that tab. The tab was already role-gated through `onShow`; the
handler had bypassed the gate the file already had. Both also found the roster error path missing
the generation guard its success path had.

**agy produced nothing this round.** Headless mode auto-denies the `command` permission and it
chose to run a shell command anyway, despite a prompt that forbade it — the same failure as
rounds ten and eleven, now three for three.

### What running the review found that no reviewer did

The browser used to verify the `lead.js` fix kept serving the *old* file. That was not a product
bug — the service worker precaches the shell and serves it **cache-first** — but chasing it
surfaced one: `sw.js` said to bump `VERSION` "whenever the shell list or the caching rules
change", and that is not the rule. The list can be identical while every file in it is
different, which is the ordinary shape of a release. Any shipped JS change, including a security
fix, would keep reaching returning users' old bundle until somebody remembered.

`scripts/checkShell.mjs` now hashes the precached bytes against a committed `public/sw-shell.lock`
and fails when they move without a bump. Proven by tampering with a precached file and watching
it fail, and it runs inside `verify.sh quick`, which CI runs — checked, because this repository
has twice shipped a gate that could not fail.

### Round thirteen — can the author explain it out loud?

The challenge brief says the organisers want to see that the author *"can discuss/explain your
code"*. So the third round judged the prose by that standard, with a different angle each:
muse on **accuracy** (find statements that are false), opencode as **the interviewer** (what
would you ask that this repository cannot answer?), agy on **cross-document consistency**.

**muse: nine findings, all P0, all false statements.** Three had already been fixed while it
read. Six were real, and two of those I had written myself earlier the same session — a README
sentence attributing a phrase to a file that does not contain it, and a new `docs/DATA-MODEL.md`
that inherited a stale four-reader claim from the model comment it was written from, then
contradicted itself two paragraphs later. Also: `docs/PRESENCE.md` still said "two readers" and
called the roster audit a future arrival that had already shipped; the avatar `status` list
omitted `REJECTED`; the check-out clamp was described as symmetric when the grace applies only at
the far end; and `gym.model.ts` carried the pre-redesign faction hex values in comments while
everything that renders reads the pack's. That last one is instructive — the fix was not to
correct the hexes but to delete them, because a pack value duplicated in a source comment is a
second source of truth that nothing checks.

**opencode, as the interviewer: ten findings, three P0 contradictions.** The worst was
`docs/DEMO.md` instructing the author to volunteer, on stage, that *"there is no shift
time-window check"* — a check that has existed for several rounds. The demo script would have
had them state a falsehood about their own code. It also caught `cycleFinder.ts`'s header
claiming "canonical rotation hashing" for a file containing no hash, while two documents
correctly denied the hash existed.

Its most useful output was not a defect but a list of **questions the repository could not
answer**: how would counter drift be detected in production; why is the rest buffer 30 minutes
and not 15; what breaks for an event outside `America/Chicago`; and where is the consolidated
list of what is still broken. Those became `docs/LIMITATIONS.md`.

**One of its P1s was a real bug, not a documentation gap.** The `FAILED` write in
`reserveShift`'s generic `catch` was unfenced, while both sibling writes carry
`ownerToken: attemptToken` with comments explaining that an unfenced write corrupts the record a
later attempt now owns. A predecessor that stalled past the steal window and then threw would
mark its *stealer's* record `FAILED` — and a client told its reservation failed, when the row
exists, retries. Fenced on owner **and** status, since the broadcast runs after the commit and
could otherwise walk a `COMMITTED` record back to `FAILED`. There is a test.

**agy: the cross-document check, and a warning about my own harness.** It found the
`PRESENCE.md` contradiction independently. Its report also revealed that it had resolved to the
**real repository** rather than the scratch copy it was launched in — everything it names is
consistent with a read-only pass and `git status` shows no file I did not edit myself, but the
isolation those copies exist to provide was not actually in force for that run.

### Closed

| Finding | Source | Severity |
|---|---|---|
| `AvatarService.fetch`'s **owner** branch matched a claimed id, so an unpublished face photo was still readable with no cookie — the lead branch had been fixed and its sibling left. | muse | P0 |
| `docs/DEMO.md` told the author to state that there is no shift time-window check. There is one. | opencode | P0 |
| `cycleFinder.ts`'s header claimed "canonical rotation hashing"; the file contains no hash, and two docs said so. | opencode, muse | P0 |
| `docs/PRESENCE.md` and `docs/WORKFLOWS.md` said two exact-position readers; there are three, and PRESENCE called the third a future arrival. | muse, agy, opencode | P0 |
| `docs/DATA-MODEL.md` (new this session) inherited a stale fourth reader, omitted the `REJECTED` avatar state, and mis-stated both the transaction count and the check-out clamp. | muse | P0 |
| `README.md` attributed "the one asymmetry" to a file that never uses the word. | muse | P0 |
| `gym.model.ts` carried stale faction hex values that nothing renders. | muse | P0 |
| `views/lead.js` fetched lead-only data on every handover, raising a global "not a shift lead" toast at ordinary volunteers. | opencode, muse, self | P1 |
| The unfenced `FAILED` idempotency write let a stalled predecessor corrupt its stealer's record. | opencode | P1 |
| `loadRoster`'s failure path lacked the generation guard its success path had. | muse, opencode | P2 |
| `docs/CONTENT-PACKS.md` told the reader to run `npm run check:events`; the script is `events:check`. | self (new gate) | P2 |
| `ARCHITECTURE.md`'s verification matrix and `docs/DEMO.md` both carried stale suite counts. | opencode | P2 |
| `SECURITY.md` invited geofence-bypass reports for a limitation now documented as accepted. | self | P2 |

### Two new documents and one new gate

`docs/DATA-MODEL.md` — all twenty-three collections, grouped by concern, each explaining why it
is a separate collection rather than a field. Thirteen of them appeared nowhere in
`ARCHITECTURE.md`, including all three ledgers and both auth tables, which is a gap worth
closing in a challenge that names database modelling as one of the things it assesses.

`docs/LIMITATIONS.md` — what is not solved, and why every tuned constant is the number it is.
Written because "what would you do differently?" should not have to be assembled live from
twelve scattered comments.

`scripts/checkDocs.mjs` — the machine-checkable subset of documentation accuracy: every relative
link resolves, every `npm run` script named exists, every repository path named exists. It found
the `check:events` typo on its first run. It cannot check whether a true-looking sentence is
true, which is what these rounds are for.

---

## Round fourteen — the layer nobody had read, and the fourth sibling, 2026-09-06

Two targets, both chosen because no reviewer had seen either: the **previous round's own commit**
(`5138aef`, unreviewed by anybody) and **`src/presence/`**, which thirteen rounds of attention on
the REST surface had never touched despite it being the most privacy-sensitive code here.

### The disclosure class found a fourth branch

`dispatchNearestVolunteer` trims `dispatchedVolunteer` to four fields, buckets `distanceMeters`
for non-leads, and empties `candidates` for them — and then returned the **raw ticket document**
beside all that care, carrying the coordinates, the hacker's name, the table text and the medical
category. The route admits any volunteer-kind caller, and in `legacy` an anonymous one.

That is the same defect as the `sos` SSE channel, as `GET /sos/tickets` for a non-party, and as
that route's own *party* exception — four branches, four rounds, each fixed alone and each
leaving a sibling. There is now **one** `redactedTicket()` used by both call sites, so the shape
is decided once.

### A revoked session kept its map

Nothing under `src/presence/` referenced `sessionVersion` — zero occurrences. Every HTTP route
re-verifies the cookie per request and the SSE hub evicts on its heartbeat; the presence
WebSocket authenticated once at the upgrade handshake and never again. A revoked or expired
session kept publishing its position and receiving everybody else's for as long as the socket
stayed open.

`invalidate()` is what hid it: it removed the *lead privilege*, so the visible symptom of a
demotion looked handled while the connection itself survived. `evictRevoked()` is public and
called from the tick, following the precedent set when `eventHub.reauthorise()` was made public
for the same reason.

**The test for it needed three attempts, and the first two were wrong in instructive ways.** The
first asserted the return value of a method the running tick had already called, so it read 0.
The second asserted close code `4401` — which is also what the no-hello sweep sends, so it
passed with the fix removed. It now sets `helloAt` to take that path off the table and asserts
the session is *gone* rather than merely closed, and it was verified red against a stubbed
`evictRevoked` before being believed.

### The jitter defended against nobody who was looking

Published positions are snapped to a 20 m grid and offset by a per-hour jitter of up to 8 m.
That jitter was `sha256(accountId : hourIndex)` — and **both inputs are things a viewer already
holds**: the raw account id ships in every join record, and the hour comes from the `serverTime`
in `hello_ack`. Any viewer could recompute the exact offset applied to anybody they could see and
subtract it. `docs/PRESENCE.md` presented the snap and the jitter as layered protection; the
second layer was decorative against the only party it mattered against. It is now keyed on
`SESSION_SECRET`, which keeps every property it was chosen for and removes that one.

### Also closed

| Finding | Source | Severity |
|---|---|---|
| Dispatch returned the whole SOS ticket — coordinates, name, table, medical category — to any volunteer, or anonymous in `legacy`. | muse | P0 |
| A revoked session kept its presence socket, publishing and receiving indefinitely. | muse, agy | P0 |
| `GET /avatars/:hash` sent `private, max-age=60`, so a shared browser served the previous occupant's **unpublished** face photo from disk, past the session check. The same defect `/me/card` had been fixed for. | opencode, muse | P1 |
| The per-hour presence jitter was computable by any viewer. | muse | P1 |
| A claimed `?volunteerId=` was filed in the SSE hub's `byAccount`, so **targeted** frames — including a ticket's full document to its parties — were delivered to the impersonator. | muse | P1 |
| `POST /presence` on `requireAccount` let a claimed identity **publish a position as somebody else** and allocate an SSE session under their id. `PATCH` and `DELETE` had both been tightened; this one was left. | agy | P1 |
| Non-lead dispatchers received `positionSource` and `positionAgeMs` for a named winner — a liveness oracle usable without publishing anything, against the symmetric opt-out promise. | muse | P1 |
| A WebSocket stream slot was acquired before `handleUpgrade` and released only inside its callback, so an aborted or malformed handshake leaked the slot permanently. | agy | P1 |
| `ARCHITECTURE.md` said the OSM extracts are committed; `.gitignore` excludes them. | opencode | P2 |
| `checkShell` matched only `src="…​.js"`, so a stylesheet or font added to the page and missing from the precache list would slip past the gate written to catch exactly that drift. Now 22 assets, not 19. | opencode | P2 |
| Two misattributions in `docs/DATA-MODEL.md`: a heading naming four ledgers over seven sections, and `ownerToken` credited with what `requestHash` does. | opencode | P2 |

### The test that certified nothing

Both reviewers independently caught that the previous round's regression test **could not fail**:
it issued the fixed `updateOne` itself and asserted Mongo's filter semantics, never invoking the
`catch` it was written for. It passes identically against the broken code. It now drives the real
path by making the post-commit broadcast throw, and was verified red — `Expected: COMMITTED,
Received: FAILED` — before being trusted.

### My own harness manufactured a finding, for two reviewers at once

Both opencode and muse reported that the new `checkDocs` gate fails on a clean tree, which would
mean CI red at HEAD. It does not: `design/osm/` **is** tracked (the `.overpass` queries and
`manifest.json`; only the fetched extracts are ignored), and a `git archive` of HEAD passes.
They both saw it fail because the `rsync` building their scratch copies excluded that directory.
The exclusion list that exists to keep reviews cheap produced a confident, identical, wrong P1
from two independent reviewers — worth remembering next time three of them agree.

### Recorded rather than fixed

A published heading is derived from the unfuzzed track (quantised to ~1.4° on the wire); presence
entries outlive a handover, a `DELETE` against an open socket, and the end of a shift by up to
the 120-second expiry; and `store.cells` never deletes an emptied cell, bounded by the
bounding-box gate to a few thousand keys. All four are now in `docs/LIMITATIONS.md`.

### Checked and clean

muse confirmed the exact-position reader set holds: `presenceStore.all` / `get` /
`nearestVolunteers` have exactly the three audited call sites, and `near()` / `clusters()` are
test-only. My own pass verified the same and two things beyond it — the presence layer performs
exactly one database write (a mute row, carrying no coordinates), and opt-out symmetry is
enforced explicitly at two levels rather than emerging by accident: opting out removes the store
entry, which nulls the cohort, which returns an empty frame.

---

## Round fifteen — the last two siblings, and a fix I wired into the wrong method, 2026-09-06

The final round. The brief did not describe the code; it described **the one failure mode that
had recurred in every previous round** — a disclosure decided on a claimed identity, fixed in one
branch and left in a sibling — listed the five places it had already been found, and said:
*assume there is one more; find it, or tell me you looked and there isn't.*

There were two more.

### The sixth: an inventory addressed by path parameter

`GET /pokeshift/inventory/:volunteerId` answers "what is in that named person's bag". The round
that put `requireSession` on `GET /me/inventory`, `/quests` and `/stickers` never reached it,
because this route takes the account id as a **path** parameter rather than as the caller's
identity — so a search for the pattern did not look like a search for this.

Two holes, not one. The ownership check read
`env.AUTH_MODE === 'required' && req.account && …`, so it was switched off entirely in the
shipped default mode — and in `required`, an **anonymous** caller short-circuited the whole
condition on `req.account` and read any inventory in the one mode that exists to refuse them.
That second half is the more embarrassing: the strict mode was the more open of the two.

### The seventh: the lifecycle answers

`redactedTicket()` was introduced last round and reached `dispatch` and `listTickets`. It did not
reach `transition()` or `resolveTicket()` — so `acknowledge`, `arrive`, `cancel`, `reassign` and
`resolve` each still answered with the **whole ticket document**, gated only by a claimed id or a
claimed role.

`POST /tickets/:id/acknowledge?volunteerId=<the assignee>` from an anonymous caller in `legacy`
passed the assignee check and was handed the coordinates, the hacker's name, the table text and
the medical category. Naming any lead's public id passed every lead override as well.

The distinction that resolves it is the one this project keeps relearning: **acknowledging is an
action and `legacy` may believe it; the ticket that comes back is a disclosure and may not.** The
action still succeeds for a claimed caller. The answer is now a receipt unless they proved who
they are. `ticketFor()` and `viewerOf()` exist side by side with `actorOf()` so that the
difference is visible at every call site.

### The fix I wired into the wrong method

Last round's `evictRevoked()` — the fix for a revoked session keeping its live map — was
inserted after `await this.refreshMutes(nowMs);`, a line that appears in **`factsFor()`**, not in
`tick()`. `factsFor` is reached when an account *samples* or says hello. So a revoked
**publisher** was evicted, and a revoked **watcher** — a lead with the map open who sends
nothing — never called it and kept receiving everybody's positions indefinitely. That watcher is
the half of the bug that mattered.

Worse: the commit message said "called from the tick", and the `AccountFacts.sessionVersion`
docblock said "See the eviction in `tick()`". Both were false, written in the same commit that
the previous round's log describes as fixing false claims. opencode caught it by grepping for
call sites rather than believing either sentence.

### Closed

| Finding | Source | Severity |
|---|---|---|
| SOS lifecycle responses (`acknowledge`, `arrive`, `cancel`, `reassign`, `resolve`) returned the full ticket — coordinates, name, table, medical category — to a claimed identity, and `reassign` to an anonymous one. | opencode | P0 |
| `GET /pokeshift/inventory/:volunteerId` disclosed any account's inventory to a claimed identity in `legacy`, **and to an anonymous caller in `required`**, because the guard short-circuited on `req.account`. | muse | P1 |
| `evictRevoked()` was called from `factsFor()` rather than `tick()`, so a revoked but idle watcher was never evicted — and two comments plus a commit message said otherwise. | opencode | P1 |
| `avatar.routes.ts`'s header comment still described the old unconditional `private, max-age=60`. | muse, opencode | P1 |

### The sweep that came back clean

muse produced a table of **every** place in the request surface whose output shape depends on who
is asking — the SSE hub's four decisions, SOS dispatch and listing, both avatar branches, the
volunteer projection and `kind=ALL`, the shift roster and detail, beacon cooldowns, announcements,
`/me`'s email, the eleven `requireSession` routes, claim-code issuance, and the presence WebSocket
upgrade — and, for each, what it checks and whether a claimed identity satisfies it. One row said
yes. It is fixed above.

agy swept the routes nobody had looked at (volunteers, registrations, swaps, game, stats,
pokestop, content, checkin, auth, adonix) and returned clean with the same per-method reasoning.

opencode verified the previous round's fixes in both directions and confirmed the entitled paths
still work: a proved lead still gets the full ticket, exact distance, live position source and the
candidate list; a proved owner still gets their unpublished avatar bytes; the shipped client still
publishes presence, because it always establishes a real session at boot.

### The state at the end

Unit suite 308 across 29 files. `npm run e2e` **83 assertions against a live server, 0 failed** —
run against the final code, not an earlier commit. 58 plan gates, and the CSP, props,
event-bridge, shell and docs gates. Docker image builds and boots in production against a real
replica set, with every claimed-identity read re-probed against the running container in both
auth modes.

---

## Rounds sixteen and seventeen — the front end, and seven claims that were not true

The last two rounds pointed all three reviewers at the client: the layer a judge clicks, which
thirteen earlier rounds had barely touched. Twenty-two findings. The most useful ones were not
about the code that was written — they were about the sentences written next to it.

### The one to read first: the renderer that never stopped

`campus3d.js`'s frame loop guards on `if (!W || !H) return`. `resize()` sets those with
`Math.max(1, …)`, so neither can ever be zero and **the guard could never fire**. Every inactive
tab is `display: none`; lite mode hides the canvas outright. So the WebGL renderer went on doing
full scene work behind a hidden canvas — on every tab, and in the mode that exists specifically
to switch it off. `clientWidth`/`clientHeight` are the layout box and *are* zero for a hidden
element, which is the question `W`/`H` cannot answer.

This is the fourth instance of a check in this repository that reads a value which cannot take
the failing state. It is worth naming as a class: **a guard is only a guard if you can say what
makes it fire.**

### Seven false comments, all written in round sixteen

muse was given one instruction — find statements that are FALSE — and returned nine, seven of
them sentences written in the immediately preceding commit:

| Claim | Reality |
|---|---|
| "The two GPS watches never run at once" | Entering lite mode does not stop the renderer's walk. Two watches, two presence publishers, one stopped on unmount. |
| "In lite mode this file is the only writer of `#hud-nearest`" | `updateHud` has nine callers; the frame callback is one. Switching to Campus overwrote it. |
| "Kept in step by checkShell — order and ids must match" | The gate checked ids, not order. Added; it caught real drift on its first run. |
| "It had drifted three tabs behind, still listing Chaos Lab" | The old nav listed five tabs, all still registered. The real fault was two role-gated tabs in a nav rendered before any session. |
| "`roles: STAFF`, so the volunteers who check in could not reach it" | `STAFF` *includes* VOLUNTEER. The excluded role was HACKER, who cannot mint at all. |
| "cream modules on ink" | `draw()` fills cream and paints the modules ink. The test code had it right; the prose did not. |
| "the Trainer path still posts `{volunteerId, shiftId}`" | That path had been deleted in the same commit. |

Every one would have been believed by a reader. This is the failure mode the review briefs now
lead with, because it is the one this repository produces most.

### Two gates of mine that were partly blind

The `registerTab({…})` scanner used a lazy `[\s\S]{0,400}?`. That stops at the first `})` — an
inner `addEventListener` close in `views/sos.js` — so it matched **nothing at all** in that file.
`tab-sos` was invisible to the gate, and the "did the scan work" floor of 5 still saw nine hits
from the other four files and stayed silent. A gate that cannot fail for one input is worse than
no gate, because it is trusted.

Separately, "open to every role" was tested by string-matching the identifier `EVERYONE`. Two
views write the same five roles as an array literal, so both counted as gated and deleting their
fallback buttons would have passed. Both fixed and both verified red.

### What the demo-judge angle found that accuracy did not

opencode was told to be a judge with five minutes to break it. It walked the click paths per
role and found four dead ends where a labelled button does nothing: `showTab` refuses, logs a
`console.warn` nobody sees, and leaves the reader on the page they were already on. BAG for a
hacker, "Open the quest board" for a hacker, and the lite-mode Spin buttons under a readout
saying "in range — spin it!".

That last one is the shape worth remembering: **two panels disagreeing about the same fact**,
which no amount of reading either panel alone would surface.

It also found `sos-simulate` still registered after its button was removed. An action id is
reachable from anything that carries it; that one posted fixtures as real tickets, and dispatch
would have routed a real volunteer to a table where nobody needed help.

### And a fix that broke the entitled user

`Sync Adonix` was gated to organisers because the endpoint is `requireRole('ORGANIZER')` while
the tab hosting it is `roles: STAFF`. The gating then went wrong twice: the call landed in
`changeUserFaction` rather than `onSessionChange`, referencing a `user` not in that scope, and
the session listener is registered *after* `await Nexus.session.ready`, so the account signed in
at page load never reached the gate. The button was hidden from the only role entitled to it —
found by checking it both ways in a browser rather than by reading it.

### The state at the end

340 unit tests across 31 files, including `tests/lite.test.ts`, which evaluates the real browser
file against a hand-built window rather than asserting on its source. 58 plan gates. `verify.sh`
exit 0. The QR renders to a canvas that was exported and decoded by an independent decoder back
to the exact minted token. Both review trees were hashed before and after: no reviewer wrote.

---

## Round nineteen — the seams that were not connected, 2026-09-07

Two sessions worked this tree at once, in agreed lanes, talking directly rather than through a
file. This is the server half. The round was framed by one question, borrowed from the other
session and worth stating plainly because it outperformed everything else tried in nineteen
rounds:

> Not "is this sentence wrong", but **"does anything actually call the thing this sentence
> promises?"**

Sixteen agents ran it across `src/` and `docs/`, in two passes each — one writing, one
adversarially fact-checking the first pass's own output on the grounds that new prose written
quickly by someone who has just read the code is where this repository's false claims come from.

### The headline: three content-pack files that did nothing

`territories.json`, `beacons.json` and `loot.json` were parsed, cross-validated, served to every
browser under `/dashboard/content` — and read by nobody. The seed built its fourteen gyms and
twelve beacons from literals; `HackStopService` rolled against a drop table written inside the
service. Each pack file held the same data as the literal it shadowed, so the two agreed by
coincidence and nobody had noticed there were two.

`territories.json`'s own `_about` said *"Read by `src/seed/seedData.ts`."* It was not. That is the
worst form of this defect: specific enough to be believed, and sitting in the file it lies about.

`src/common/utils/geo.ts` was the same shape one layer down — a fifteen-building gazetteer with
coordinates and free-text hints, byte-for-byte identical to `venues.json`. The pack's copy is
what the client rendered; the copy in `src/` is what the check-in geofence measured against. A
fork that edited `venues.json`, exactly as the fork guide instructs, moved the pin on the map and
not the geofence, and its volunteers were refused while standing at the right desk.

### The shipped fork template could not run

`content/example-campus` is what `docs/FORK_GUIDE.md` tells a fork to copy. It declares TEAM_RED
and TEAM_BLUE. `GymSchema.controllingFaction` validated against `Object.values(Faction)` — three
HackIllinois team ids compiled into `src/models/gym.model.ts` — so two validators disagreed about
the same value: `crossValidate` passes any faction the pack declares, and Mongoose rejected
anything not in the enum.

It was demonstrated rather than argued. `example-campus` seeded only because its single territory
is NEUTRAL, the one id both lists share. Setting that territory to TEAM_RED — a faction its own
pack declares — produced `Gym validation failed … kind: 'enum', value: 'TEAM_RED'`. After the
fix, the same command seeds, and a scratch fork with its own venues, territories, beacons and
factions runs end to end.

### The plugin system had never executed

Activation read `env.PLUGINS`. `.env.example` ships it empty and nothing set it — not the demo
script, not CI, not the Dockerfile, not `render.yaml`, not any test. So `pluginRegistry.activated()`
was `[]` everywhere, `GET /api/v1/plugins` returned `[]` to a `public/plugins.js` that was wired
and shipped and had never been handed anything, and `plugins/hello-nexus/` — "the worked example
the fork guide points at" — had never run. `docs/PLUGINS.md` meanwhile said activation came from
the pack's `event.json`, whose `plugins` array was parsed and read by nobody.

It also had **zero tests**, and could not have had any: the four boot refusals called
`process.exit(1)` from the constructor and `PluginRegistry` was not exported, so any test that
reached a refusal would have taken the runner down with it. The four checks that exist
specifically to fail loudly were the four nothing could prove still fired.

### Two bugs that hurt the person, not the invariant

**The graveyard-shift bonus paid the evening.** `surgePricing.ts` exists because the 3 a.m.
rubbish run does not fill. Its circadian term read `getUTCHours()` with the peak at 03:30 *UTC* —
21:30 in Chicago. Real 3:30 a.m. landed where the cosine is exactly zero: **1.375 of a possible
2.5**, while the peak sat in the evening when shifts fill on their own. The comment beside it was
half right, which is why it survived: reading a UTC clock *is* correct, and it then treated UTC as
the event's clock. A second comment said the event timezone was "not yet something a pack can
set"; it is a required pack field that two other files already read.

**A momentary buffer fill froze a client and then evicted it.** `eventHub.sweep()` marked a
client `lagging` from a heartbeat that did not flush, under a comment claiming "same backpressure
bookkeeping as write()". It was not: `write()` attaches a `drain` listener to clear the flag, and
only when the flag is not already set — so a flag set by `sweep` could never clear. The client
was then sent no presence frames and was disconnected ten seconds later as unreachable, while
perfectly healthy. The population that happens to is phones on a congested campus network.

### A gym that told anyone who was where, and when

`GET /pokeshift/gyms` has no session requirement and returned whole gym documents:
`leaderVolunteerId`, `leaderName`, `lastBattledAt`, and `defenders[]` entries carrying
`volunteerName`, `contributedPower` and `assignedAt`. A gym is a named campus building and
contesting one requires standing within 75 m of it, so those fields said a named person was at a
named place at a stated moment — to anyone who asked, in the default auth mode, with no
credential and no audit row. The same disclosure had already been taken off the beacon listing
when `lastSpunUsers` was removed from it.

Gating the route would have been wrong — the territory map is meant to be readable by a hacker
who has not signed in. What was sensitive was the half nothing rendered: the client reads
`(g.defenders || []).length` and nothing else, checked rather than assumed.

### The fifth guard that cannot fire

`swap.service.ts` carried `if (shiftMap.size !== n) continue`, commented "incomplete mapping —
skip rather than half-rotate", five lines below a check that already proved the n volunteer ids
distinct over the same array. Deleting it changed no behaviour and reddened no test.

### 105 false sentences

47 in code comments, 58 in documentation, 100 repaired. The recurring shapes: claims of
exclusivity ("the one response in this file that does not go through `ticketFor`" — three of the
eight do not); ordering claims that read backwards (`resolveTicket`'s documented 403-then-409 is
409-then-403, because the transition check runs first); comments naming callers that no longer
call (`cellKeyForCluster` "remains for tests and for the lead heat map" — there is no heat map
anywhere in this repository); and six SSE event types named in ARCHITECTURE.md's sequence
diagrams that no code emits, so a client written from those diagrams subscribes to frames the
server never sends.

### Three tools, three wrong first versions

Worth recording because the lesson generalises: **a gate's exit code is not its result.**

`checkCommentsOnly.mjs` used a bare `ts.createScanner`, which has no parser context and cannot
tell an opening backtick from a closing one — it scans to the next backtick and swallows whole
functions. It accused eight innocent files. `checkPackDriven.mjs` stripped comments by deleting
them, which deleted their newlines and shifted every line below, so it reported a real hit at
`gym.model.ts:7` — inside the file header — for an enum member on line 45. And a jest assertion,
`expect(sent).not.toHaveBeenCalled()`, failed for a reason other than the one in its name: the
code legitimately broadcast its own `PLUGIN_DISABLED`.

All three exited with the status expected of them. All three were caught by reading the output.
The other session hit the same shape independently and it cost a failure attributed to the wrong
lane — `Received: 0` read as "closed without a code" when it was that test's own escape-hatch
timer winning a race with 85 ms of margin.

### Two new gates

`npm run comments:check` parses both versions of every changed `.ts` with the TypeScript parser,
walks to the leaf tokens, discards JSDoc subtrees and trivia, and compares the streams — so a
4,500-line comment diff can be *proved* to change no executable code rather than reviewed by eye.
Deliberately not in `verify.sh`: it compares the working tree to a git ref and goes red on any
legitimate code change.

`npm run pack:check` turns CONTRIBUTING.md's oldest rule — *nothing in `src/` names a building, a
faction or a colour* — into a gate, and needs no list of its own: it loads the active pack, takes
every string that is that event's content, and fails if any appears in `src/`. Twenty-six known
violations are enumerated in a baseline with a reason each. It is a baseline and not an exemption
list because a new violation in a baselined file still fails, and an entry that stops matching is
an **error** — so fixing something forces the list to shrink in the same change. Proved red three
ways on the real case before being called done.

### The state at the end

375 tests across 34 files, up from 340. `lint`, `docs:check`, `csp:audit` and `pack:check` clean.
`docs/EXTENDING.md` is new: the six seams in order of blast radius, what each costs, and what
checks you. The plugin manifest is populated for the first time and the other session confirmed
the tab renders, executes, and raises no CSP violation in a real browser.

## Round twenty — the second pack, in a browser, 2026-09-07

Three reviewers were launched against HEAD `20e933a`. Only one produced a verdict:

| reviewer | outcome |
|---|---|
| muse | 3 findings, all verified by grep, all true, all fixed |
| agy | **did not run** — individual quota exhausted, ~3h to reset |
| opencode | still running when this was written |

That agy did not run is recorded rather than rounded off. A round with one reviewer is a round
with one reviewer, and "muse clean" is not "three reviewers clean".

### What muse found

All three were mine, and two were the same defect: **the fix lands and the sentence stays.**

The presence tick was re-measured into `docs/PRESENCE.md` earlier the same day — p50 59 ms
clustered, 162 ms scattered, longest block 12.2 ms — and the numbers that re-measurement replaced
were left standing in `docs/DEMO.md` (still telling a demo-giver to lead with "about fifty
milliseconds" and "about 115 ms") and in `docs/WORKFLOWS.md` ("never holds the event loop for more
than about ten"). PRESENCE.md says in as many words that "about 115 ms is not a fair description of
162 ms" — written by the same hand that left the other two files quoting it. Both now lead with
the ratio, ~2.7x scattered over clustered, which is the claim that survives being run on another
machine.

`src/config/env.ts` said trusted egress gets a 10x allowance on "the two per-IP limiters that
consult them ... never an exemption". Three consult it, and the third — `StreamLimits`'s `PER_IP`
ceiling — skips the check outright. So an operator tuning `TRUSTED_EGRESS_CIDRS` from the env
contract expects a bounded stream ceiling at 10x and has none. **That comment has now been wrong
twice in the same spot**: it first said the ceilings "do not apply", and the correction introduced
the count that was also wrong, in the more dangerous direction. Count the callers before writing
"the two".

Two stale counts: DEMO said 32 files / 347 tests, ARCHITECTURE's matrix said 29 / 306. It is 34 and
375, measured by running the suite rather than by counting files. Both now carry a date and the
word snapshot.

### The gate that had to learn to read a line number

Citing `src/presence/service.ts:608` made `docs:check` fail — the rule stripped one trailing
punctuation mark and looked the whole string up as a path, so the most useful kind of citation in
the docs was a guaranteed false positive. Rather than avoid the form, the rule now splits the line
number off and checks both halves: the file exists, and the line is inside it. A citation pointing
past the end of a file is exactly the drift this gate is for and was previously unrepresentable.
Proved able to fail before being trusted: a planted `service.ts:9999` reports "has only 712 lines",
a planted `nosuch.ts:12` reports the missing file, restoring goes green.

What it deliberately does not check is whether the line still *says* what the sentence claims. No
cheap check knows that, and a gate that pretends to is one that passes for the wrong reason.

### The finding that mattered was not from a reviewer

The server has been pack-driven for two days. The client had never been booted against a second
pack. Doing it took one command:

```sh
CONTENT_PACK=example-campus PORT=3300 npm run demo
```

`public/app.js:918` throws `Cannot read properties of undefined (reading 'color')` and blanks the
entire Turf Wars board. `renderFactionStrip` builds its tally correctly and pack-driven at :913 —
`FACTION[g.controllingFaction] ? … : 'NEUTRAL'` — and four lines later, in the same function,
renders from a hard-coded roster of `TEAM_KERNEL`, `TEAM_TENSOR`, `TEAM_SILICON`. `applyFactions`
has already replaced `FACTION` with the pack's list, so the lookup is `undefined` and `.color`
throws. The guard exists at :913 and is missing at :918.

`GET /api/v1/pokeshift/gyms` returned 200 with correct data throughout. The server was right and
the client threw before drawing a row — and `docs/FORK_GUIDE.md` is what tells a fork to start from
`content/example-campus`, so this is the first thing a hacker following our own guide sees on the
flagship feature.

Three more of the same shape, none fatal: the Campus HUD control strip (`public/game.js:735`)
renders three phantom factions at zero and never shows the pack's real ones; every avatar in a
fork wears the neutral jacket (`public/avatar.js:423`); and `applyFactions` itself hands each of a
fork's factions the *unclaimed* CSS class (`public/app.js:93`). Plus "1 monuments are strongholds"
— a count made pack-driven an hour earlier, with no singular case.

**Every server-side check passed on that pack**: `content:validate`, the boot gate, 375 tests, 58
of 58 plan gates. They all run against the server. This class lives in the browser.

### Why no gate was added for it, which is the honest part

The obvious move is to extend `checkPackDriven` to `public/`. It was measured first: 74 hits, of
which about 30 are honest documented fallbacks — a 40% false-positive rate, worse than the
source-comment rule dropped that morning at nine-in-ten.

The sharper reason is that a grep could not have found the P0 anyway.
`['TEAM_KERNEL','TEAM_TENSOR','TEAM_SILICON','NEUTRAL']` is textually identical to the key set of
`FACTION_DEFAULTS` one file away, which is correct and necessary. What separates them is whether
anything rewrites the value before it is read, and that is a runtime property a text search cannot
see. The thing that found it was booting the app under the other pack and reading the console.

That is the gate worth having, and it needs a headless browser this repository does not depend on.
Adding one hours before a demo was not a call to make quietly, so the procedure is written into
`docs/FORK_GUIDE.md` §2 as a step a human runs, and the gap is stated there rather than papered
over. A missing gate that somebody knows about beats a gate that fires on the wrong thing.

### One fix of mine, verified against a fixture that could tell the difference

`eventLocalHour` was checked with the two packs at the same instant: `hackillinois-2027`
(`America/Chicago`) answered 14.63 while `example-campus` (`UTC`) answered 19.63. A version still
reading `getUTCHours` would have returned 19.63 for both, so the fixture discriminates. The offset
being five hours rather than six also confirms the reason `Intl` was used instead of a fixed offset
— it is September, so Chicago is on CDT.

### Verified after the fix, rather than taken on trust

The session that owns `public/` fixed it in `048b64e`. The claim was not accepted on the strength
of the commit message: the same reproduction was run again against a fresh boot of
`example-campus`. The faction strip now renders **RED 0 held / BLUE 0 held / UNCLAIMED 1 held ·
500 CP** — the pack's own factions, not three phantoms — the Clock Tower stronghold row draws with
its REINFORCE button, the `TypeError` is gone from the console, and the count reads "1 monument
**is** a stronghold", so the singular case was fixed with it.

One console error remains and is expected: `campus model 404`, because `example-campus` has no
baked campus until FORK_GUIDE §3 is done, and the Campus tab degrades to a RENDERER FAILED badge.
FORK_GUIDE §2 now names that one line explicitly as the single expected exception. Telling a forker
that *any* red line is a finding, when the very first boot always produces one, would be a check
people learn to skip — which is the same failure as a gate that fires on the wrong thing, and it
was introduced and removed in the same hour.
