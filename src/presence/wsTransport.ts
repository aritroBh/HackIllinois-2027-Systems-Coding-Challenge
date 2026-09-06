/**
 * WebSocket transport for presence (plan §A4) — the production path.
 *
 * The upgrade is authenticated three ways and never by a query string:
 *   1. the HttpOnly session cookie the browser attaches to a same-origin upgrade,
 *   2. an `Origin` that matches PUBLIC_URL or the request's own Host,
 *   3. the CSRF nonce carried as the `nexus.v1.<nonce>` subprotocol.
 * A failure answers 401/403 on the raw socket and never completes the handshake.
 *
 * Per connection: a 5-messages-per-2-seconds token bucket, a 20 s ping with a 30 s
 * terminate, and the shared stream-slot table (close 1013 when the table is full).
 * `bufferedAmount` over 64 KB skips the tick; over 256 KB, or ten consecutive skips,
 * closes the socket.
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

/** The 3-bit faction slots the wire rows use, in order — clients map index → colour. */
export const factionOrderIds = (): string[] => ['NEUTRAL', ...pack.factions.map((f) => f.id).filter((f) => f !== 'NEUTRAL')].slice(0, 8);
const SUBPROTOCOL_PREFIX = 'nexus.v1.';
const PING_MS = 20_000;
const DEAD_MS = 30_000;
const BUCKET_MSGS = 5;
const BUCKET_MS = 2_000;
const SKIP_BYTES = 64 * 1024;
const CLOSE_BYTES = 256 * 1024;
const MAX_SKIPS = 10;

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

function refuse(socket: import('stream').Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

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

  /** False when the bucket is empty — the caller closes with 1008. */
  takeToken(now = Date.now()): boolean {
    if (now - this.bucketAt >= BUCKET_MS) {
      this.bucket = BUCKET_MSGS;
      this.bucketAt = now;
    }
    if (this.bucket <= 0) return false;
    this.bucket -= 1;
    return true;
  }

  bufferedBytes(): number {
    return this.ws.bufferedAmount;
  }

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

    wss.handleUpgrade(req, socket, head, (ws) => {
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
  });
}

/** Shared by both transports: hello / pos / resync / bye. */
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
