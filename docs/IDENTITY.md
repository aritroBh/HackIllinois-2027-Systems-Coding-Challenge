# Identity — how people sign in, and how organisers run it

Nexus Quest has one session and three ways to get one. Every adapter ends in the same
HttpOnly cookie; the rest of the system only ever sees `req.account`.

## The two modes

| `AUTH_MODE` | Who can call the API | Body `volunteerId` |
|---|---|---|
| `legacy` (default outside production) | anyone; anonymous reads and writes work | believed — this is the zero-setup demo and the original test contract |
| `required` (forced in production) | a session cookie, except the sign-in endpoints, `GET /api/v1/content`, `/health`, `/ready` | ignored; naming someone other than your session is a 403 `IDENTITY_MISMATCH` |

`REQUIRE_AUTH=true` is accepted as a deprecated alias for `AUTH_MODE=required`.

## Cookies

* `__Host-nexus` (production) / `nexus` (development): the session. HttpOnly, SameSite=Lax,
  48 h. Never appears in a response body, header or log.
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
server or proxy logs. Redeem: `POST /api/v1/auth/claim {code}` (30/min per IP; fifty failed
claims in an hour raise `CLAIM_BRUTE_FORCE` on the announce channel).

## Adapter 2 — email magic link

Enabled when `SMTP_URL` is set (always enabled in development, where the link is printed to
the server log and returned as `debugLink`). `POST /api/v1/auth/magic-link {email}` always
answers 202; if the address belongs to an account a 15-minute single-use link
`<PUBLIC_URL>/dashboard/#magic=<token>` is mailed. The page exchanges it with
`POST /api/v1/auth/magic {token}`.

## Adapter 3 — Adonix (HackIllinois SSO)

Enable with `ADONIX_ENABLED=true`. `ADONIX_URL` comes from the environment only (never a
content pack). The login screen sends the browser to
`${ADONIX_URL}/auth/login/github?redirect=${PUBLIC_URL}/dashboard/auth/adonix`; the landing
page moves the returned token into `#adonix=<token>` immediately and posts it to
`POST /api/v1/auth/adonix {token}`. **Adonix must return the token in the URL fragment**; the
server redacts the query string for `/dashboard/auth/adonix` in its logs regardless.

Verification: with `ADONIX_JWT_SECRET` the token is verified as an HS256 JWT locally;
otherwise it is exchanged against `GET ${ADONIX_URL}/user/` and `/auth/roles/` (4 s timeout).
Roles map `ADMIN→ADMIN`, `STAFF→ORGANIZER`, `VOLUNTEER→VOLUNTEER`, `ATTENDEE/USER→HACKER`;
anything else fails closed. Unknown people become HACKER accounts; existing accounts keep
their role (Adonix never downgrades staff). If Adonix is down the provider reports itself
disabled and badge codes carry the event.

## Accounts

Both volunteers and hackers are `Volunteer` documents with a `kind`. `kind` decides
staff-only actions (shifts, check-in, swaps, SOS dispatch/resolve); `role` decides
lead/organiser powers; the model enforces `kind === HACKER ⇔ role === HACKER`.

* Lost phone / leaked code: `POST /api/v1/auth/revoke/:accountId` (lead or above) bumps the
  account's `sessionVersion`; every cookie minted before it stops working within 60 s.
* Promote/demote staff: `PATCH /api/v1/auth/accounts/:id/role {role}` (organiser).
* `POST /api/v1/auth/dev-login {accountId}` exists only outside production (the route is not
  registered there); it is what keeps `npm run demo` zero-setup.

## Migration

Existing databases: `npx tsx scripts/migrate.ts` (needs `MONGODB_URI`). It drops the old
non-sparse unique index on `volunteers.email`, backfills the new fields and syncs indexes.
Idempotent; safe to run on every deploy.
