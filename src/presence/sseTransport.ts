/**
 * SSE fallback transport (plan §A4). Networks that block WebSockets still get presence:
 * frames go out on the existing event stream's `presence` channel, and positions come back
 * over `POST /api/v1/presence`. Rows are JSON and the detail cut is smaller (40), which is
 * the price of the fallback; everything else — interest, clusters, expiry, idx scoping — is
 * the same session code the WebSocket uses.
 *
 * A session is created on the first POST and lives until `DELETE /api/v1/presence`, the
 * client stops posting (the store expires the entry), or the SSE stream itself goes away.
 */
import { eventHub } from '../common/sse/eventHub';
import type { AccountContext } from '../common/types/account';
import { presenceService } from './service';
import type { PresenceClient } from './transport';

const IDLE_MS = 60_000;

class SsePresenceClient implements PresenceClient {
  public readonly transport = 'sse' as const;
  public readonly binary = false;
  public lastPostAt = Date.now();

  constructor(public readonly id: string, public readonly account: AccountContext) {}

  send(msg: unknown): boolean {
    // The hub drops presence frames for a lagging client, which is exactly the policy here.
    eventHub.sendToAccountOn(this.account.id, 'presence', { type: 'PRESENCE_FRAME', data: msg as Record<string, unknown> });
    return true;
  }

  sendBinary(): boolean {
    return false; // the SSE leg is JSON only
  }

  bufferedBytes(): number {
    return 0; // the hub owns SSE backpressure
  }

  close(): void {
    presenceService.remove(this.id);
  }
}

const byAccount = new Map<string, SsePresenceClient>();

/** Get or create this account's SSE presence session. */
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

export function dropSseSession(accountId: string): boolean {
  const client = byAccount.get(accountId);
  if (!client) return false;
  byAccount.delete(accountId);
  presenceService.remove(client.id);
  return true;
}

/** Reap sessions whose client stopped posting; called from the sweep. */
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

export function sseSessionCount(): number {
  return byAccount.size;
}
