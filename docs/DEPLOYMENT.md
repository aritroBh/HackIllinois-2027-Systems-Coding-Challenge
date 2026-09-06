# Deployment

This runs as **one Node process** against **one MongoDB replica set**. The stream limits,
the presence table and the rate-limit buckets are all in memory and per process, so a second
replica would need its own or an external one. For an event of a few thousand people that
is the right trade, and it is the shape the load tests measure.

`docker-compose.yml` is the production-shaped version of everything below.

## The secrets the process refuses to boot without

In production, `src/config/env.ts` checks five things and exits rather than starting:

| Variable | Set it to |
|---|---|
| `MONGODB_URI` | your replica set URI. There is no in-memory fallback in production; a restart would lose every roster, karma total and ticket |
| `QR_HMAC_SECRET` | `openssl rand -hex 32`. The committed default mints forgeable attendance tokens |
| `SESSION_SECRET` | `openssl rand -hex 32`. The committed default mints forgeable session cookies |
| `ORGANIZER_SECRET` | `openssl rand -hex 32`. It is also the bootstrap credential for printing badge claim codes |
| `AUTH_MODE` | `required` |

Outside production these are replaced by random per-boot values so a fresh clone runs with
no setup. That convenience is exactly what the production guard exists to remove.

Set `PUBLIC_URL` to the https origin the browser sees. It is used for the WebSocket
`Origin` check, the magic-link URLs and the Adonix redirect, so a wrong value shows up as
presence refusing to connect.

## AUTH_MODE=required

In `required` mode the session cookie is the only identity. A body `volunteerId` naming
somebody other than your session is a 403, anonymous API calls are 401 except the sign-in
endpoints, `GET /api/v1/content`, `/health` and `/ready`, and creating accounts is
organiser-only. [IDENTITY.md](IDENTITY.md) is the full contract.

Production cannot run in `legacy` mode. That mode is the open demo, where a request may
simply claim to be anyone.

## Mongo needs a replica set

The application uses multi-document transactions, and MongoDB only offers them on a replica
set. A single-node replica set is enough and is what the compose file runs: `mongod
--replSet rs0` plus a one-shot `rs.initiate()` that is a no-op on later boots. A standalone
`mongod` will fail every transactional path, which is most of the interesting ones.

Run the migration on every deploy. It is idempotent:

```sh
MONGODB_URI=... npx tsx scripts/migrate.ts
```

## Behind a proxy

Two settings, and both are wrong by default for a proxied deployment.

**`TRUST_PROXY_HOPS`** is the number of proxies in front of this process. At `0` every
client resolves to the proxy's address and shares one rate-limit bucket. Set it to the real
hop count and no higher: too large a value lets a client spoof `X-Forwarded-For` and evade
the limit entirely.

**`TRUSTED_EGRESS_CIDRS`** is the venue's NAT egress, comma-separated IPv4 CIDRs. A
thousand people on venue Wi-Fi arrive from a handful of addresses, so the per-IP anti-abuse
ceilings would lock the venue out. Addresses in this list are exempt from the per-IP stream
and rate ceilings, and capacity is controlled per account instead. They are never exempt
from authentication, and anonymous stream slots stay capped even on trusted egress. Find
the ranges from campus networking before the event, not during it.

**Socket timeouts.** The defaults (`KEEP_ALIVE_TIMEOUT_MS=10000`,
`HEADERS_TIMEOUT_MS=15000`) are correct for a directly exposed process and wrong behind a
load balancer. ALB, GCP and nginx all idle at 60 s upstream; if this process closes an idle
socket first, the proxy sends a request into a closing connection and returns 502. Make the
backend outlive the proxy: `KEEP_ALIVE_TIMEOUT_MS=65000` and `HEADERS_TIMEOUT_MS=70000`
against a 60 s proxy. Keep `REQUEST_TIMEOUT_MS > HEADERS_TIMEOUT_MS > KEEP_ALIVE_TIMEOUT_MS`.

Set `CORS_ORIGIN` to your origin. The default `*` is a demo default.

## TLS is not optional

In production the session cookie is named `__Host-nexus` and the CSRF nonce
`__Host-nexus_csrf`. The `__Host-` prefix is a browser-enforced contract: the cookie must
be `Secure`, must have no `Domain` attribute and must be path `/`. A browser will simply
refuse to store it over plain http, so **the process must sit behind TLS termination or
nobody can sign in.** There is no flag to turn this off; development uses unprefixed,
non-`Secure` cookie names instead, which is what lets a phone on the LAN test against a
laptop.

Terminate TLS at the proxy, forward to the process over the internal network, and set
`TRUST_PROXY_HOPS` to match.

## What to watch

`GET /health` never touches the database, so it stays cheap and cannot be made to fail by a
slow query. It is liveness, and it is also the operational dashboard.

`GET /ready` reports the Mongoose connection state and returns 503 when it is not
connected. Point the load balancer at this one so an instance drains during a database
outage instead of holding requests that will hang. The compose healthcheck already does.

In the `/health` body:

* **`streams.slots.total` against `totalSlots`.** This is the live SSE and WebSocket
  connection table. Approaching the ceiling means real people will be refused, and the fix
  is capacity, not a bigger number.
* **`streams.slots.anonymous` against `anonSlots`.** Anonymous streams have their own small
  budget on purpose. Saturation here usually means a client is reconnecting without a
  session rather than that the event grew.
* **`presence.p95TickMs`.** The presence tick budget is 30 ms. Two consecutive ticks over
  it drop every client to cluster-only rows.
* **`presence.clusterMode`.** If this is `true` during the event, the map has degraded to
  counts. It should never fire at the size the soak measured.
* **`jobs[].lastError`.** Background jobs report their last failure here rather than only in
  the log.

`authMode` is in the body too. If it says `legacy` in production, something is very wrong,
though the boot guard should have prevented it.

## Before the doors open

Boot once against the real database with the real secrets. Sign in with a badge claim code
from the printed CSV, not with a developer shortcut, because the dev login route is not
registered in production at all. Confirm presence connects over wss. Then check
`/health` once from outside the venue network and once from inside it, so you know both
paths work before a thousand people try the second one.
