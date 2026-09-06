/**
 * Server-Sent Events broadcast hub — the push half of the live war room.
 *
 * SSE carries the ops events: a waitlist promotion, a gym flip, an SOS dispatch. It buys
 * automatic browser reconnection, plain HTTP semantics through proxies, and no second
 * protocol to secure. Presence is the exception: a 1 Hz bidirectional position stream rides
 * a WebSocket (`src/presence/wsTransport.ts`), and falls back to the SSE `presence` channel
 * here when the upgrade is refused. Both transports draw on the stream-limit table in
 * `src/common/streamLimits.ts`, so a device's connections are counted in one place.
 *
 * **Channels.** Every event lives on exactly one of `ops | sos | game | presence |
 * presence:exact | announce | me`. The ~20 existing `broadcast({type, data})` call sites
 * name no channel; `CHANNEL_OF_TYPE` infers it from the type prefix so they stay untouched.
 * Clients subscribe with `?channels=a,b` (default `ops,sos,game,announce`).
 *
 * **Authorisation is per channel and enforced here**, because the route is mounted before
 * the API limiter and the identity middleware only *attaches* `req.account` — it does not
 * decide who may see what. In `AUTH_MODE=required` every channel except `announce` needs an
 * account, `presence:exact` needs lead-or-above, and `sos` is *redacted* for everyone below
 * lead (`redactSos`: ticket id, status, venue, category, urgency — no coordinates, no table
 * text, no hacker name). The ticket's own parties get the full ticket over the targeted
 * `me` channel via `sendToAccount`. In `legacy` mode the stream stays open exactly as
 * before so the existing suites and the demo dashboard keep working. Unauthorised channels
 * are dropped silently; a client left with nothing gets a 403.
 *
 * **Wire format.** v1 (`event: TYPE\ndata: <json>`) is byte-identical to what shipped, for
 * clients that never send `v=2`. v2 adds `id: <seq>` and wraps the payload in
 * `{v, ts, ch, data}` so a client can tell channels apart and resume.
 *
 * **Replay.** A per-channel ring buffer (200 events / 60 s) for `ops`, `sos`, `game`,
 * `announce` — never `presence` (stale positions are worse than none) or `me` (targeted).
 * A client reconnecting with `Last-Event-ID` gets the events it missed, filtered by its
 * channels and redaction; if its id predates the buffer it gets one `RESYNC` and refetches.
 * Sequence ids are one monotonically increasing integer per process.
 *
 * **Backpressure.** `res.write()` returning `false` marks the client `lagging`; while
 * lagging, presence frames are dropped (the next one supersedes them anyway). `drain`
 * clears the flag. A client is evicted when its write buffer exceeds 512 KiB or it has
 * lagged for 10 s — checked on the heartbeat sweep — so one stalled tab cannot pin
 * memory for the life of the process.
 *
 * **Half-open sockets.** A laptop lid closing never fires `close`. Every write path checks
 * `destroyed`/`writableEnded` first and drops the client, and the 15 s heartbeat comment
 * frame (unref'd, skipped under `NODE_ENV=test`) is the loop that catches the rest.
 *
 * Delivery is best-effort by design: a write that throws evicts the client rather than
 * failing the operation that triggered it. A volunteer's registration must not roll back
 * because a dashboard tab went away.
 *
 * Fan-out is O(clients) per event on the event loop; `scripts/benchmarks/sse-fanout.ts`
 * measures it. Beyond one process this needs an external bus — each instance only knows
 * its own map.
 */
import { Request, Response } from 'express';
import { env } from '../../config/env';
import { AccountContext, isLeadOrAbove } from '../types/account';
import { ErrorCode } from '../errors/errorCodes';
import { streamLimits, SlotHandle } from '../streamLimits';

export type Channel = 'ops' | 'sos' | 'game' | 'presence' | 'presence:exact' | 'announce' | 'me';

export const CHANNELS: ReadonlySet<Channel> = new Set<Channel>([
  'ops',
  'sos',
  'game',
  'presence',
  'presence:exact',
  'announce',
  'me',
]);

export const DEFAULT_CHANNELS: readonly Channel[] = ['ops', 'sos', 'game', 'announce'];

/** Channels whose events are held for replay. Presence is ephemeral; `me` is targeted. */
const REPLAY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['ops', 'sos', 'game', 'announce']);
const REPLAY_MAX_EVENTS = 200;
const REPLAY_MAX_AGE_MS = 60_000;

