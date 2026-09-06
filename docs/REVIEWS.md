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
