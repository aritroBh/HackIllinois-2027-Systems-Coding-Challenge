/**
 * Server-Sent Events broadcast hub — the push half of the live war room.
 *
 * SSE rather than WebSockets, deliberately. Every update in this system travels
 * server → browser: a waitlist promotion, a gym flip, an SOS dispatch. Nothing needs a
 * client→server channel that HTTP does not already provide, and SSE buys automatic
 * browser reconnection, plain HTTP semantics through proxies, and no second protocol to
 * secure or scale. WebSockets would add a bidirectional channel this app has no use for.
 *
 * Three defences make an open socket per viewer safe to expose:
 *
 *  1. **A hard client ceiling.** `MAX_CLIENTS` caps the map at 1,000 and refuses further
 *     streams with a 503. An unbounded map of live responses is a memory-DoS with no
 *     authentication required — every connection costs a socket and a map entry that only
 *     the client can release.
 *  2. **Eviction on write, not only on close.** A half-open socket (laptop lid closed,
 *     network dropped) never fires `close`. All three write paths — broadcast, single-client
 *     send, and the heartbeat — therefore check `destroyed` and `writableEnded` before
 *     writing and drop the client, so dead entries cannot accumulate and buffer writes
 *     nobody will read. The heartbeat matters most here: it is the loop that runs every
 *     15 s for the life of the process.
 *  3. **A 15-second heartbeat.** A comment frame keeps proxies from reaping an idle
 *     connection. It is `unref`'d so it never holds the process open, and skipped under
 *     `NODE_ENV=test` so Jest exits cleanly instead of hanging on a live timer.
 *
 * Delivery is best-effort by design: a write that throws evicts the client rather than
 * failing the operation that triggered it. A volunteer's registration must not roll back
 * because a dashboard tab went away. The dashboard reconciles on reconnect.
 *
 * Fan-out is O(clients) per event on the event loop, which is what the ceiling is really
 * sized against. `scripts/benchmarks/sse-fanout.ts` drives 1,000 concurrent streams and
 * reports delivery and latency; run it rather than trusting a number written here, since a
 * figure in a comment cannot be re-checked and will rot.
 *
 * Beyond one process this needs an external bus — each instance only knows its own map, so
 * a second replica silently halves who receives any given event.
 */
import { Response } from 'express';

export interface ISSEMessage {
  type: string;
  channel?: string;
  data: unknown;
  timestamp?: number;
}

interface IClient {
  id: string;
  res: Response;
  userId?: string;
}

/**
 * Server-Sent Events Broadcast Hub.
 * Provides low-latency, real-time push synchronization for live shift rosters,
 * waitlist promotions, and chaos events to the browser War-Room console.
 */
class SSEBroadcastHub {
  private clients = new Map<string, IClient>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  /** Upper bound on concurrent stream clients (unbounded maps are a memory-DoS vector). */
  private static readonly MAX_CLIENTS = 1000;

  constructor() {
    // 15-second heartbeat to maintain open persistent connections
    if (process.env.NODE_ENV !== 'test') {
      this.heartbeatInterval = setInterval(() => this.broadcastHeartbeat(), 15000);
      if (this.heartbeatInterval.unref) {
        this.heartbeatInterval.unref();
      }
    }
  }

  public registerClient(id: string, res: Response, userId?: string): void {
    if (this.clients.size >= SSEBroadcastHub.MAX_CLIENTS) {
      res.status(503).json({
        success: false,
        error: 'TOO_MANY_STREAM_CLIENTS',
        message: 'Live event stream is at capacity. Retry shortly.',
      });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    this.clients.set(id, { id, res, userId });

    res.on('close', () => {
      this.clients.delete(id);
    });

    // Send initial welcome event
    this.sendToClient(id, {
      type: 'CONNECTED',
      data: { clientId: id, message: 'Connected to WaveShift Nexus SSE Stream.' },
    });
  }

  public broadcast(message: ISSEMessage): void {
    const payload = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };

    const formatted = `event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`;

    for (const [, client] of this.clients.entries()) {
      try {
        // Drop dead half-open sockets instead of buffering unboundedly.
        if (client.res.destroyed || client.res.writableEnded) {
          this.clients.delete(client.id);
          continue;
        }
        client.res.write(formatted);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  public sendToClient(clientId: string, message: ISSEMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const formatted = `event: ${message.type}\ndata: ${JSON.stringify(message.data)}\n\n`;
    try {
      if (client.res.destroyed || client.res.writableEnded) {
        this.clients.delete(clientId);
        return;
      }
      client.res.write(formatted);
    } catch {
      this.clients.delete(clientId);
    }
  }

  private broadcastHeartbeat(): void {
    for (const [, client] of this.clients.entries()) {
      try {
        // Same liveness check as `broadcast`. A half-open socket never fires `close`,
        // and this loop runs every 15 s for the life of the process — so without the
        // check it is the path most likely to accumulate buffered writes to a peer
        // that is never coming back.
        if (client.res.destroyed || client.res.writableEnded) {
          this.clients.delete(client.id);
          continue;
        }
        client.res.write(':heartbeat\n\n');
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  public getConnectedCount(): number {
    return this.clients.size;
  }

  public teardown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clients.clear();
  }
}

export const eventHub = new SSEBroadcastHub();
