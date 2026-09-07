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

/**
 * The escape hatch for an entry point that needs the raw server for something this factory
 * does not already do for everybody. Presence does not use it — the factory attaches the
 * upgrade handler itself, under `PRESENCE_ENABLED`, precisely so that no caller has to
 * remember to ask. Nothing in this repository passes an `attach` today; the three callers of
 * `createServer` all hand it the app and nothing else.
 */
export interface ServerHooks {
  /** Called with the server before it listens, in the order given. */
  attach?: Array<(server: http.Server) => void>;
}

/**
 * Build the process's HTTP server, with everything that has to hang off the raw socket layer
 * already attached.
 *
 * The reason this exists rather than `app.listen` is in the file header: two entry points
 * drifted. So treat the body as a checklist that every entry point is entitled to — timeouts,
 * the presence upgrade handler and tick, the economy bus wiring, the scheduler — and add to it
 * here rather than at a call site.
 *
 * The two warnings are the interesting part. Node applies these three timeouts to the same
 * socket, and the ordering between them is a real constraint rather than a style preference:
 * `headersTimeout` measures how long the headers may take to arrive, `requestTimeout` bounds
 * the whole request, and `keepAliveTimeout` says how long an idle socket is kept for reuse.
 * Configure them out of order and the failure is not a startup error but a fraction of
 * requests killed mid-flight under load, which is close to undiagnosable from the outside.
 * They are warnings and not a refusal to boot: a misordered pair still serves traffic, and
 * refusing to start the event's server over a configuration smell is the worse trade.
 *
 * Everything after the timeouts is process-global rather than per-server, and each piece
 * guards itself against a second call: `wireEconomy` returns early once wired, and both
 * `startScheduler` and `presenceService.start` return early once their timer exists. So a
 * second `createServer` in one process yields a second socket but not a second tick. The
 * corollary is the part that bites: closing one
 * server stops the scheduler and the presence tick for the whole process, because the `close`
 * listeners registered here call the same process-wide `stop` functions.
 */
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
