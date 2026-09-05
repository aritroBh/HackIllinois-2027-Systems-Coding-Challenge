import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { env } from './env';

let replSet: MongoMemoryReplSet | null = null;

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
