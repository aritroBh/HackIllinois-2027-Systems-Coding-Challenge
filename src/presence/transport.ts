/**
 * Transport abstraction (plan §A4). The presence service never touches a socket: it holds
 * `PresenceClient`s, and a client is the whole of what a transport owes it. Two modules supply
 * one — `wsTransport` (production) and `sseTransport` (the fallback for networks that block
 * WebSockets) — and the session logic in `session.ts` is identical for both, which is why the
 * SSE leg needs no frame-building code of its own, only an object that knows where to write.
 *
 * `PresenceTransport` below is the other half of the plan's abstraction and was never built:
 * nothing implements it and nothing imports it. Each transport is a module of functions
 * instead — `attachPresenceWs` from `server.ts`, `ensureSseSession` from the presence routes.
 * Read it as a proposal rather than as a contract anything honours.
 */
import type { AccountContext } from '../common/types/account';

/**
 * What the service and the session may assume about a connected client.
 *
 * Two rules the signatures do not show. `close()` has to end with the service no longer
 * holding the session — the WebSocket client reaches that through its socket's `close`
 * handler, the SSE client by calling `presenceService.remove` itself — because a client that
 * closed without unregistering stays in the session map and is built a frame every tick for
 * the life of the process. And `id` is per connection, not per account: a phone and a laptop
 * are two clients, and `PresenceService.byAccount` is what relates them.
 *
 * The booleans coming back from `send` and `sendBinary` are advisory and no caller reads one
 * today. A dropped frame is not retried, and a delta will not resend what it believes was
 * already sent; what actually repairs a client is the fifteen-second full snapshot, which
 * clears the session's `sentVersion` map, or a `resync` the client asks for itself.
 */
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

/**
 * The transport-side half of the abstraction, and the half that is not built: nothing
 * implements this interface, nothing imports it, and `teardown` therefore has no caller.
 * Shutdown runs through `presenceService.stop()` instead, which closes every session's client
 * directly and is wired to the HTTP server's `close` event in `server.ts`.
 */
export interface PresenceTransport {
  readonly name: 'ws' | 'sse';
  /** Called by the service on shutdown. */
  teardown(): void;
}
