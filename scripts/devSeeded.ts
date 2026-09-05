/**
 * One-command demo: boots an in-memory replica set, seeds it, and serves the
 * war room against that same database.
 *
 * `npm run dev` and `npm run seed` each spin up their own ephemeral Mongo, so
 * running them together leaves the server pointed at an empty database — the
 * dashboard renders but every panel is blank. This shares one instance.
 *
 *   npm run demo
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** Tracked so a failed boot can still stop the mongod it already started. */
let activeReplSet: MongoMemoryReplSet | undefined;

async function main(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  // Set before any module reads config/env, so both the seeder and the app
  // resolve to this instance rather than starting their own.
  activeReplSet = replSet;
  process.env.MONGODB_URI = replSet.getUri();

  const { connectDatabase, disconnectDatabase } = await import('../src/config/database');
  await connectDatabase();

  const { seedDatabase } = await import('../src/seed/seedData');
  await seedDatabase();

  const { app } = await import('../src/app');
  const { env } = await import('../src/config/env');

  const server = app.listen(env.PORT, () => {
    console.log('===============================================================');
    console.log('🌊 WaveShift Nexus — seeded demo');
    console.log(`🎛️  War Room:   http://localhost:${env.PORT}/dashboard`);
    console.log(`📖 Swagger UI:  http://localhost:${env.PORT}/docs`);
    console.log('===============================================================');
  });

  // Match the production entry point's slowloris bounds so the demo behaves the same,
  // reading the same configuration rather than duplicating the numbers.
  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.headersTimeout = env.HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n🛑 ${signal} — shutting down.`);
    // server.close() only fires once every connection drains, and the
    // dashboard holds an SSE stream open indefinitely, so Ctrl-C would hang
    // forever with the dashboard open. Close sockets outright and cap the wait.
    server.closeAllConnections?.();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
    await disconnectDatabase().catch(() => undefined);
    await replSet.stop().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  console.error('❌ Seeded demo failed to start:', err);
  // Without this the mongod child process outlives the failed boot.
  await activeReplSet?.stop().catch(() => undefined);
  process.exit(1);
});
