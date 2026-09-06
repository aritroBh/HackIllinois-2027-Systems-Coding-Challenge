import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
// Registers every model, so the index build below covers all of them rather than only the
// ones a given suite happens to import.
import '../src/models';
import { __clearAccountCache } from '../src/middleware/identity';
import { __resetAvatarRate } from '../src/services/avatar.service';
import { presenceStore } from '../src/presence/store';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await replSet.waitUntilRunning();
  const uri = replSet.getUri();
  await mongoose.connect(uri);

  // Build every declared index before the first test runs.
  //
  // Mongoose's `autoIndex` starts this in the background on first use of a model and does not
  // wait, so a suite that inserts immediately races the build. A test for a uniqueness
  // guarantee that runs before its unique index exists does not fail loudly — it passes for
  // the wrong reason on the second run, when the index is finally there, and fails on the
  // first. That is the worst shape a test can have, and it hid a genuine defect: twenty
  // concurrent booth scans all succeeded.
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}, 120000);

afterEach(async () => {
  if (mongoose.connection.db) {
    const collections = await mongoose.connection.db.collections();
    // `deleteMany`, never `drop`: dropping a collection takes its indexes with it, and the
    // next suite would then run against an unindexed collection exactly as described above.
    for (const collection of collections) {
      await collection.deleteMany({});
    }
  }

  // In-process state outlives the database, and that asymmetry is where cross-suite flakes
  // come from. The identity middleware caches accounts for sixty seconds, which is far longer
  // than a suite: an entry cached before this hook ran describes a document that no longer
  // exists, and the request that hits it is answered from a memory of deleted data. Clearing
  // caches here rather than in each suite means a new suite cannot forget to.
  __clearAccountCache();
  __resetAvatarRate();
  presenceStore.clear();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (replSet) {
    await replSet.stop();
  }
});