const LAG_EVICT_BYTES = 512 * 1024;
const LAG_EVICT_MS = 10_000;
const HEARTBEAT_MS = 15_000;

export interface ISSEMessage {
  type: string;
  channel?: string;
  data: unknown;
  timestamp?: number;
}

/**
 * Exact type names first (an `SOS_ESCALATED` alarm belongs on `announce`, not `sos`), then
 * prefixes in declaration order. Anything unknown lands on `ops` so a new event type is
 * visible on the default subscription rather than vanishing.
 */
const EXACT_CHANNEL_OF_TYPE: Readonly<Record<string, Channel>> = {
  ANNOUNCEMENT: 'announce',
  SOS_ESCALATED: 'announce',
  PLUGIN_DISABLED: 'announce',
  CLAIM_BRUTE_FORCE: 'ops', // staff alarm; `announce` is readable anonymously
};

export const CHANNEL_OF_TYPE: ReadonlyArray<readonly [prefix: string, channel: Channel]> = [
  ['SHIFT_', 'ops'],
  ['REGISTRATION_', 'ops'],
  ['SLOT_', 'ops'],
  ['WAITLIST_', 'ops'],
  ['SWAP_', 'ops'],
  ['CYCLIC_', 'ops'],
  ['VOLUNTEER_CHECKED_', 'ops'],
  ['ADONIX_', 'ops'],
  ['SOS_', 'sos'],
  ['GYM_', 'game'],
  ['HACKSTOP_', 'game'],
  ['POWERUP_', 'game'],
  ['QUEST_', 'game'],
  ['STICKER_', 'game'],
  ['RAID_', 'game'],
  ['OBJECTIVE_', 'game'],
  ['AVATAR_', 'game'],
  ['PRESENCE_', 'presence'],
];

export function channelOfType(type: string): Channel {
  const exact = EXACT_CHANNEL_OF_TYPE[type];
  if (exact) return exact;
  for (const [prefix, channel] of CHANNEL_OF_TYPE) {
    if (type.startsWith(prefix)) return channel;
  }
  return 'ops';
}

function isChannel(value: string): value is Channel {
  return CHANNELS.has(value as Channel);
}

/**
 * What a non-lead subscriber sees of an `sos` event. Built from the fields common to the
 * ticket document (`_id`) and the dispatch/resolve payloads (`ticketId`). Everything
 * else — coordinates, table text, hacker name, assignee — is a lead's business.
 */
export function redactSos(data: unknown): {
  ticketId: unknown;
  status: unknown;
  venueKey: unknown;
  category: unknown;
  urgency: unknown;
} {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  return {
    ticketId: d._id ?? d.ticketId,
    status: d.status,
    venueKey: d.venueKey,
    category: d.category,
    urgency: d.urgency,
  };
}

/**
 * The `audience` an announcement frame declares, when it declares one. Frames without it
 * (every event that is not an announcement) are delivered to everyone on the channel.
 */
function audienceOf(data: unknown): string | null {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const a = typeof d.audience === 'string' ? d.audience : null;
  return a && a !== 'ALL' ? a : null;
}

/** Whether an account is in the named audience. No account means no targeted delivery. */
function audienceReaches(audience: string, account: AccountContext | undefined): boolean {
  if (!account) return false;
  if (audience === 'VOLUNTEERS') return account.kind === 'VOLUNTEER';
  if (audience === 'HACKERS') return account.kind === 'HACKER';
  if (audience === 'STAFF') return isLeadOrAbove(account);
  return false;
}

type AuthMode = 'legacy' | 'required';

/** The resolved identity mode (AUTH_MODE, or the REQUIRE_AUTH alias) — never process.env directly. */
function authMode(): AuthMode {
  return env.AUTH_MODE === 'required' ? 'required' : 'legacy';
}

interface IClient {
  id: string;
  res: Response;
  account?: AccountContext;
  channels: Set<Channel>;
  version: 1 | 2;
  /** Sees full `sos` payloads. Leads always; anonymous legacy viewers keep today's open stream. */
  fullSos: boolean;
  slot: SlotHandle;
  lagging: boolean;
  lagSince: number;
}

interface BufferedEvent {
  seq: number;
  ts: number;
  type: string;
  channel: Channel;
  data: unknown;
}

/** One published event, with wire frames built lazily per (version, redaction) variant. */
class Frames {
  private cache = new Map<string, string>();

  constructor(
    private readonly seq: number,
    private readonly ts: number,
    private readonly type: string,
    private readonly channel: Channel,
    private readonly data: unknown
  ) {}

