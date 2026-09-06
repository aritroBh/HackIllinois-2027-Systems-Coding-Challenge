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
 *  3. Ensure every index declared on the models exists (`syncIndexes`).
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { Volunteer } from '../src/models/volunteer.model';
import { ClaimCode } from '../src/models/claimCode.model';
import { AuthToken } from '../src/models/authToken.model';

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

  // 3. Indexes.
  await Promise.all([Volunteer.syncIndexes(), ClaimCode.syncIndexes(), AuthToken.syncIndexes()]);
  console.log('indexes synced');

  await mongoose.disconnect();
  console.log('migration complete');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
