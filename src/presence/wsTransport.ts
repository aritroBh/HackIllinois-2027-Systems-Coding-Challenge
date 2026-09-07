/**
 * WebSocket transport for presence (plan §A4) — the production path.
 *
 * The upgrade is authenticated three ways and never by a query string:
 *   1. the HttpOnly session cookie the browser attaches to a same-origin upgrade,
 *   2. an `Origin` that matches PUBLIC_URL or the request's own Host,
 *   3. the CSRF nonce carried as the `nexus.v1.<nonce>` subprotocol.
 * A failure answers 401/403 on the raw socket and never completes the handshake.
 *
 * Per connection: a 5-messages-per-2-seconds token bucket, a 20 s ping with a 30 s terminate,
 * and a slot from the shared stream-limit table. A table with no slot to give refuses the
 * upgrade with a 503 written on the raw socket — the handshake never completes, so there is no
 * close code to send. 1013 is the *replacement* close instead: an account at its two-stream cap
 * has its oldest WebSocket closed with 1013 to make room, never its SSE leg — and if it holds
 * no WebSocket to replace, the upgrade is admitted rather than refused. `bufferedAmount` over
 * 64 KB skips the tick; over 256 KB, or ten consecutive skips, closes the socket, also 1013.
 */
import http from 'http';
import { URL } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { env } from '../config/env';
import { resolveAccountFromCookies } from '../middleware/identity';
import { streamLimits } from '../common/streamLimits';
import type { SlotHandle } from '../common/streamLimits';
import type { AccountContext } from '../common/types/account';
import { presenceService } from './service';
import { presenceStore } from './store';
import { pack } from '../content/loader';
import type { PresenceClient } from './transport';

export const PRESENCE_PATH = '/ws/presence';

/**
 * The 3-bit faction slots the wire rows use, in order — clients map index → colour.
 *
 * Sent in `hello_ack`, and it has to agree with the table `session.setFactionOrder` installs,
 * because that is what turns a faction id into the three bits in a row's flag byte. The two are
 * derived independently from the same `pack.factions`, by the same expression written twice;
 * they agree today by construction rather than by anything enforcing it, and a client handed a
 * different order would recolour every player on the map.
 */
export const factionOrderIds = (): string[] => ['NEUTRAL', ...pack.factions.map((f) => f.id).filter((f) => f !== 'NEUTRAL')].slice(0, 8);
const SUBPROTOCOL_PREFIX = 'nexus.v1.';
const PING_MS = 20_000;
const DEAD_MS = 30_000;
const BUCKET_MSGS = 5;
const BUCKET_MS = 2_000;
const SKIP_BYTES = 64 * 1024;
const CLOSE_BYTES = 256 * 1024;
const MAX_SKIPS = 10;

/**
 * The cross-site half of the upgrade check.
 *
 * A WebSocket handshake is not subject to the same-origin policy: any page on any site can
 * open one to this host, and the browser will attach the session cookie to it, so the cookie
 * on its own proves nothing about who asked. `Origin` is the header the browser sets and a
 * script cannot, which is what makes it worth reading here.
 *
 * A *missing* `Origin` is allowed on purpose, and that is not the hole it looks like: browsers
 * always send one on a handshake, so the case only arises for non-browser clients — the tests
 * and the load generator — which have no ambient cookie to be abused with. Those still have to
 * present a valid session and the CSRF nonce.
 */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (tests, the load generator): the cookie still gates it
  try {
    const o = new URL(origin);
    const host = req.headers.host;
    if (host && o.host === host) return true;
    return o.host === new URL(env.PUBLIC_URL).host;
  } catch {
    return false;
  }
}

/**
 * Answer a rejected upgrade on the raw socket.
 *
 * Nothing has been negotiated at this point — there is no WebSocket yet, so there is no close
 * frame and no close code to send. Writing a minimal HTTP response is the only way to say why
 * it was refused — 401 without a session, 403 for a bad origin or a bad nonce, 503 when the
 * stream-limit table has no slot — and a socket destroyed silently would leave a legitimate
 * client unable to tell "you are signed out" from "come back later".
 */
