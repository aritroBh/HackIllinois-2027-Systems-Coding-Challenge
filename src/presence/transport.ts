/**
 * Transport abstraction (plan §A4). The presence service never touches a socket: it talks
 * to `PresenceClient`s, which a `PresenceTransport` creates. Two exist — `wsTransport`
 * (production) and `sseTransport` (fallback for networks that block WebSockets) — and the
 * session logic in `session.ts` is identical for both.
 */
import type { AccountContext } from '../common/types/account';

export interface PresenceClient {
  readonly id: string;
  readonly account: AccountContext;
  readonly transport: 'ws' | 'sse';
  /** Binary rows when the client negotiated `enc:'bin'` (WebSocket only). */
  readonly binary: boolean;
  /** Returns false when the frame was dropped (socket gone or over the buffer cap). */
  send(msg: unknown): boolean;
  sendBinary(buf: ArrayBuffer): boolean;
  bufferedBytes(): number;
  close(code?: number, reason?: string): void;
}

export interface PresenceTransport {
  readonly name: 'ws' | 'sse';
  /** Called by the service on shutdown. */
  teardown(): void;
}
