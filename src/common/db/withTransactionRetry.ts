/**
 * Transaction runner with the driver's three-way retry semantics spelled out.
 *
 * `session.withTransaction` already implements most of this, but it retries the body an
 * unbounded number of times and it hides which unique index a duplicate-key error hit.
 * Both matter for money. A bounty reservation increments a spend counter, so a body that
 * is silently re-run more times than the caller expects is how somebody gets charged
 * twice; and a duplicate key on the ledger row means "another request created your row,
 * carry on", while a duplicate key on any other collection means the caller's own write
 * lost a real uniqueness race. Collapsing those two into one opaque error forces the
 * caller to guess, and the wrong guess double-charges.
 *
 * The three branches, and why each is different:
 *
 *  - **TransientTransactionError.** The transaction saw a write conflict or a stepdown and
 *    committed nothing at all. Nothing it wrote is durable, so re-running the whole body is
 *    safe and is the only way to make progress. This runner re-runs it up to five times with
 *    a short jittered backoff. The figure is not arbitrary: the bounty ledger has every
 *    concurrent request contending on one document, and with a single retry a request that
 *    loses twice fails while its budget still has room. Losing a race is not a reason to
 *    refuse someone.
 *
 *  - **UnknownTransactionCommitResult.** The commit was sent and the answer was lost. The
 *    transaction may already be durable. Re-running the body here is the double-charge
 *    case: the first commit could land after the second body has read a stale counter.
 *    Only the *commit* is retried, and commit is idempotent for an already-committed
 *    transaction, so retrying it either confirms the earlier commit or performs it once.
 *
 *  - **Duplicate key (E11000).** Deterministic. Re-running the same body produces the same
 *    collision forever, so a retry is a busy-loop, and a blind retry of a body whose
 *    earlier writes were fine is the second way to double-charge. Instead the error is
 *    rethrown as `DuplicateKeyError`, which names the collection and index that tripped so
 *    the caller can decide: absorb it, translate it to a 409, or re-run deliberately.
 *
 * The body must therefore be re-runnable: a pure function of its arguments and of database
 * state read through the session it is handed. Anything the body does outside the session
 * (an SSE broadcast, a counter in process memory, an email) happens once per attempt and
 * does not roll back, so it belongs after `withTransactionRetry` returns, not inside it.
 */
import mongoose, { ClientSession } from 'mongoose';

/**
 * Taken from the session's own signature rather than imported from `mongodb`. Mongoose
 * bundles its own copy of the driver, and the two `TransactionOptions` are distinct types
 * to the compiler even when they are identical in shape.
 */
type TransactionOptions = NonNullable<Parameters<ClientSession['startTransaction']>[0]>;

/**
 * A unique index rejected a write. `collection` and `index` are carried out of the raw
 * driver message because the caller's decision depends on which constraint tripped.
 */
export class DuplicateKeyError extends Error {
  public readonly collection: string;
  public readonly index: string;
  public readonly keyValue: Record<string, unknown>;
  public readonly cause: unknown;

  constructor(collection: string, index: string, keyValue: Record<string, unknown>, cause: unknown) {
    super(`Duplicate key on ${collection}${index ? ` (index ${index})` : ''}.`);
    this.name = 'DuplicateKeyError';
    this.collection = collection;
    this.index = index;
    this.keyValue = keyValue;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ITransactionRetryOptions {
  /**
   * How many times the commit alone may be resent after an unknown result. Three is the
   * driver's own convention: enough to ride out a failover, few enough that a genuinely
   * unreachable primary surfaces instead of hanging the request.
   */
  maxCommitAttempts?: number;
  /** Whole-body re-runs allowed after a transient conflict. Default 5. */
  maxBodyAttempts?: number;
  /** Passed through to `startTransaction`; majority write concern is the default. */
  transactionOptions?: TransactionOptions;
}

const DEFAULT_TRANSACTION_OPTIONS: TransactionOptions = {
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/**
 * Runs `fn` inside a transaction, applying the retry rules described above.
 *
 * @param fn Body of the transaction. Every read and write inside it must pass the session
 *           it is given, or that operation runs outside the transaction and will not roll
 *           back with it.
 * @returns Whatever `fn` returned, once the commit is known to have succeeded.
 */
/**
 * A few milliseconds, growing, with jitter. Retrying instantly just re-runs the same race;
 * the jitter is what stops N losers all coming back at the same instant and colliding again.
 */
async function backoff(attempt: number): Promise<void> {
  const base = Math.min(2 ** attempt, 16);
  await new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * base)));
}

