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
 * Clients subscribe with `?channels=a,b` (default `ops,sos,game,announce,me`).
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
import { AccountContext, isLeadOrAbove, isProvenLead, isProvenSession } from '../types/account';
import { ErrorCode } from '../errors/errorCodes';
import { streamLimits, SlotHandle } from '../streamLimits';
import { refreshAccountContext } from '../../middleware/identity';

/** One SSE stream. `presence:exact` carries coordinates and is lead-only; `presence` is fuzzed. */
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

/**
 * `me` is in the defaults because it is *targeted*: nothing is broadcast on it, so a client
 * subscribed to it receives only frames addressed to that client's own account and the
 * subscription costs nothing.
 *
 * Leaving it out made the guarantee the SOS code documents — "the ticket's own parties get
 * the full ticket over the targeted `me` channel" — quietly conditional on the client having
 * asked for a channel it had no way to know it needed. The shipped dashboard does ask; a
 * fork, a second client, or anything using the default set silently never received its own
 * ticket, with no error to notice.
 */
export const DEFAULT_CHANNELS: readonly Channel[] = ['ops', 'sos', 'game', 'announce', 'me'];

/** Channels whose events are held for replay. Presence is ephemeral; `me` is targeted. */
const REPLAY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['ops', 'sos', 'game', 'announce']);
const REPLAY_MAX_EVENTS = 200;
const REPLAY_MAX_AGE_MS = 60_000;

const LAG_EVICT_BYTES = 512 * 1024;
const LAG_EVICT_MS = 10_000;
const HEARTBEAT_MS = 15_000;

/** A published event. Omit `channel` and `channelOfType` picks one from the type; omit
 *  `timestamp` and the publish clock is used. */
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

/**
 * Which channel an event belongs on when the publisher did not say.
 *
 * Most call sites predate channels and name only a type and a payload, so the mapping has to
 * be derivable from the type string alone. The fallback is the part worth stating: a type
 * matching no exact entry and no prefix lands on `ops`, which every default subscription
 * carries, so an event type added without touching the table above shows up in the war room
 * rather than being addressed to nobody. A fallback of `presence` or `me` would have made the
 * same omission invisible, and it would have looked like a broken publisher.
 */
export function channelOfType(type: string): Channel {
  const exact = EXACT_CHANNEL_OF_TYPE[type];
  if (exact) return exact;
  for (const [prefix, channel] of CHANNEL_OF_TYPE) {
    if (type.startsWith(prefix)) return channel;
  }
  return 'ops';
}

/** Narrows untrusted input (channel query params) to the known channel set. */
function isChannel(value: string): value is Channel {
  return CHANNELS.has(value as Channel);
}

/**
 * What a non-lead subscriber sees of an `sos` event. Built from the fields common to the
 * ticket document (`_id`) and the dispatch/resolve payloads (`ticketId`). Everything
 * else — coordinates, table text, hacker name, assignee — is a lead's business.
 *
 * `karmaBounty` is on the list deliberately. It is the reward advertised to whoever might
 * take the ticket, so withholding it from the people the ticket is advertised to would leave
 * the queue offering an unspecified amount of karma for an unspecified job. It says nothing
 * about the person who raised the ticket or about where they are, which is what the rest of
 * this function exists to withhold.
 *
 * The whitelist is a whitelist rather than a blacklist because that is the direction that
 * fails safe: a field added to a payload later is absent from a redacted copy until somebody
 * decides otherwise, rather than present until somebody remembers.
 */