function refuse(socket: import('stream').Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * One authenticated socket, wrapped so the session layer never sees `ws`.
 *
 * All the per-connection defence lives here rather than in the session: the inbound token
 * bucket, the outbound backpressure ladder, and the slot handle that has to be released when
 * the socket goes. `binary` is not readonly because it is settled by the client's `hello`,
 * which arrives after construction.
 */
class WsPresenceClient implements PresenceClient {
  public binary = false;
  private skips = 0;
  private bucket = BUCKET_MSGS;
  private bucketAt = Date.now();
  public alive = true;

  constructor(
    public readonly id: string,
    public readonly account: AccountContext,
    private readonly ws: WebSocket,
    public readonly slot: SlotHandle
  ) {}

  readonly transport = 'ws' as const;

  /**
   * False when the bucket is empty — the caller closes with 1008.
   *
   * A fixed window rather than a sliding one, so five messages at the end of one window and
   * five at the start of the next do pass ten in quick succession. That is tolerated: the
   * server reads at most 4 KB per message (`maxPayload`) and a `pos` beyond one every two
   * seconds is refused by the store's own rate gate anyway, so the bucket is here to stop a
   * socket burning CPU on parsing, not to enforce the sampling interval.
   *
   * A single refusal closes the connection instead of dropping the message, because a client
   * that has outrun this is either broken or not a browser client at all.
   */
  takeToken(now = Date.now()): boolean {
    if (now - this.bucketAt >= BUCKET_MS) {
      this.bucket = BUCKET_MSGS;
      this.bucketAt = now;
    }
    if (this.bucket <= 0) return false;
    this.bucket -= 1;
    return true;
  }

  /** Part of the `PresenceClient` contract; `guard` reads `bufferedAmount` itself, and no other caller exists. */
  bufferedBytes(): number {
    return this.ws.bufferedAmount;
  }

  /**
   * The backpressure ladder, checked before every frame.
   *
   * A slow socket is the one failure mode a 1 Hz broadcast cannot ride out: frames arrive
   * whether or not the last one drained, and an unbounded send queue is the process's memory.
   * Dropping is the right answer rather than queueing, because a presence frame is superseded
   * by the next tick a second later — nothing here is worth delivering late.
   *
   * Two thresholds, and the gap between them is the point. Over 64 KB the tick is skipped and
   * the socket is given a chance to catch up, which is what a phone passing through a lift
   * does. Ten consecutive skips — a handful of seconds, since a tick passes through here more
   * than once for a binary client — is a socket that is not draining at all, so it is closed
   * rather than skipped forever; 256 KB buffered closes it at once without waiting out the ten.
   * The counter resets on any frame that does go out, so a single bad second costs nothing.
   */
  private guard(): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const buffered = this.ws.bufferedAmount;
    if (buffered > CLOSE_BYTES) {
      this.close(1013, 'backpressure');
      return false;
    }
    if (buffered > SKIP_BYTES) {
      this.skips += 1;
      if (this.skips >= MAX_SKIPS) this.close(1013, 'backpressure');
      return false;
    }
    this.skips = 0;
    return true;
  }

  send(msg: unknown): boolean {
    if (!this.guard()) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(buf: ArrayBuffer): boolean {
    if (!this.guard()) return false;
    this.ws.send(Buffer.from(buf), { binary: true });
    return true;
  }

  close(code = 1000, reason = ''): void {
    try { this.ws.close(code, reason); } catch { /* already closing */ }
  }
}

/**
 * slot id → the client holding it, so a replaced slot can close its socket rather than
 * leaving it open and still ticking.
 */
const bySlot = new Map<number, WsPresenceClient>();

/** Test/ops hook: how many live WebSocket clients this process is holding. */
export function wsClientCount(): number {
  return bySlot.size;
}

/**
 * Register the presence upgrade handler on the shared HTTP server.
 *
 * `upgrade` is a server event rather than a route, so every handler registered here sees every
 * upgrade on the process. A request for another path returns without touching the socket, which
 * is what lets something else own its own upgrade path without this one destroying it first.
 *
 * The three checks run cheapest-first: the `Origin` header is a string comparison, resolving
 * the cookie is real work, and the nonce comparison needs the resolved session to check
 * against. None of them reads the query string — a credential there would survive in access
 * logs and in a `Referer`, and the browser will attach the cookie without being asked.
 *
 * A no-op when `PRESENCE_ENABLED` is off. Presence is a subsystem the event can run without
 * rather than one that has to be stubbed: with the flag down this is the only `upgrade`
 * listener the process would have registered, so Node destroys an upgrade it cannot hand to
 * anyone and no half-live socket is left behind.
 */
export function attachPresenceWs(server: http.Server): void {
  if (!env.PRESENCE_ENABLED) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', async (req, socket, head) => {
    let path = '';
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { path = ''; }
    if (path !== PRESENCE_PATH) return; // another upgrade handler may own it
    if (!originOk(req)) return refuse(socket, 403, 'Forbidden');

    const resolved = await resolveAccountFromCookies(req.headers.cookie);
    if (!resolved) return refuse(socket, 401, 'Unauthorized');

    // The CSRF nonce rides in the subprotocol; the browser echoes it back on success.
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const carrier = offered.find((p) => p.startsWith(SUBPROTOCOL_PREFIX));
    if (!carrier || !resolved.csrfNonceOk(carrier.slice(SUBPROTOCOL_PREFIX.length))) {
      return refuse(socket, 403, 'Forbidden');
    }

    const ip = (req.socket.remoteAddress ?? 'unknown');
    const acquired = streamLimits.tryAcquire({ transport: 'ws', accountId: resolved.account.id, ip });
    if (!acquired.ok) return refuse(socket, 503, 'Service Unavailable');
    // The slot table frees the replaced slot, but the SOCKET on the other end of it is
    // still open and still receiving ticks. Without closing it, one authenticated account
    // could open connections forever: the accounting says two, the process holds hundreds.
    // (The SSE hub does the same thing through `evictBySlot`.)
    if (acquired.evict) {
      const stale = bySlot.get(acquired.evict.id);
      bySlot.delete(acquired.evict.id);
      stale?.close(1013, 'replaced by a newer connection');
    }

    // The slot is acquired before the handshake and released by the socket's `close` handler,
    // which is attached inside the callback below — so an upgrade that never reaches the
    // callback leaks the slot permanently. A client that aborts the TCP connection mid-handshake
    // or sends a malformed one does exactly that, and slots are the ceiling that decides whether
    // real people can connect: leaking them is a denial of service that costs the attacker a
    // half-open connection each.
    //
    // Guarded on both sides. `handleUpgrade` can throw synchronously, and a socket that errors
    // or closes before the callback runs never calls it at all; `settled` makes the release
    // idempotent so the normal path — where the callback does run and `close` releases later —
    // cannot double-free.
    let settled = false;
    const releaseUnlessUpgraded = (): void => {
      if (settled) return;
      settled = true;
      streamLimits.release(acquired.slot);
    };
    socket.once('error', releaseUnlessUpgraded);
    socket.once('close', releaseUnlessUpgraded);

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
      settled = true; // the callback owns the slot now; `ws.on('close')` releases it.
      socket.removeListener('error', releaseUnlessUpgraded);
      socket.removeListener('close', releaseUnlessUpgraded);
      const id = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const client = new WsPresenceClient(id, resolved.account, ws, acquired.slot);
      bySlot.set(acquired.slot.id, client);
      const session = presenceService.add(client);
      let lastSeen = Date.now();

      const ping = setInterval(() => {
        if (Date.now() - lastSeen > DEAD_MS) { ws.terminate(); return; }
        try { ws.ping(); } catch { /* closing */ }
      }, PING_MS);
      ping.unref?.();

      ws.on('pong', () => { lastSeen = Date.now(); });
      ws.on('message', async (raw, isBinary) => {
        lastSeen = Date.now();
        if (isBinary) return; // clients never send binary
        if (!client.takeToken()) { client.close(1008, 'too many messages'); return; }
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(raw)) as Record<string, unknown>; } catch { client.send({ t: 'nack', reason: 'BAD_JSON' }); return; }
        await handleMessage(session, client, msg);
      });
      ws.on('close', () => {
        clearInterval(ping);
        bySlot.delete(acquired.slot.id);
        streamLimits.release(acquired.slot);
        presenceService.remove(id);
      });
      ws.on('error', () => { try { ws.terminate(); } catch { /* gone */ } });
      });
    } catch {
      // A malformed handshake throws here rather than calling back. Release and drop the
      // socket; without this the slot is held for the lifetime of the process.
      releaseUnlessUpgraded();
      try { socket.destroy(); } catch { /* already gone */ }
    }
  });
}

