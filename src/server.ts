/**
 * The one `http.Server` factory.
 *
 * `src/index.ts` and `scripts/devSeeded.ts` used to call `app.listen` independently, which
 * meant anything that must attach to the raw server — the socket timeouts, and from M4 the
 * WebSocket `upgrade` handler for presence — had to be duplicated or was silently missing
 * from one entry point. Both now call `createServer(app)` and get the same object.
 *
 * Timeouts come from configuration; see the deployment note in `config/env.ts`.
 */
import http from 'http';
import { Application } from 'express';
import { env } from './config/env';
import { attachPresenceWs } from './presence/wsTransport';
import { presenceService } from './presence/service';
import { startScheduler, stopScheduler } from './scheduler';
import { wireEconomy } from './economy/wiring';

export interface ServerHooks {
  /** Called with the server before it listens; presence attaches its upgrade handler here. */
  attach?: Array<(server: http.Server) => void>;
}

export function createServer(app: Application, hooks: ServerHooks = {}): http.Server {
  const server = http.createServer(app);

  if (env.REQUEST_TIMEOUT_MS <= env.HEADERS_TIMEOUT_MS) {
    console.warn(
      `⚠️  REQUEST_TIMEOUT_MS (${env.REQUEST_TIMEOUT_MS}) must exceed HEADERS_TIMEOUT_MS (${env.HEADERS_TIMEOUT_MS}); ` +
        `otherwise a request is killed before its own headers are allowed to finish arriving.`
    );
  }
  if (env.HEADERS_TIMEOUT_MS <= env.KEEP_ALIVE_TIMEOUT_MS) {
    console.warn(
      `⚠️  HEADERS_TIMEOUT_MS (${env.HEADERS_TIMEOUT_MS}) must exceed KEEP_ALIVE_TIMEOUT_MS (${env.KEEP_ALIVE_TIMEOUT_MS}); ` +
        `a keep-alive socket can otherwise be reaped mid-request.`
    );
  }
  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.headersTimeout = env.HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;

  // Live presence: the WebSocket upgrade handler and the 1 Hz tick. Both entry points get
  // them because both build the server here.
  if (env.PRESENCE_ENABLED) {
    attachPresenceWs(server);
    presenceService.start();
    server.on('close', () => presenceService.stop());
  }

  // Reward rules subscribe to the domain bus here rather than inside the services that
  // publish, so a service never has to know what its event is worth.
  wireEconomy();

  // Periodic work (SOS escalation, the SSE presence sweep) — one timer for the process.
  startScheduler();
  server.on('close', () => stopScheduler());

  for (const attach of hooks.attach ?? []) attach(server);
  return server;
}
