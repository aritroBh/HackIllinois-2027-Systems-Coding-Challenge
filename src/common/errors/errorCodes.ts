/**
 * Canonical application error codes for Nexus Quest.
 * Adheres directly to HackIllinois Adonix API error standardization.
 *
 * The code is the half of an error response a client is allowed to branch on. A `message` is
 * prose for a human and gets reworded whenever somebody improves the wording; a code is a
 * contract. Every member's string value is identical to its name, so a code seen in a network
 * tab, a log line or a test assertion greps back to exactly one line in this file.
 *
 * The section headings below say which status each group is *usually* raised with. They are
 * not enforced here — the status comes from whichever `ApiError` factory carries the code
 * (`common/errors/apiError.ts`), and `NOT_FOUND` sits under the 409 heading while being the
 * default code of `ApiError.notFound`, which is a 404. Read the factory, not the heading.
 *
 * Some codes never reach the `error` field at all. Several call sites pass one inside
 * `details` instead, which puts it a level deeper than a client would look; the note on
 * `MALFORMED_TOKEN` spells that out.
 */
export enum ErrorCode {
  // Client Errors (400)
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  /**
   * The two QR-token rejections that never appear as an `error`. `checkin.service` raises
   * both through `ApiError.badRequest(message, { code })`, so the response reads
   * `error: 'BAD_REQUEST'` with the specific code buried in `details.code`. Whether that was
   * deliberate is not recorded anywhere; the consequence either way is that a client matching
   * on `error` alone cannot tell an expired token from a forged one.
   */
  MALFORMED_TOKEN = 'MALFORMED_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  /**
   * A 409, from three places in `checkin.service` that all mean "this token has been used":
   * the verifier's own replay reason, the `consumeNonce` call that spends the token once the
   * registration is settled, and the duplicate-key catch for when the unique index on
   * `CheckIn.nonce` gets there first. The three exist because the cheap in-process check does
   * not survive a restart or a second replica and the index does.
   */
  REPLAY_ATTACK_DETECTED = 'REPLAY_ATTACK_DETECTED',
  /** Like the token codes above, raised both as an `error` (avatar upload) and inside
   *  `details.code` (check-in coordinates, power-up targets). */
  MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',

  // Authentication & Authorization (401, 403)
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  /** A body/query `volunteerId` named someone other than the session's account. */
  IDENTITY_MISMATCH = 'IDENTITY_MISMATCH',
  /** Cookie-authenticated mutation without a matching X-CSRF-Token / subprotocol nonce. */
  CSRF_INVALID = 'CSRF_INVALID',
  /** Claim code / magic token unknown, expired or already used. */
  CREDENTIAL_INVALID = 'CREDENTIAL_INVALID',
  /** The requested identity provider is not enabled on this deployment. */
  PROVIDER_DISABLED = 'PROVIDER_DISABLED',
  /** An SSO identity matched an existing account by email only; link it from a signed-in session. */
  ACCOUNT_LINK_REQUIRED = 'ACCOUNT_LINK_REQUIRED',
  /** A signed-in caller presented an Adonix token without `link: true`; linking needs explicit intent. */
  ACCOUNT_LINK_CONFIRM = 'ACCOUNT_LINK_CONFIRM',

  // Not Found (404)
  SHIFT_NOT_FOUND = 'SHIFT_NOT_FOUND',
  VOLUNTEER_NOT_FOUND = 'VOLUNTEER_NOT_FOUND',
  REGISTRATION_NOT_FOUND = 'REGISTRATION_NOT_FOUND',
  SWAP_NOT_FOUND = 'SWAP_NOT_FOUND',

  // Conflict & Concurrency (409)
  SCHEDULE_CONFLICT = 'SCHEDULE_CONFLICT',
  SCHEDULE_BUFFER_CONFLICT = 'SCHEDULE_BUFFER_CONFLICT',
  DAILY_FATIGUE_EXCEEDED = 'DAILY_FATIGUE_EXCEEDED',
  MISSING_SKILL_CERTIFICATION = 'MISSING_SKILL_CERTIFICATION',
  /**
   * Two sources for one code. `registration.service` raises it from its own lookup for the
   * ordinary case, and `errorHandler` raises it when the unique index gets there first — a
   * race that beat the lookup. A client sees the same 409 either way.
   *
   * The handler's half is a split. A Mongo E11000 carries the index that tripped, so it
   * reports this code only when the `keyValue` holds both `shiftId` and `volunteerId` — the
   * registration pair — and `DUPLICATE_RESOURCE` for every other unique index. Before that
   * split, a duplicate volunteer email reported as a repeat signup.
   */
  ALREADY_REGISTERED = 'ALREADY_REGISTERED',
  SHIFT_FULL = 'SHIFT_FULL',
  /** An idempotency key replayed with a different payload hash: the cached response answers a
   *  different question, so it is refused rather than returned. */
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  /**
   * "Somebody else is, or was, inside this write." It carries two meanings a client cannot
   * tell apart from the code alone, which is worth knowing before building a retry on it.
   *
   * Retrying helps: an idempotency record whose first attempt is still PENDING, the
   * per-volunteer reservation lock held by another request, and a transaction that lost every
   * retry it was allowed (`TransactionContentionError`, converted by `errorHandler`). Nothing
   * was written for this caller, so repeating the request is safe.
   *
   * Retrying does not help: `sos.service` raises it when a ticket's compare-and-swap loses —
   * already dispatched, or already moved out of the status the transition expected. The other
   * writer committed, and sending the same request again finds the same losing state.
   *
   * A 409 rather than a 500 in either case, because the caller's request is intact — a 500
   * would read as a fault in the server when the only thing that happened is that somebody
   * else got there first.
   */
  CONCURRENT_MUTATION_IN_PROGRESS = 'CONCURRENT_MUTATION_IN_PROGRESS',
  SWAP_INVALID = 'SWAP_INVALID',
  SWAP_CONFLICT = 'SWAP_CONFLICT',
  FACTION_ALLEGIANCE_LOCKED = 'FACTION_ALLEGIANCE_LOCKED',
  /** The other half of the E11000 split described on `ALREADY_REGISTERED`: any unique index
   *  that is not the registration pair. */
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',
  /**
   * The generic 404 — what `ApiError.notFound` uses when the caller has no domain-specific
   * code to offer. It is grouped under the 409 heading, which is misleading and costs nothing
   * at runtime, since the status is the factory's and not this enum's.
   */
  NOT_FOUND = 'NOT_FOUND',

  // Rate limiting (429)
  /** Too many calls in the window — the per-lead presence listing, or a limiter bucket. */
  RATE_LIMITED = 'RATE_LIMITED',

  // Server & Database Errors (500)
  /** The only code the catch-all branch of `errorHandler` emits, with a fixed generic message:
   *  raw error text leaks collection and index names to whoever provoked it. */
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  /**
   * Declared but never raised — nothing under `src/` constructs an `ApiError` with either of
   * these. A driver or connection failure arrives as `INTERNAL_ERROR` from the catch-all, and
   * a transaction that exhausted its retries as `CONCURRENT_MUTATION_IN_PROGRESS`. Do not
   * write a client that waits for them.
   */
  DATABASE_ERROR = 'DATABASE_ERROR',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
}