export function redactSos(data: unknown): {
  ticketId: unknown;
  status: unknown;
  venueKey: unknown;
  category: unknown;
  urgency: unknown;
  karmaBounty: unknown;
} {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  return {
    ticketId: d._id ?? d.ticketId,
    status: d.status,
    venueKey: d.venueKey,
    category: d.category,
    urgency: d.urgency,
    karmaBounty: d.karmaBounty,
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
  // Audience is a disclosure decision, so the identity has to be proved rather than claimed.
  // A `STAFF` announcement named a lead's public id and reached anyone who typed it; the two
  // broad audiences are less interesting to impersonate but are the same mistake, and holding
  // all three to one rule is what stops the next one being re-introduced.
  if (!isProvenSession(account)) return false;
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
  /**
   * The audience this event was published to, for the `announce` channel, or null.
   *
   * Kept on the buffered copy because replay has to make the same decision the live send
   * made, and the only place that decision was recorded was the live loop. A staff-only
   * announcement was filtered correctly on the wire and then handed to anybody who
   * reconnected with a `Last-Event-ID` — `announce` needs no session at all, so an anonymous
   * listener could ask for the last minute of the channel and read it.
   */
  audience: string | null;
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

  /**
   * The frame for one (version, redaction) pair, built on first use and kept.
   *
   * An event has at most four wire forms — two protocol versions, redacted or not — and a
   * fan-out asks for one of them per subscriber. Formatting per client would put a
   * `JSON.stringify` of the payload on the event loop once for every open stream; this bounds
   * it at four, however many people are watching. The cache belongs to the one publish and is
   * dropped with it, so nothing is retained between events.
   */
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

/**
 * The wire, both versions.
 *
 * v1 is what shipped before channels existed — an `event:` line and a `data:` line, nothing
 * else — and stays byte-identical for clients that never ask for v2. The consequence to know
 * is that a v1 frame carries no `id:`, so a browser's `EventSource` never learns a
 * Last-Event-ID for this stream and never sends one back on reconnect: resume is a v2 feature
 * in practice, and a v1 client that wants it has to pass `?lastEventId=` itself.
 *
 * v2 keeps the type on the `event:` line so client-side dispatch is unchanged, adds `id:` so
 * the browser tracks the position for free, and wraps the payload in `{v, ts, ch, data}` —
 * the channel has to travel with the event because one connection carries several and the
 * type prefix is not something a client should have to re-parse to tell them apart.
 */
function formatFrame(version: 1 | 2, seq: number, ts: number, type: string, channel: Channel, data: unknown): string {
  if (version === 1) {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  }
  const envelope = JSON.stringify({ v: 2, ts, ch: channel, data });
  return `id: ${seq}\nevent: ${type}\ndata: ${envelope}\n\n`;
}

/**
 * High-performance Server-Sent Events (SSE) broadcast hub managing active streaming connections,
 * subscription channels, backpressure-aware socket flushing, client slot leases, and heartbeats.
 */
class SSEBroadcastHub {
  private clients = new Map<string, IClient>();
  private byAccount = new Map<string, Set<IClient>>();
  /**
   * channel → the clients subscribed to it, and slot id → its client.
   *
   * Publishing used to copy the whole client map into an array and then ask each entry
   * whether it cared. At a few hundred streams that is invisible; at eleven thousand it is a
   * fresh eleven-thousand-element array on every ops event, most of whose entries are
   * immediately discarded. A per-channel set makes the cost proportional to the audience,
   * which is what a fan-out should cost, and lets `stats()` answer without a scan.
   *
   * The slot index replaces the linear search `evictBySlot` used to run on every eviction,
   * which is the one path that runs *more* often as the table fills up.
   */
  private byChannel = new Map<Channel, Set<IClient>>();
  private bySlot = new Map<number, IClient>();
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
      this.heartbeatInterval = setInterval(() => {
        this.sweep();
        // Re-authorisation rides the heartbeat rather than living inside `sweep`, which is
        // synchronous and has tests that depend on it staying that way.
        void this.reauthorise();
      }, HEARTBEAT_MS);
      if (this.heartbeatInterval.unref) {
        this.heartbeatInterval.unref();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Turn a request into a subscribed client, or refuse it.
   *
   * Four decisions, and their order is the part to preserve. The requested channels are parsed
   * first, and an explicit `?channels=` naming nothing valid is a 400 rather than a silent
   * fall back to the defaults, which would hand a client a stream it did not ask for and no
   * way to notice. Then the caller's own authorisation removes channels it may not join, and
   * only a caller left with none of them gets a 403. Only then is a stream slot taken — so a
   * caller who may join nothing cannot occupy capacity by asking — and a connection this one
   * replaces is closed before these headers go out, rather than after.
   *
   * Everything above `flushHeaders()` can still answer with an ordinary JSON error body, which
   * is why the refusals live there. Once the headers are committed the socket is an event
   * stream and every later refusal — a revoked session, a client that stopped reading — has to
   * be an `EVICTED` frame instead.
   *
   * `channels` and `fullSos` are decided here from the account as it is at connect, and an SSE
   * stream can outlive that by hours. `reauthorise` re-derives both on every heartbeat; the two
   * sites must stay in step, and the note on `fullSos` below and the one in `reauthorise`
   * describe the same bug found twice.
   *
   * The `CONNECTED` frame is written before any replay, so a client always learns its id and
   * the channels it was actually granted before the events it missed start arriving.
   */
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
      // A *proved* lead, or the anonymous legacy demo viewer.
      //
      // This said `isLeadOrAbove(account)`, which trusts a claimed role — so in `legacy`
      // `?channels=sos&volunteerId=<any lead id>` opened an unredacted SOS stream with no
      // cookie: hacker names, table text, medical categories, and the full-ticket
      // `SOS_ESCALATED_FULL` with coordinates. `listTickets` redacts exactly those fields for
      // the same caller over REST, so the stream was undoing the REST fix in real time.
      //
      // The anonymous-legacy branch is deliberate and stays: with no account at all there is
      // nobody to impersonate, and it is what makes the zero-setup demo dashboard show a
      // distress queue. Naming somebody is the part that has to be proved.
      fullSos: isProvenLead(account) || (mode === 'legacy' && account === undefined),
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
    this.bySlot.set(client.slot.id, client);
    for (const ch of client.channels) {
      const set = this.byChannel.get(ch);
      if (set) set.add(client);
      else this.byChannel.set(ch, new Set([client]));
    }
    // Targeted delivery is filed under a **proved** account only.
    //
    // `byAccount` is what `sendToAccount` addresses, and the things it addresses are the most
    // personal frames the hub carries — a ticket's own parties get the *whole* SOS document
    // there, coordinates and all. Filing on a bare `account.id` meant that in `legacy` a stream
    // opened with `?volunteerId=<victim>` was registered as the victim, and every message
    // intended for them was delivered to whoever had typed their public id.
    //
    // A claimed identity keeps its broadcast channels, which are redacted for it like any
    // other unproved caller; what it loses is the ability to be somebody else's inbox.
    if (account && account.source === 'session') {
      const set = this.byAccount.get(account.id);
      if (set) set.add(client);
      else this.byAccount.set(account.id, new Set([client]));
    }
    res.on('close', () => this.removeClient(client));

    this.writeControl(client, 'CONNECTED', {
      clientId: id,
      channels: authorised,
      message: 'Connected to Nexus Quest SSE Stream.',
    });

    // --- replay ----------------------------------------------------------------
    const lastEventId = this.parseLastEventId(req);
    if (lastEventId !== null) this.replay(client, lastEventId);
  }

  /**
   * The per-channel gate, asked twice in a connection's life: once per requested channel at
   * connect, and again for every channel a client still holds on each heartbeat. Both callers
   * pass the mode and the account as they are *now*, which is what lets a demotion take a
   * channel away from a stream that is already open.
   *
   * In `legacy` the answer is yes to everything except `presence:exact` — that is the
   * open-demo contract this repository ships with, and it is why the redaction inside
   * `publish`, not this gate, is what protects SOS payloads there. In `required`, `announce`
   * is the only channel an anonymous caller may hold, which is exactly why an announcement's
   * audience has to be filtered on the way out rather than trusted to the client.
   */
  private mayJoin(channel: Channel, account: AccountContext | undefined, mode: AuthMode): boolean {
    // `presence:exact` is decided before the legacy blanket, and on a *proved* lead.
    //
    // Two things were wrong and they compounded. `mode === 'legacy'` returned true for every
    // channel, so the one channel named for exact positions was open to an anonymous caller in
    // the shipped default mode; and in `required` mode `isLeadOrAbove` trusted a claimed role.
    //
    // Nothing publishes to this channel today — there is no `broadcast` call site for it — so
    // this was latent rather than leaking. That is exactly why it is worth fixing now: the
    // first thing to write to it would have been an exact-position feed with no gate, and the
    // gate would have looked present.
    if (channel === 'presence:exact') return isProvenLead(account);
    if (mode === 'legacy') return true;
    if (channel === 'announce') return true;
    if (!account) return false;
    return true;
  }

  /**
   * Where a reconnecting client says it got to: the standard `Last-Event-ID` header, or a
   * `?lastEventId=` query parameter. The query form is not redundant — the browser sends the
   * header only on its own automatic reconnect, and a client that reopens the stream itself
   * (a fresh page load, a manual retry) cannot set headers on an `EventSource` at all.
   *
   * Anything that is not a non-negative integer becomes null, which means "no replay" rather
   * than "bad request": a stale or mangled id should still open a working stream that starts
   * from now. The case that genuinely cannot be served — an id whose events are gone — is
   * answered by `replay` with a `RESYNC` frame, on an open stream, where a client can act on it.
   */
  private parseLastEventId(req: Request): number | null {
    const header = req.headers['last-event-id'];
    const raw =
      (typeof header === 'string' ? header : undefined) ??
      (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  /**
   * Re-check, on every heartbeat, that each client is still allowed what it was allowed at
   * connect.
   *
   * `fullSos` and the channel set were computed once in `registerClient` and never revisited,
   * while an SSE stream can stay open for hours on a heartbeat. So a SHIFT_LEAD who opened
   * `?channels=sos`, was then demoted or had their sessions revoked, and simply left the tab
   * open, went on receiving un-redacted tickets — `SOS_ESCALATED_FULL` puts the whole
   * document on that channel, coordinates, description, hacker name and table included.
   * Revocation is checked on every *request*, and this connection makes no more requests.
   *
   * `src/presence/session.ts` states this invariant plainly — losing a privilege has to take
   * effect immediately, including on an open stream — and the presence WebSocket honours it
   * by re-reading its facts each tick. This is the other half.
   *
   * Reads go through the identity module's sixty-second cache while this loop runs every
   * fifteen, so three heartbeats in four are a map lookup and the fourth is a `findById` per
   * client. At the slot ceiling that is one database read per open stream per minute — the
   * standing cost of checking revocation on a connection that makes no further requests.
   */
  public async reauthorise(): Promise<void> {
    const mode = authMode();
    // A snapshot, because a client can be removed while we await.
    for (const client of [...this.clients.values()]) {
      const previous = client.account;
      if (!previous) continue;
      if (!this.clients.has(client.id)) continue;

      let current: Awaited<ReturnType<typeof refreshAccountContext>>;
      try {
        current = await refreshAccountContext(previous.id);
      } catch {
        // A database blip is not evidence that anybody lost a privilege. Leave the client
        // as it is and re-check on the next heartbeat.
        continue;
      }
      if (!this.clients.has(client.id)) continue;

      // Deleted, or every session revoked since this stream opened.
      if (!current || current.sessionVersion !== previous.sessionVersion) {
        this.writeControl(client, 'EVICTED', {
          reason: 'ACCESS_REVOKED',
          message: 'Your access changed. Reconnect to continue.',
        });
        client.res.end();
        this.removeClient(client);
        continue;
      }

      client.account = { ...current, source: previous.source };

      // Redaction follows the role as it is now, not as it was at connect.
      // Same rule as `registerClient`, and it had the same bug: re-authorising on the
      // heartbeat re-granted the unredacted stream to a *claimed* lead, so a connection that
      // opened redacted was upgraded a minute later by the code written to downgrade it.
      client.fullSos = isProvenLead(client.account);

      // And a channel the account may no longer join is dropped from under it.
      for (const ch of [...client.channels]) {
        if (this.mayJoin(ch, client.account, mode)) continue;
        client.channels.delete(ch);
        this.byChannel.get(ch)?.delete(client);
      }
      if (client.channels.size === 0) {
        this.writeControl(client, 'EVICTED', {
          reason: 'ACCESS_REVOKED',
          message: 'You no longer have access to any of the channels this stream carried.',
        });
        client.res.end();
        this.removeClient(client);
      }
    }
  }

  /**
   * Unwind one client from all four indexes and give its slot back.
   *
   * The `clients.delete` result is the idempotency guard, and it earns its keep: the same
   * client can be removed by its `close` handler, by a write that threw, by the heartbeat
   * sweep and by an eviction, and nothing stops two of those reaching the same client.
   * `streamLimits.release` is independently idempotent for the same reason, so a double
   * removal is a no-op rather than a slot returned twice.
   *
   * `byAccount` is cleaned by client identity, not by account id, so removing a
   * claimed-identity stream — which `registerClient` never filed there — cannot take the
   * proved session that holds the same account id out of the map with it.
   */
  private removeClient(client: IClient): void {
    if (!this.clients.delete(client.id)) return;
    streamLimits.release(client.slot);
    this.bySlot.delete(client.slot.id);
    for (const ch of client.channels) {
      const set = this.byChannel.get(ch);
      if (!set) continue;
      set.delete(client);
      if (set.size === 0) this.byChannel.delete(ch);
    }
    if (client.account) {
      const set = this.byAccount.get(client.account.id);
      if (set) {
        set.delete(client);
        if (set.size === 0) this.byAccount.delete(client.account.id);
      }
    }
  }

  /**
   * End a client's stream with a final `EVICTED` frame so the browser knows not to
   * auto-reconnect blindly.
   *
   * The removal happens before the write, and the write goes straight to `res` rather than
   * through `write()`: `write()` is a caller of this method (it evicts past the buffer
   * ceiling), and routing the farewell frame back through it would recurse on exactly the
   * client that is already too full to take another frame.
   */
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

  /** The slot table hands back a handle when it replaces a connection; it has no idea what a
   *  socket is. This turns that handle into the client to close, through the `bySlot` index
   *  described above rather than the linear scan it used to be. */
  private evictBySlot(slot: SlotHandle, reason: string): void {
    const client = this.bySlot.get(slot.id);
    if (client) this.evict(client, reason);
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  /**
   * The compatibility entry point, and where most events enter the hub: a type, a payload, and
   * nothing said about channels. An explicit `channel` on the message wins when it names a
   * real one; anything else — including a misspelled channel — falls through to
   * `channelOfType`, so the event goes wherever its type implies rather than being dropped for
   * a typo in a field most callers do not set.
   */
  public broadcast(message: ISSEMessage): void {
    const channel =
      message.channel !== undefined && isChannel(message.channel) ? message.channel : channelOfType(message.type);
    this.publish(channel, message);
  }

  /**
   * For a publisher that knows the channel because it shaped the payload for it. The SOS
   * escalation is the clearest case and uses both in one breath: a summary with a resolved
   * venue key on `announce`, which anybody may read, and then the whole ticket as
   * `SOS_ESCALATED_FULL` on `sos`, where per-client redaction decides who sees the
   * coordinates. Two publishes rather than one because the two audiences need different
   * payloads, not because the channels are two.
   */
  public broadcastChannel(channel: Channel, message: ISSEMessage): void {
    this.publish(channel, message);
  }

  /**
   * Targeted delivery over `me` to every stream the account holds. Never buffered, never
   * redacted.
   *
   * "Never redacted" is safe only because of what `byAccount` holds: `registerClient` files a
   * client there for a **proved** session and never for a claimed identity, so the whole SOS
   * document this carries to a ticket's own parties cannot be addressed to somebody who merely
   * typed their account id. That invariant lives at the other end of the file; breaking it
   * would break this method silently.
   */
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

  /**
   * Account ids with at least one stream on `channel` (deduplicated).
   *
   * Nothing calls this — not `src/`, not `tests/`, not the plugins. It reads as the natural
   * companion to `sendToAccountOn` for a publisher that wants to know who is listening before
   * building per-account payloads, but it is untested and unproven, and the scan is O(all
   * accounts × their streams) rather than a lookup on `byChannel`. Treat it as a sketch.
   */
  public accountsOn(channel: Channel): string[] {
    const out: string[] = [];
    for (const [id, set] of this.byAccount) {
      for (const c of set) if (c.channels.has(channel)) { out.push(id); break; }
    }
    return out;
  }

  /**
   * The live send, and one of the two places that decide who sees what. The other is `replay`,
   * and the two have to agree — a filter added here and forgotten there is a hole that opens
   * for the length of the replay buffer every time somebody reconnects.
   *
   * Three filters, in this order: a lagging client gets no presence frame at all; an
   * announcement carrying an `audience` reaches only accounts inside it; an `sos` payload is
   * redacted for every client without `fullSos`. Redaction is applied per client while framing
   * rather than once at publish, which is what lets one event go out full to a lead and
   * redacted to everyone else on the same channel in the same loop.
   *
   * Sequence numbers come from one counter shared by every channel and by the targeted sends
   * above, so a `seq` is a position in this process's whole event history rather than in one
   * channel. That is what makes a single `Last-Event-ID` meaningful for a client subscribed to
   * several of them at once — and what makes an id from a previous process detectable, since
   * the counter starts again at zero on boot.
   */
  private publish(channel: Channel, message: ISSEMessage): void {
    const seq = ++this.seq;
    const ts = message.timestamp ?? Date.now();

    const frames = new Frames(seq, ts, message.type, channel, message.data);
    const isPresence = channel === 'presence' || channel === 'presence:exact';
    const redactable = channel === 'sos';
    // `announce` is the one public channel, so an announcement aimed at a subset of the
    // floor is filtered HERE rather than by the client. A staff message that reaches a
    // hacker's stream has already leaked, however carefully the UI hides it.
    const audience = channel === 'announce' ? audienceOf(message.data) : null;

    // Remembered WITH its audience, and after that audience is known. Replay applies the same
    // filter; a buffer that records only "what was said" and not "who it was said to" cannot.
    if (REPLAY_CHANNELS.has(channel)) {
      this.remember({ seq, ts, type: message.type, channel, data: message.data, audience });
    }

    // Only the channel's own subscribers, and iterated directly rather than through a copy.
    // `write` can remove the client it is writing to (a half-open socket, or backpressure past
    // the ceiling), and deleting from a Set while iterating it is well defined in JavaScript:
    // an entry removed before it is reached is simply not visited, which is exactly the
    // behaviour wanted for a client that has just gone away.
    const subscribers = this.byChannel.get(channel);
    if (!subscribers) return;
    for (const client of subscribers) {
      // A lagging client gets no presence frames: the next tick supersedes them, and
      // buffering positions for a peer that is not reading is how a socket hits 512 KiB.
      if (isPresence && client.lagging) continue;
      if (audience && !audienceReaches(audience, client.account)) continue;
      this.write(client, frames.for(client.version, redactable && !client.fullSos));
    }
  }

  /**
   * A frame addressed to one connection rather than published to a channel: `CONNECTED`,
   * `RESYNC`, `EVICTED`.
   *
   * Two details worth knowing. These are labelled channel `me` in the v2 envelope whether or not
   * the client subscribed to `me`, because they describe the connection rather than the event
   * stream. And they reuse the current sequence number instead of consuming one: they are not
   * events, they are never buffered, and reusing the last published id means a v2 client that
   * stores the id it just saw resumes from exactly where it was rather than skipping the next
   * real event.
   */
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
      if (!flushed) this.markLagging(client, Date.now());
    } catch {
      this.removeClient(client);
    }
  }

  /**
   * Mark a client as behind, and arrange for the mark to be cleared when it catches up.
   *
   * The two halves belong together, and this method exists because they had come apart.
   * `write()` set the flag and attached a `drain` listener to clear it; `sweep()` set the flag
   * from a heartbeat that did not flush and attached nothing, under a comment claiming "same
   * backpressure bookkeeping as write()". It was not the same, and the difference was the whole
   * of it.
   *
   * What followed from a sweep-set flag was not a stuck boolean. `lagging` gates two things: a
   * lagging client is sent no presence frames at all, and the next sweep evicts it once
   * `lagSince` is `LAG_EVICT_MS` old. Nothing could clear it, because `write()` only attaches
   * the listener when the flag is *not* already set. So a socket that filled for a moment and
   * recovered a millisecond later had its live map frozen and was then disconnected ten seconds
   * afterwards as unreachable — while perfectly healthy. The population this happens to is
   * phones on a congested campus network, which is the population this whole system is for.
   *
   * The `!client.lagging` early return keeps `lagSince` at the moment the client *first* fell
   * behind, so the eviction clock measures how long it has been behind rather than restarting on
   * every failed write.
   */
  private markLagging(client: IClient, at: number): void {
    if (client.lagging) return;
    client.lagging = true;
    client.lagSince = at;
    // `once`, so repeated fill/drain cycles do not accumulate listeners on the response.
    client.res.once('drain', () => {
      client.lagging = false;
      client.lagSince = 0;
    });
  }

  // -------------------------------------------------------------------------
  // Replay buffer
  // -------------------------------------------------------------------------

  /** Buffer an event for replay. `publish` has already decided the channel qualifies; the
   *  missing-buffer branch is what makes this a no-op for the channels that do not. */
  private remember(event: BufferedEvent): void {
    const buffer = this.buffers.get(event.channel);
    if (!buffer) return;
    buffer.push(event);
    this.prune(event.channel, event.ts);
  }

  /**
   * Drop from the head of a channel's buffer until both bounds hold — at most 200 events, none
   * older than 60 s — and record the highest sequence number dropped.
   *
   * That high-water mark is the point of the exercise. Without it, a client reconnecting with
   * an id that has fallen off the front of the buffer would be handed whatever happened to
   * remain and told nothing: a resume that looks successful and is silently missing events.
   * With it, `replay` can tell "you missed nothing" from "you missed something I no longer
   * have" and say so.
   *
   * Pruning is driven by writes and by `replay`, never by a timer, so a channel that has gone
   * quiet keeps events past their 60 s until something touches it. Nothing stale is delivered
   * from that state, because `replay` prunes every channel it is about to read.
   */
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

  /**
   * Send a reconnecting client what it missed, or tell it that it cannot be told.
   *
   * This is the hub's second delivery path and it has to be exactly as narrow as the first. It
   * re-applies both of `publish`'s content filters — the announcement audience and the `sos`
   * redaction — against the *reconnecting* client's account and its current `fullSos`, never
   * against whatever the original recipients were allowed. The audience half was missing here
   * once, and because `announce` is the channel that needs no session at all, that made a
   * minute of staff-only announcements readable by anyone willing to reconnect with a
   * `Last-Event-ID`.
   *
   * The two resync cases mean the same thing to a client and are worth telling apart when
   * reading a log. An id *ahead* of the counter cannot have come from this process at all —
   * sequence numbers are per-process and start again at zero on boot — so it is a client that
   * outlived a restart, or one inventing numbers. An id *behind* a subscribed channel's drop
   * mark is a gap this process genuinely had and threw away.
   *
   * Missed events are merged across the client's replayable channels and re-sorted by sequence,
   * so a client on `ops` and `game` sees them interleaved in publication order rather than one
   * channel's history and then the other's.
   */
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
      // The same two filters the live path applies, in the same order. Redaction was here;
      // the audience check was not, so every targeted announcement in the last minute was
      // readable by reconnecting with a `Last-Event-ID` — including anonymously, because
      // `announce` is the channel that needs no session. Replay is a second delivery path and
      // has to be as narrow as the first.
      if (ev.audience && !audienceReaches(ev.audience, client.account)) continue;
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
        // Same backpressure bookkeeping as write(), and now literally the same code: a
        // heartbeat that does not flush is the first sign of a half-open socket, and without
        // marking `lagging` here a dead tab would never hit the 10 s eviction. Going through
        // `markLagging` is what makes the claim in this comment true — it used to set the flag
        // without the `drain` listener that clears it, so a client marked here could never be
        // unmarked and was evicted on the next sweep regardless of whether it had recovered.
        const flushed = res.write(':heartbeat\n\n');
        if (!flushed) this.markLagging(client, now);
      } catch {
        this.removeClient(client);
      }
    }
  }

  /**
   * Per-channel subscriber counts and the slot table's own view, for the branch of
   * `GET /health` that only a proved lead reaches — how many people are connected and from
   * where describes the crowd, not the process.
   *
   * Counted from `byChannel` rather than by walking every client, which is the second reason
   * that index exists.
   */
  public stats(): { clients: number; byChannel: Record<Channel, number>; slots: ReturnType<typeof streamLimits.stats> } {
    const byChannel = {} as Record<Channel, number>;
    for (const ch of CHANNELS) byChannel[ch] = this.byChannel.get(ch)?.size ?? 0;
    return { clients: this.clients.size, byChannel, slots: streamLimits.stats() };
  }

  /** Open streams, whatever they subscribed to. */
  public getConnectedCount(): number {
    return this.clients.size;
  }

  /**
   * Shutdown, from the signal handlers in `src/index.ts`.
   *
   * It stops the heartbeat, returns every slot to the limit table and forgets every index. It
   * does not end the responses — `server.closeAllConnections()` immediately after the call
   * does that, and the comment there records what happened before it existed: `server.close()`
   * waits for sockets to drain and an open war room holds its stream forever, so Ctrl-C hung
   * for as long as anyone had the dashboard open.
   *
   * So this is not a standalone "stop serving": called without closing the server it leaves
   * live sockets attached to a hub that no longer knows about them, which will never write to
   * them again. The replay buffers and the sequence counter are left alone; nothing restarts a
   * hub inside one process, and a new process starts from zero anyway.
   */
  public teardown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients.values()) streamLimits.release(client.slot);
    this.clients.clear();
    this.byAccount.clear();
    this.byChannel.clear();
    this.bySlot.clear();
  }
}

export const eventHub = new SSEBroadcastHub();
