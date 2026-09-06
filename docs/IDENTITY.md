# Identity — how people sign in, and how organisers run it

Nexus Quest has one session and three ways to get one. Every adapter ends in the same
HttpOnly cookie; the rest of the system only ever sees `req.account`.

## The two modes

| `AUTH_MODE` | Who can call the API | Body `volunteerId` |
|---|---|---|
| `legacy` (default outside production) | anyone; anonymous reads and writes work | believed — this is the zero-setup demo and the original test contract |
| `required` (forced in production) | a session cookie, except the sign-in endpoints (incl. claim-code issuance behind the organiser secret), `GET /api/v1/content`, `/health`, `/ready` | ignored; a body `volunteerId`/`proposerVolunteerId` naming someone other than your session is a 403 `IDENTITY_MISMATCH` (leads and organisers are exempt so they can act on behalf of a volunteer) |

`REQUIRE_AUTH=true` is accepted as a deprecated alias for `AUTH_MODE=required`.

## Cookies

* `__Host-nexus` (production) / `nexus` (development): the session. HttpOnly, SameSite=Lax,
  48 h. The session token never appears in a response body, header or log (the CSRF nonce
  does, by design). **Sign-out revokes**: `POST /api/v1/auth/logout` bumps the account's
  `sessionVersion`, so a copied cookie dies with it (all tabs and devices — right for shared
  event laptops).
* `__Host-nexus_csrf` / `nexus_csrf`: the CSRF nonce, JS-readable on purpose. Every
  cookie-authenticated mutation must echo it in `X-CSRF-Token`; WebSocket upgrades (M4)
  echo it in `Sec-WebSocket-Protocol: nexus.v1.<nonce>`. Missing or wrong → 403 `CSRF_INVALID`.
* Development drops the `__Host-` prefix and `Secure` so `npm run demo` and a phone on the
  LAN work over plain http. Production must terminate TLS in front of the process.

## Adapter 1 — badge claim codes (always on)

Ten Crockford-base32 characters (no I, L, O, U), single use, hashed at rest.

Print codes for badges:

```bash
# one account
curl -X POST http://localhost:3000/api/v1/auth/claim-codes \
  -H 'X-Organizer-Secret: <ORGANIZER_SECRET>' -H 'Content-Type: application/json' \
  -d '{"email":"casey@illinois.edu","ttlHours":72}'

# everyone, as CSV (accountId,name,email,code,expiresAt) — print this before the event
curl -X POST http://localhost:3000/api/v1/auth/claim-codes/bulk \
  -H 'X-Organizer-Secret: <ORGANIZER_SECRET>' -H 'Accept: text/csv' \
  -H 'Content-Type: application/json' -d '{"kind":"VOLUNTEER"}' > claim-codes.csv
```

An ORGANIZER/ADMIN session works in place of the secret header. The badge QR should encode
`https://<PUBLIC_URL>/dashboard/#claim=<CODE>` — a URL fragment, so the code never reaches
server or proxy logs. Redeem: `POST /api/v1/auth/claim {code}` — 30/min per IP, 300/min for
addresses in `TRUSTED_EGRESS_CIDRS` (the venue NAT is never exempt, only allowed more); fifty
failed claims in an hour raise `CLAIM_BRUTE_FORCE` on the announce channel.

## Adapter 2 — email magic link

Enabled when `SMTP_URL` is set (always enabled in development, where the link is printed to
the server log instead of being mailed). `POST /api/v1/auth/magic-link {email}` always
answers 202 with an identical body in every environment (no enumeration oracle); if the address belongs to an account a 15-minute single-use link
`<PUBLIC_URL>/dashboard/#magic=<token>` is mailed. The page exchanges it with
`POST /api/v1/auth/magic {token}`.

## Adapter 3 — Adonix (HackIllinois SSO)

Enable with `ADONIX_ENABLED=true`. `ADONIX_URL` comes from the environment only (never a
content pack). The login screen sends the browser to
`${ADONIX_URL}/auth/login/github?redirect=${PUBLIC_URL}/dashboard/auth/adonix`; the landing
page moves the returned token into `#adonix=<token>` immediately and posts it to
`POST /api/v1/auth/adonix {token}`. **Adonix must return the token in the URL fragment**; the
server's request log (morgan) drops the query string for `/dashboard/auth/adonix` regardless.

Verification: with `ADONIX_JWT_SECRET` the token is verified as an HS256 JWT locally (a
numeric `exp` in the future is mandatory); otherwise it is exchanged against
`GET ${ADONIX_URL}/user/` and `/auth/roles/` (4 s timeout). The role set must be one we know
(`ADMIN`, `STAFF`, `VOLUNTEER`, `ATTENDEE`/`USER`) or the login fails closed.

**Trust boundary.** Only the Adonix *subject* identifies an account. An unknown subject
creates a **HACKER** account, whatever role Adonix claims — staff accounts are created by
organisers (CSV / claim codes) and connect Adonix afterwards. An unknown subject whose
email matches an existing account is refused with 409 `ACCOUNT_LINK_REQUIRED` (upstream
email is unverified from our side; honouring it would let a spoofed SSO take over any
volunteer whose address is known). To link: sign in with your badge code, then post the
Adonix token from that signed-in session — it is linked to your account, role unchanged.

`ADONIX_ENABLED` is a static flag: if Adonix is unreachable the login attempt fails with
503 and the badge code remains the fallback; the provider list does not probe upstream.

## Accounts

Both volunteers and hackers are `Volunteer` documents with a `kind`. `kind` decides
staff-only actions (shifts, check-in, swaps, SOS dispatch/resolve); `role` decides
lead/organiser powers; the model enforces `kind === HACKER ⇔ role === HACKER`.

* Lost phone / leaked code: `POST /api/v1/auth/revoke/:accountId` (lead or above) bumps the
  account's `sessionVersion`; every cookie minted before it stops working within 60 s.
* Promote/demote staff: `PATCH /api/v1/auth/accounts/:id/role {role}` (organiser). Role
  changes and revocations follow a rank rule: a caller may only grant roles below their own
  and only act on accounts below their own; `ADMIN` alone may create admins or revoke an
  organiser or admin. Elsewhere `ADMIN` and `ORGANIZER` are treated identically.
* Creating accounts (`POST /api/v1/volunteers`) is organiser-only in `required` mode, so
  nobody can mint accounts to multiply their per-account rate budget.
* `POST /api/v1/auth/dev-login {accountId}` exists only outside production (the route is not
  registered there); it is what keeps `npm run demo` zero-setup.

## Migration

Existing databases: `npx tsx scripts/migrate.ts` (needs `MONGODB_URI`). It drops the old
non-sparse unique index on `volunteers.email`, backfills the new fields and syncs indexes.
Idempotent; safe to run on every deploy.

### Linking Adonix to an existing account

A signed-in person who arrives with `#adonix=<token>` is **linking**, not signing in. The page holds the token in memory and asks them to confirm; only the confirm button sends `POST /auth/adonix {token, link: true}`. Without `link: true` the server answers `409 ACCOUNT_LINK_CONFIRM` and links nothing. This closes the login-CSRF account-tying attack (send a victim to a URL carrying the attacker's token) even if a future client forgets the dialog.

### Revocation hierarchy

`POST /auth/revoke/:id` is lead+, but a caller may only revoke accounts **below** their own role (or themselves). ORGANIZER revokes leads and volunteers; only ADMIN revokes organizers or admins. Revocation and role changes evict the 60 s account cache immediately.