  public for(version: 1 | 2, redacted: boolean): string {
    const key = `${version}:${redacted ? 'r' : 'f'}`;
    let frame = this.cache.get(key);
    if (frame === undefined) {
      const payload = redacted ? redactSos(this.data) : this.data;
      frame = formatFrame(version, this.seq, this.ts, this.type, this.channel, payload);
      this.cache.set(key, frame);
    }
    return frame;
  }
}

function formatFrame(version: 1 | 2, seq: number, ts: number, type: string, channel: Channel, data: unknown): string {
  if (version === 1) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  const envelope = JSON.stringify({ v: 2, ts, ch: channel, data });
  return `id: ${seq}\nevent: ${type}\ndata: ${envelope}\n\n`;
}

class SSEBroadcastHub {
  private clients = new Map<string, IClient>();
  private byAccount = new Map<string, Set<IClient>>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private seq = 0;
  private buffers = new Map<Channel, BufferedEvent[]>();
  /** Highest seq ever dropped from each channel's buffer; a client behind this must resync. */
  private droppedUpTo = new Map<Channel, number>();

  constructor() {
    for (const ch of REPLAY_CHANNELS) {
      this.buffers.set(ch, []);
      this.droppedUpTo.set(ch, 0);
    }
    if (process.env.NODE_ENV !== 'test') {
      this.heartbeatInterval = setInterval(() => this.sweep(), HEARTBEAT_MS);
      if (this.heartbeatInterval.unref) {
        this.heartbeatInterval.unref();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  public registerClient(req: Request, res: Response): void {
    const account = req.account;
    const mode = authMode();

    // --- channel selection ---------------------------------------------------
    const rawChannels = typeof req.query.channels === 'string' ? req.query.channels : undefined;
    const requested: Channel[] =
      rawChannels === undefined
        ? [...DEFAULT_CHANNELS]
        : rawChannels
            .split(',')
            .map((c) => c.trim())
            .filter(isChannel);

    if (rawChannels !== undefined && requested.length === 0) {
      res.status(400).json({
        success: false,
        error: ErrorCode.BAD_REQUEST,
        message: `No valid channels in "${rawChannels}". Known channels: ${[...CHANNELS].join(', ')}.`,
        statusCode: 400,
      });
      return;
    }

    const authorised = requested.filter((ch) => this.mayJoin(ch, account, mode));
    if (authorised.length === 0) {
      res.status(403).json({
        success: false,
        error: ErrorCode.FORBIDDEN,
        message: 'None of the requested channels are available to this caller.',
        statusCode: 403,
      });
      return;
    }

    // --- slot -----------------------------------------------------------------
    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const acquired = streamLimits.tryAcquire({ transport: 'sse', accountId: account?.id, ip });
    if (!acquired.ok) {
      res.status(503).json({
        success: false,
        error: 'TOO_MANY_STREAM_CLIENTS',
        message: 'Live event stream is at capacity. Retry shortly.',
        reason: acquired.reason,
      });
      return;
    }
    if (acquired.evict) {
      this.evictBySlot(acquired.evict, 'REPLACED_BY_NEWER_CONNECTION');
    }

    // --- open the stream ------------------------------------------------------
    const version: 1 | 2 = req.query.v === '2' ? 2 : 1;
    const id = `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const client: IClient = {
      id,
      res,
      account,
      channels: new Set(authorised),
      version,
      fullSos: isLeadOrAbove(account) || (mode === 'legacy' && account === undefined),
      slot: acquired.slot,
      lagging: false,
      lagSince: 0,
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.clients.set(id, client);
    if (account) {
      const set = this.byAccount.get(account.id);
      if (set) set.add(client);
      else this.byAccount.set(account.id, new Set([client]));
    }
    res.on('close', () => this.removeClient(client));

    this.writeControl(client, 'CONNECTED', {
      clientId: id,
      channels: authorised,
      message: 'Connected to WaveShift Nexus SSE Stream.',
    });

    // --- replay ----------------------------------------------------------------
    const lastEventId = this.parseLastEventId(req);
    if (lastEventId !== null) this.replay(client, lastEventId);
  }

  private mayJoin(channel: Channel, account: AccountContext | undefined, mode: AuthMode): boolean {
    if (mode === 'legacy') return true;
    if (channel === 'announce') return true;
    if (!account) return false;
    if (channel === 'presence:exact') return isLeadOrAbove(account);
    return true;
  }

  private parseLastEventId(req: Request): number | null {
    const header = req.headers['last-event-id'];
    const raw =
      (typeof header === 'string' ? header : undefined) ??
      (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  private removeClient(client: IClient): void {
    if (!this.clients.delete(client.id)) return;
    streamLimits.release(client.slot);
    if (client.account) {
      const set = this.byAccount.get(client.account.id);
      if (set) {
        set.delete(client);
        if (set.size === 0) this.byAccount.delete(client.account.id);
      }
    }
  }

  /** End a client's stream with a final `EVICTED` frame so the browser knows not to auto-reconnect blindly. */
  private evict(client: IClient, reason: string): void {
    this.removeClient(client);
    try {
      if (!client.res.destroyed && !client.res.writableEnded) {
        client.res.write(formatFrame(client.version, this.seq, Date.now(), 'EVICTED', 'me', { reason }));
        client.res.end();
      }
    } catch {
      // Already gone; nothing to do.
    }
  }

  private evictBySlot(slot: SlotHandle, reason: string): void {
    for (const client of this.clients.values()) {
      if (client.slot.id === slot.id) {
        this.evict(client, reason);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  public broadcast(message: ISSEMessage): void {
    const channel =
      message.channel !== undefined && isChannel(message.channel) ? message.channel : channelOfType(message.type);
    this.publish(channel, message);
  }

  public broadcastChannel(channel: Channel, message: ISSEMessage): void {
    this.publish(channel, message);
  }

  /** Targeted delivery over `me` to every stream the account holds. Never buffered, never redacted. */
  public sendToAccount(accountId: string, message: ISSEMessage): void {
    const targets = this.byAccount.get(accountId);
    if (!targets || targets.size === 0) return;
    const seq = ++this.seq;
    const frames = new Frames(seq, message.timestamp ?? Date.now(), message.type, 'me', message.data);
    for (const client of [...targets]) {
      if (!client.channels.has('me')) continue;
      this.write(client, frames.for(client.version, false));
    }
  }

  /** Targeted delivery over a specific channel (the SSE presence fallback uses `presence`). */
  public sendToAccountOn(accountId: string, channel: Channel, message: ISSEMessage): void {
    const targets = this.byAccount.get(accountId);
    if (!targets || targets.size === 0) return;
    const seq = ++this.seq;
    const frames = new Frames(seq, message.timestamp ?? Date.now(), message.type, channel, message.data);
    for (const client of [...targets]) {
      if (!client.channels.has(channel)) continue;
      if (channel === 'presence' && client.lagging) continue; // presence frames are dropped while lagging
      this.write(client, frames.for(client.version, false));
    }
  }

  /** Account ids with at least one stream on `channel` (deduplicated). */
  public accountsOn(channel: Channel): string[] {
    const out: string[] = [];
    for (const [id, set] of this.byAccount) {
      for (const c of set) if (c.channels.has(channel)) { out.push(id); break; }
    }
    return out;
  }

  private publish(channel: Channel, message: ISSEMessage): void {
    const seq = ++this.seq;
    const ts = message.timestamp ?? Date.now();

    if (REPLAY_CHANNELS.has(channel)) {
      this.remember({ seq, ts, type: message.type, channel, data: message.data });
    }

    const frames = new Frames(seq, ts, message.type, channel, message.data);
    const isPresence = channel === 'presence' || channel === 'presence:exact';
    const redactable = channel === 'sos';
    // `announce` is the one public channel, so an announcement aimed at a subset of the
    // floor is filtered HERE rather than by the client. A staff message that reaches a
    // hacker's stream has already leaked, however carefully the UI hides it.
    const audience = channel === 'announce' ? audienceOf(message.data) : null;

    for (const client of [...this.clients.values()]) {
      if (!client.channels.has(channel)) continue;
      // A lagging client gets no presence frames: the next tick supersedes them, and
      // buffering positions for a peer that is not reading is how a socket hits 512 KiB.
      if (isPresence && client.lagging) continue;
      if (audience && !audienceReaches(audience, client.account)) continue;
      this.write(client, frames.for(client.version, redactable && !client.fullSos));
    }
  }

  private writeControl(client: IClient, type: string, data: unknown): void {
    this.write(client, formatFrame(client.version, this.seq, Date.now(), type, 'me', data));
  }

  /**
   * The single write path. Half-open detection, backpressure tracking and the hard buffer
   * ceiling all live here so no caller can forget one of them.
   */
  private write(client: IClient, frame: string): void {
    const { res } = client;
    try {
      if (res.destroyed || res.writableEnded) {
        this.removeClient(client);
        return;
      }
      if (res.writableLength > LAG_EVICT_BYTES) {
        this.evict(client, 'BACKPRESSURE');
        return;
      }
      const flushed = res.write(frame);
      if (!flushed && !client.lagging) {
        client.lagging = true;
        client.lagSince = Date.now();
        res.once('drain', () => {
          client.lagging = false;
          client.lagSince = 0;
        });
      }
    } catch {
      this.removeClient(client);
    }
  }

  // -------------------------------------------------------------------------
  // Replay buffer
  // -------------------------------------------------------------------------

  private remember(event: BufferedEvent): void {
    const buffer = this.buffers.get(event.channel);
    if (!buffer) return;
    buffer.push(event);
    this.prune(event.channel, event.ts);
  }

  private prune(channel: Channel, now: number): void {
    const buffer = this.buffers.get(channel);
    if (!buffer) return;
    const cutoff = now - REPLAY_MAX_AGE_MS;
    let drop = 0;
    while (drop < buffer.length && (buffer.length - drop > REPLAY_MAX_EVENTS || buffer[drop].ts < cutoff)) {
      drop += 1;
    }
    if (drop > 0) {
      const last = buffer[drop - 1];
      this.droppedUpTo.set(channel, Math.max(this.droppedUpTo.get(channel) ?? 0, last.seq));
      buffer.splice(0, drop);
    }
  }

  private replay(client: IClient, lastEventId: number): void {
    const now = Date.now();
    const channels = [...client.channels].filter((ch) => REPLAY_CHANNELS.has(ch));
    for (const ch of channels) this.prune(ch, now);

    // An id from a previous process (ahead of our counter) or behind any subscribed
    // channel's drop mark means events are unrecoverable: say so once, and let the client
    // refetch state instead of pretending the gap does not exist.
    const oldestNeeded = Math.max(0, ...channels.map((ch) => this.droppedUpTo.get(ch) ?? 0));
    if (lastEventId > this.seq || lastEventId < oldestNeeded) {
      this.writeControl(client, 'RESYNC', { reason: 'BUFFER_EXPIRED' });
      return;
    }

    const missed: BufferedEvent[] = [];
    for (const ch of channels) {
      for (const ev of this.buffers.get(ch) ?? []) {
        if (ev.seq > lastEventId) missed.push(ev);
      }
    }
    missed.sort((a, b) => a.seq - b.seq);
    for (const ev of missed) {
      const redacted = ev.channel === 'sos' && !client.fullSos;
      const payload = redacted ? redactSos(ev.data) : ev.data;
      this.write(client, formatFrame(client.version, ev.seq, ev.ts, ev.type, ev.channel, payload));
    }
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * The heartbeat body: a comment frame keeps proxies from reaping idle connections, and
   * this is where stalled clients are evicted. Public so tests can drive it without a timer.
   */
  public sweep(now: number = Date.now()): void {
    for (const client of [...this.clients.values()]) {
      const { res } = client;
      if (res.destroyed || res.writableEnded) {
        this.removeClient(client);
        continue;
      }
      if (res.writableLength > LAG_EVICT_BYTES || (client.lagging && now - client.lagSince > LAG_EVICT_MS)) {
        this.evict(client, 'BACKPRESSURE');
        continue;
      }
      try {
        // Same backpressure bookkeeping as write(): a heartbeat that does not flush is the
        // first sign of a half-open socket, and without marking `lagging` here a dead tab
        // would never hit the 10 s eviction.
        const flushed = res.write(':heartbeat\n\n');
        if (!flushed && !client.lagging) {
          client.lagging = true;
          client.lagSince = now;
        }
      } catch {
        this.removeClient(client);
      }
    }
  }

  public stats(): { clients: number; byChannel: Record<Channel, number>; slots: ReturnType<typeof streamLimits.stats> } {
    const byChannel = {} as Record<Channel, number>;
    for (const ch of CHANNELS) byChannel[ch] = 0;
    for (const client of this.clients.values()) {
      for (const ch of client.channels) byChannel[ch] += 1;
    }
    return { clients: this.clients.size, byChannel, slots: streamLimits.stats() };
  }

  public getConnectedCount(): number {
    return this.clients.size;
  }

  public teardown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients.values()) streamLimits.release(client.slot);
    this.clients.clear();
    this.byAccount.clear();
  }
}

export const eventHub = new SSEBroadcastHub();
