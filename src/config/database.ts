/**
 * Database connection lifecycle.
 *
 * Two modes, chosen by whether `MONGODB_URI` is set:
 *
 *  - **Configured.** Connect to the URI given. This is the production path.
 *  - **Zero-config.** Start an in-memory MongoDB *replica set* and connect to that, so
 *    `git clone && npm install && npm run demo` works with no database installed.
 *
 * The in-memory instance is a replica set of one rather than a standalone `mongod`, and
 * that detail is load-bearing: MongoDB only offers multi-document transactions on a
 * replica set. The bilateral swap and the cyclic rotation both depend on
 * `session.withTransaction`, so a standalone server would fail them at runtime rather
 * than at startup — a confusing way to discover the requirement.
 *
 * WiredTiger is named explicitly for the same reason: it is the storage engine whose
 * document-level concurrency control makes the atomic `$expr` capacity guard meaningful.
 */
import mongoose from 'mongoose';
import { env } from './env';

/**
 * `mongodb-memory-server` is a development dependency and is imported lazily, at the point
 * the in-memory path is actually taken.
 *
 * A top-level import would be evaluated on every boot, including in a production image that
 * installs `--omit=dev` and therefore does not have the package. The failure is
 * `Cannot find module 'mongodb-memory-server'` from a file that was only ever going to
 * connect to the configured URI — a module-resolution error standing in for a database that
 * was reachable all along. The production boot guard already refuses to start without
 * `MONGODB_URI`, so this branch cannot run there.
 *
 * The type is imported separately: `import type` is erased at compile time and pulls nothing
 * into the runtime graph.
 */
type MemoryReplSet = import('mongodb-memory-server').MongoMemoryReplSet;

let replSet: MemoryReplSet | null = null;

/**
 * Connect, by whichever of the two modes this process is configured for, and return the URI
 * actually used.
 *
 * The return value is currently unused — `src/index.ts` and the seeder both discard it — and
 * is kept because the in-memory path *invents* its URI, so this is the only place that
 * address exists. Anything that needs to hand it to another process (a second seeder, a
 * benchmark harness) has nowhere else to read it from.
 *
 * There is no retry and no backoff here. A configured URI that does not answer is a
 * misconfiguration or an outage, and failing at boot is what makes `/ready` mean something —
 * a process that started anyway and reconnects later would report itself healthy to an
 * orchestrator while every request hangs. Reconnection *after* a successful connect is
 * Mongoose's own business and is what `/ready` reports on.
 */
export async function connectDatabase(): Promise<string> {
  if (env.MONGODB_URI) {
    console.log('🔌 Connecting to configured MongoDB instance...');
    await mongoose.connect(env.MONGODB_URI);
    console.log('✅ Connected to MongoDB.');
    return env.MONGODB_URI;
  }

  console.log('⚡ [ZERO-CONFIG] Initializing In-Memory MongoDB Replica Set for ACID Transactions...');
  const start = Date.now();

  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  await replSet.waitUntilRunning();
  const uri = replSet.getUri();

  await mongoose.connect(uri);
  console.log(`🚀 In-Memory MongoDB online in ${Date.now() - start}ms at: ${uri}`);
  return uri;
}

/**
 * Tear down, in the order that matters: the client first, then the server it was talking to.
 *
 * Stopping the replica set with sockets still open makes `mongod` go away underneath an active
 * connection, which surfaces as connection errors during shutdown — noise on a path that is
 * already finishing, and in the test suite an open handle that keeps the process alive.
 *
 * Both halves are guarded — `readyState !== 0`, `replSet` non-null — so this is safe to call
 * twice and safe to call against a connection this module did not open. The seeder needs
 * exactly that: it connects only when nobody has connected for it, and then disconnects
 * unconditionally at the end of its chain.
 */
export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
    replSet = null;
    console.log('🛑 In-Memory MongoDB replica set stopped.');
  }
}