/**
 * The four client messages: hello, pos, resync, bye.
 *
 * Written against `PresenceClient` and never touching a socket, so it *could* serve either
 * transport — but the WebSocket `message` handler above is its only caller. The SSE leg has no
 * message channel at all: its `pos` is `POST /api/v1/presence`, its `bye` is the `DELETE`
 * beside it, its hello is implied by the first POST, and it has no `resync` because it cannot
 * be told to ask for one. Do not read the parameter types as evidence that the fallback shares
 * this code.
 *
 * `hello` decides the row encoding for the life of the connection, and the default is binary:
 * only an explicit `enc:'json'` opts out. An SSE client cannot reach this, and would be forced
 * to JSON by the transport test even if it did.
 *
 * A rejected `pos` is answered only for `MUTED`, `SPEED_STRIKE` and `OPT_OUT` — the three that
 * mean the client is publishing nothing at all until it or the clock changes something. The
 * other four verdicts the store can return (off-campus, inaccurate, too fast, and the 2 s rate
 * gate) are dropped in silence, so a phone with a poor indoor fix sampling every second is not
 * sent a rejection every second for it.
 */
export async function handleMessage(
  session: import('./session').PresenceSession,
  client: PresenceClient & { binary: boolean },
  msg: Record<string, unknown>
): Promise<void> {
  const now = Date.now();
  switch (msg.t) {
    case 'hello': {
      session.helloAt = now;
      client.binary = client.transport === 'ws' && msg.enc !== 'json';
      const facts = await presenceService.factsFor(client.account.id, now);
      const cfg = presenceStore.cfg;
      client.send({
        t: 'hello_ack',
        tick: presenceService.stats.ticks,
        serverTime: now,
        enc: client.binary ? 'bin' : 'json',
        fuzz: cfg.fuzzGridMeters,
        interestM: cfg.interestRadiusMeters,
        detail: session.detailCap,
        metersPerUnit: cfg.metersPerUnit,
        factions: factionOrderIds(),
        you: facts
          ? { id: facts.id, name: facts.name, kind: facts.kind, faction: facts.faction, optIn: facts.optIn, muted: facts.muteUntil > now }
          : null,
        mode: presenceService.stats.clusterMode ? 'clusters' : 'full',
      });
      return;
    }
    case 'pos': {
      const r = await presenceService.submit(client.account.id, {
        lat: Number(msg.lat), lng: Number(msg.lng), acc: Number(msg.acc),
        h: msg.h === undefined ? undefined : Number(msg.h),
        spd: msg.spd === undefined ? undefined : Number(msg.spd),
      }, now);
      if (!r.ok && (r.reason === 'MUTED' || r.reason === 'SPEED_STRIKE' || r.reason === 'OPT_OUT')) {
        client.send({ t: 'nack', reason: r.reason });
      }
      return;
    }
    case 'resync':
      session.requestResync();
      return;
    case 'bye':
      client.close(1000, 'bye');
      return;
    default:
      client.send({ t: 'nack', reason: 'UNKNOWN' });
  }
}
