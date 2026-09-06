/**
 * One-shot schema migration for M1 identity fields.
 *
 *   npm run migrate            (uses MONGODB_URI from the environment / .env)
 *
 * Idempotent: every step is an upsert-style operation that is a no-op when already
 * applied, so it is safe to run on every deploy.
 *
 *  1. Drop the pre-M1 non-sparse unique index on `volunteers.email` (badge-claim hackers
 *     have no email; a non-sparse unique index would allow exactly one of them) and let
 *     Mongoose create the sparse one declared on the schema.
 *  2. Backfill `kind`, `identities`, `sessionVersion`, `presenceOptIn`, `streak`,
 *     `reliability` on documents created before the fields existed.
 *  3. Ensure every index declared on ANY model exists (`syncIndexes` over the whole
 *     registry). This used to name three models by hand, which meant the once-per-account
 *     booth index, the sticker ledger's idempotency index and the bounty ledger's daily key
 *     were left to Mongoose's background `autoIndex`. That does build them, eventually, and
 *     "eventually" is a race against the first sponsor scan of the event: a uniqueness
 *     constraint that is not there yet does not stop a double payment.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Volunteer } from '../src/models/volunteer.model';
// The barrel, so every model is registered before the registry is walked below. A model whose
// file nobody imported is invisible to `mongoose.models` and its indexes would be skipped.
import '../src/models';

async function main(): Promise<void> {
  if (!env.MONGODB_URI) {
    console.error('MONGODB_URI is required to run a migration (the in-memory database has nothing to migrate).');
    process.exit(1);
  }
  await mongoose.connect(env.MONGODB_URI);
  const db = mongoose.connection.db!;

  // 1. Replace the legacy email index.
  const volunteers = db.collection('volunteers');
  const indexes = await volunteers.indexes();
  for (const idx of indexes) {
    const isEmailOnly = idx.key && Object.keys(idx.key).length === 1 && idx.key.email === 1;
    if (isEmailOnly && idx.unique && !idx.sparse) {
      console.log(`dropping non-sparse unique index ${idx.name} on volunteers.email`);
      await volunteers.dropIndex(idx.name as string);
    }
  }

  // 2. Backfill.
  const backfill = await volunteers.updateMany(
    { kind: { $exists: false } },
    {
      $set: {
        kind: 'VOLUNTEER',
        identities: [],
        sessionVersion: 0,
        avatarHash: null,
        presenceOptIn: false,
        streak: { count: 0, lastDay: null },
        reliability: { completed: 0, noShow: 0 },
      },
    }
  );
  console.log(`backfilled ${backfill.modifiedCount} volunteer document(s)`);
  const blankEmails = await volunteers.updateMany({ email: '' }, { $set: { email: null } });
  if (blankEmails.modifiedCount) console.log(`normalised ${blankEmails.modifiedCount} blank email(s) to null`);

  // 3. Indexes, across every registered model.
  const models = Object.values(mongoose.models);
  const synced = await Promise.all(
    models.map(async (model) => {
      try {
        await model.syncIndexes();
        return null;
      } catch (err) {
        // Named rather than swallowed: an index that cannot be built is usually a duplicate
        // already in the data, and the operator has to see which collection to go and look at.
        return `${model.modelName}: ${(err as Error).message}`;
      }
    })
  );
  const failed = synced.filter(Boolean);
  console.log(`indexes synced across ${models.length - failed.length}/${models.length} model(s)`);
  for (const line of failed) console.error(`  index sync failed — ${line}`);
  if (failed.length) process.exitCode = 1;

  await mongoose.disconnect();
  console.log('migration complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
