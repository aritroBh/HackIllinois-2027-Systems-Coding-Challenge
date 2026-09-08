/**
 * SSE fallback transport (plan §A4). Networks that block WebSockets still get presence:
 * frames go out on the existing event stream's `presence` channel, and positions come back
 * over `POST /api/v1/presence`. Rows are JSON and the detail cut is smaller (40), which is
 * the price of the fallback; everything else — interest, clusters, expiry, idx scoping — is
 * the same session code the WebSocket uses.
 *
 * A session is created on the first POST and ends three ways from the client's side: `DELETE
 * /api/v1/presence`, opting out through `PATCH /me/presence`, or the idle sweep below once
 * the client stops posting. The service can also end one from its own side — shutdown, and
 * the revoked-session eviction — which is the case that leaves the client cached here with no
 * session behind it; see `SsePresenceClient.close`.
 *
 * Losing the event stream itself does **not** end it — the hub has no hook back into
 * presence, so frames for an account with no open stream are simply dropped where they are
 * written and the session lingers until the sweep reaps it.
 */
import { eventHub } from '../common/sse/eventHub';
import type { AccountContext } from '../common/types/account';
import { presenceService } from './service';
import type { PresenceClient } from './transport';

/**
 * How long a session survives without a POST.
 *
 * Measured against the last request rather than against a socket, because there is no socket
 * here whose closing anybody could notice. The sweep runs every thirty seconds, so a client
 * that stops posting is reaped between sixty and ninety seconds later — inside the store's own
 * 120 s `expireAfterMs`, so the session goes before the position it was publishing does.
 */
const IDLE_MS = 60_000;

/**
 * A `PresenceClient` with no connection of its own.
 *
 * Frames are handed to the SSE hub addressed at the account, so this leg inherits the hub's
 * delivery wholesale, backpressure included. An account with no open event stream — or one
 * that never subscribed the `presence` channel — is written nothing and nobody is told; that
 * is why `send` reports success unconditionally, since it has no way to know whether anyone
 * was there.
 *
 * One client per account rather than one per connection, so two devices reading the map on the
 * same account share a single session, a single slot table and therefore identical frames.
 */
/**
 * SSE adapter implementing PresenceClient to stream JSON presence updates to connected clients.
 */
class SsePresenceClient implements PresenceClient {
  public readonly transport = 'sse' as const;
  public readonly binary = false;
  public lastPostAt = Date.now();

  constructor(public readonly id: string, public readonly account: AccountContext) {}

  /** Transmit a presence frame message over the SSE event hub. */
  send(msg: unknown): boolean {
    // The hub drops presence frames for a lagging client, which is exactly the policy here.
    eventHub.sendToAccountOn(this.account.id, 'presence', { type: 'PRESENCE_FRAME', data: msg as Record<string, unknown> });
    return true;
  }

  /** Binary transmission stub; SSE presence transport supports JSON only. */
  sendBinary(): boolean {
    return false; // the SSE leg is JSON only
  }

  /** Current buffer backpressure byte count (managed by eventHub). */
  bufferedBytes(): number {
    return 0; // the hub owns SSE backpressure
  }

  /**
   * Unregister the session and forget the client. There is no connection to hang up.
   *
   * The `byAccount` delete is the important half and it used to be missing. Only
   * `dropSseSession` and the idle sweep removed the cache entry, but two callers reach `close()`
   * directly — `presenceService.stop()` at shutdown, and `evictRevoked` when a session's
   * `sessionVersion` moves under it. Either left this object cached under its account with no
   * session behind it, and `ensureSseSession` then found the cached client, refreshed
   * `lastPostAt`, and returned it **without registering a session**.
   *
   * The result was a presence leg that was permanently, silently dead. The account's
   * `POST /api/v1/presence` calls kept succeeding, `lastPostAt` kept being refreshed so the idle
   * sweep never reaped it, and no frame ever arrived again — for the rest of the process's life.
   * The person it happened to is someone whose session was revoked and who then signed back in,
   * which is precisely the handover path the revocation exists to serve.
   *
   * The identity check matters: a newer session for the same account may already have replaced
   * this client in the map, and deleting unconditionally would evict the live one on the old
   * one's way out.
   */
  close(): void {
    if (byAccount.get(this.account.id) === this) byAccount.delete(this.account.id);
    presenceService.remove(this.id);
  }
}

const byAccount = new Map<string, SsePresenceClient>();

/**
 * Get or create this account's SSE presence session.
 *
 * `helloAt` is stamped at creation because this leg has no hello message to stamp it: the
 * service closes any session that has not said hello within five seconds, and an SSE client —
 * which never can — would otherwise be dropped a moment after its first POST.
 *
 * Called on every `POST /api/v1/presence`, so refreshing `lastPostAt` here is also what keeps
 * the idle sweep away from a client that is still publishing.
 */
export function ensureSseSession(account: AccountContext): SsePresenceClient {
  const existing = byAccount.get(account.id);
  if (existing) {
    existing.lastPostAt = Date.now();
    return existing;
  }
  const client = new SsePresenceClient(`sse_${account.id}_${Date.now().toString(36)}`, account);
  byAccount.set(account.id, client);
  presenceService.add(client).helloAt = Date.now();
  return client;
}

/**
 * End this account's session and forget the client, from `DELETE /api/v1/presence` and from
 * opting out through `PATCH /me/presence`.
 *
 * Both of those routes require a real session rather than a claimed identity, because taking a
 * named person off the map is as much of an act against them as putting them on it; the route
 * comments record the shape that had. False when the account had no session to drop.
 */
export function dropSseSession(accountId: string): boolean {
  const client = byAccount.get(accountId);
  if (!client) return false;
  byAccount.delete(accountId);
  presenceService.remove(client.id);
  return true;
}

/**
 * Reap sessions whose client stopped posting; called from the scheduler every thirty seconds.
 *
 * The WebSocket leg hears about a departure from the socket. This one has only the absence of
 * requests to go on, so silence is the entire signal. Returns how many were dropped.
 */
export function sweepSseSessions(now = Date.now()): number {
  let dropped = 0;
  for (const [id, client] of byAccount) {
    if (now - client.lastPostAt > IDLE_MS) {
      byAccount.delete(id);
      presenceService.remove(client.id);
      dropped += 1;
    }
  }
  return dropped;
}

/** Live SSE presence sessions. Nothing in this tree calls it; it is a hook for ops and tests. */
export function sseSessionCount(): number {
  return byAccount.size;
}
