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
 * Connect to MongoDB.
 * If MONGODB_URI is provided, connects directly.
 * Otherwise, spins up an in-memory MongoDB replica set with WiredTiger for ACID transactions.
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
 * Disconnect from MongoDB and shut down in-memory replica set if active.
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
