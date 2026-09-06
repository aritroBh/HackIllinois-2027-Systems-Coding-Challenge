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
import { createServer } from './server';

async function bootstrap() {
  try {
    await connectDatabase();

    // Socket timeouts (slowloris defence) and every raw-server attachment live in
    // `createServer`, shared with `scripts/devSeeded.ts` so the two entry points cannot drift.
    const server = createServer(app);
    server.listen(env.PORT, () => {
      console.log('===============================================================');
      console.log(`🌊 Nexus Quest Engine Online [${env.NODE_ENV.toUpperCase()}] auth=${env.AUTH_MODE}`);
      console.log(`📡 Server:      http://localhost:${env.PORT}`);
      console.log(`📖 Swagger UI:  http://localhost:${env.PORT}/docs`);
      console.log(`🎛️  War Room:   http://localhost:${env.PORT}/dashboard`);
      console.log('===============================================================');
    });

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
        console.log('🏁 Nexus Quest shutdown complete.');
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
