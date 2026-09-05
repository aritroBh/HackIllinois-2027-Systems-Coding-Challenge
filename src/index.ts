/**
 * Process entry point — database connection, HTTP listener, graceful shutdown.
 *
 * `app.ts` builds the Express application but never binds a port. That split is what
 * lets the test suite import `app` and drive it in-process with supertest, with no
 * listener and no port conflicts between parallel suites.
 *
 * Note the guard at the bottom: `bootstrap()` is skipped when `NODE_ENV === 'test'`, so
 * importing this module during tests does not start a server. A side effect worth
 * knowing is that the process therefore never listens under that env, which is why the
 * rate limiter's `NODE_ENV === 'test'` branch cannot be reached by a running server.
 *
 * Shutdown is ordered deliberately on SIGINT/SIGTERM: stop the SSE heartbeat, stop
 * accepting connections, then close the database. Draining in the other order would let
 * an in-flight request find its connection already gone.
 */
import { app } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { eventHub } from './common/sse/eventHub';

async function bootstrap() {
  try {
    await connectDatabase();

    const server = app.listen(env.PORT, () => {
      console.log('===============================================================');
      console.log(`🌊 WaveShift Nexus Engine Online [${env.NODE_ENV.toUpperCase()}]`);
      console.log(`📡 Server:      http://localhost:${env.PORT}`);
      console.log(`📖 Swagger UI:  http://localhost:${env.PORT}/docs`);
      console.log(`🎛️  War Room:   http://localhost:${env.PORT}/dashboard`);
      console.log('===============================================================');
    });

    // Slowloris defence. Node's defaults are permissive: `requestTimeout` is 300 s and
    // `headersTimeout` 60 s, so a client that announces a large Content-Length and then
    // sends nothing pins a connection for minutes. A few hundred such sockets exhaust
    // the server without any authentication or volume. These bounds cap how long a
    // single request may occupy a connection while still allowing slow mobile uploads.
    //
    // Values come from config because the right keep-alive depends on what fronts this
    // process — see the deployment note in `config/env.ts`. Warn rather than throw on a
    // bad ordering: a misconfigured timeout should not take an event offline, but it
    // must not pass silently either.
    if (env.REQUEST_TIMEOUT_MS <= env.HEADERS_TIMEOUT_MS) {
      console.warn(
        `⚠️  REQUEST_TIMEOUT_MS (${env.REQUEST_TIMEOUT_MS}) must exceed ` +
          `HEADERS_TIMEOUT_MS (${env.HEADERS_TIMEOUT_MS}); otherwise a request is killed ` +
          `before its own headers are allowed to finish arriving.`
      );
    }
    if (env.HEADERS_TIMEOUT_MS <= env.KEEP_ALIVE_TIMEOUT_MS) {
      console.warn(
        `⚠️  HEADERS_TIMEOUT_MS (${env.HEADERS_TIMEOUT_MS}) must exceed ` +
          `KEEP_ALIVE_TIMEOUT_MS (${env.KEEP_ALIVE_TIMEOUT_MS}); a keep-alive socket can ` +
          `otherwise be reaped mid-request.`
      );
    }
    server.requestTimeout = env.REQUEST_TIMEOUT_MS;
    server.headersTimeout = env.HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;

    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
      eventHub.teardown();
      // `server.close()` waits for every socket to drain, and an open dashboard holds its
      // Server-Sent Events stream forever — so without this, Ctrl-C hangs indefinitely
      // whenever anyone has the war room open. `scripts/devSeeded.ts` already did this;
      // the production entry point did not, which is the worse place to omit it.
      server.closeAllConnections?.();
      server.close(async () => {
        await disconnectDatabase();
        console.log('🏁 WaveShift Nexus shutdown complete.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('❌ Fatal bootstrap failure:', error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}
