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
      client.res.write(formatted);
    } catch {
      this.clients.delete(clientId);
    }
  }

  private broadcastHeartbeat(): void {
    for (const [, client] of this.clients.entries()) {
      try {
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
