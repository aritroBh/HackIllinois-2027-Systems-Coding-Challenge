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