export async function withTransactionRetry<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: ITransactionRetryOptions = {}
): Promise<T> {
  const maxCommitAttempts = options.maxCommitAttempts ?? 3;
  // How many times the WHOLE body may be re-run after a transient conflict.
  //
  // One retry is the textbook figure and it is not enough here. The bounty reservation has
  // every concurrent request contending on a single ledger document, so with ten in flight
  // a given transaction can lose the race twice in a row through no fault of its own. With
  // one retry those requests surface an error, which means a budget with room in it refuses
  // a legitimate reservation. Re-running a transient failure is safe by definition — it
  // committed nothing — so the bound exists to stop a genuinely deadlocked workload
  // spinning, not to ration attempts.
  const maxBodyAttempts = options.maxBodyAttempts ?? 5;
  const transactionOptions = options.transactionOptions ?? DEFAULT_TRANSACTION_OPTIONS;
  const session = await mongoose.startSession();

  try {
    let bodyAttempts = 1;

    for (;;) {
      session.startTransaction(transactionOptions);

      let result: T;
      try {
        result = await fn(session);
      } catch (err) {
        await abortQuietly(session);
        const duplicate = asDuplicateKeyError(err);
        if (duplicate) throw duplicate;
        if (bodyAttempts < maxBodyAttempts && hasErrorLabel(err, 'TransientTransactionError')) {
          bodyAttempts += 1;
          await backoff(bodyAttempts);
          continue;
        }
        throw err;
      }

      try {
        await commitWithRetry(session, maxCommitAttempts);
      } catch (err) {
        // A commit can itself report the transaction as transient, which means it aborted
        // server-side and wrote nothing. That is a whole-body case, not a commit case.
        if (bodyAttempts < maxBodyAttempts && hasErrorLabel(err, 'TransientTransactionError')) {
          await abortQuietly(session);
          bodyAttempts += 1;
          await backoff(bodyAttempts);
          continue;
        }
        await abortQuietly(session);
        throw err;
      }

      return result;
    }
  } finally {
    await session.endSession();
  }
}

/**
 * Resend the commit while the server keeps saying it does not know whether the commit
 * landed. Safe to repeat: committing an already-committed transaction is a no-op, which is
 * exactly what makes this branch different from re-running the body.
 */
async function commitWithRetry(session: ClientSession, maxAttempts: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      const retryable =
        hasErrorLabel(err, 'UnknownTransactionCommitResult') && !hasErrorLabel(err, 'TransientTransactionError');
      if (!retryable || attempt >= maxAttempts) throw err;
    }
  }
}

/**
 * Aborting is best-effort cleanup on a path that is already failing. If the transaction is
 * gone the abort fails, and reporting that failure instead of the original error would hide
 * the reason the caller is here.
 */
async function abortQuietly(session: ClientSession): Promise<void> {
  if (!session.inTransaction()) return;
  try {
    await session.abortTransaction();
  } catch {
    // Deliberately swallowed; see above.
  }
}

/**
 * Error labels are the driver's contract for retry decisions. Older wrapped errors expose
 * the raw `errorLabels` array instead of the `hasErrorLabel` method, so both are read.
 */
function hasErrorLabel(err: unknown, label: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { hasErrorLabel?: (l: string) => boolean; errorLabels?: unknown };
  if (typeof candidate.hasErrorLabel === 'function') {
    try {
      return candidate.hasErrorLabel(label);
    } catch {
      // Fall through to the array form.
    }
  }
  return Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label);
}

/**
 * Recognise E11000 and pull the collection and index out of it.
 *
 * The driver reports the offending namespace only inside the message text
 * (`E11000 duplicate key error collection: nexus.bountyledgers index: accountId_1_day_1`),
 * so the collection name is parsed from there. `keyValue` is structured and is copied as
 * given.
 */
export function asDuplicateKeyError(err: unknown): DuplicateKeyError | null {
  if (err instanceof DuplicateKeyError) return err;
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { code?: unknown; message?: unknown; errmsg?: unknown; keyValue?: unknown };
  if (candidate.code !== 11000) return null;

  const text = String(candidate.errmsg ?? candidate.message ?? '');
  const namespace = /collection:\s*(\S+)/.exec(text)?.[1] ?? '';
  const collection = namespace.includes('.') ? namespace.slice(namespace.indexOf('.') + 1) : namespace;
  const index = /index:\s*(\S+)/.exec(text)?.[1] ?? '';
  const keyValue =
    typeof candidate.keyValue === 'object' && candidate.keyValue !== null
      ? (candidate.keyValue as Record<string, unknown>)
      : {};

  return new DuplicateKeyError(collection, index, keyValue, err);
}

/** True when `err` is a duplicate-key rejection from the named collection. */
export function isDuplicateKeyOn(err: unknown, collection: string): boolean {
  const duplicate = asDuplicateKeyError(err);
  return duplicate !== null && duplicate.collection === collection;
}
