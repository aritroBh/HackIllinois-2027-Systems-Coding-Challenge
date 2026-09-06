/**
 * Canonical application error codes for Nexus Quest.
 * Adheres directly to HackIllinois Adonix API error standardization.
 */
export enum ErrorCode {
  // Client Errors (400)
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MALFORMED_TOKEN = 'MALFORMED_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  REPLAY_ATTACK_DETECTED = 'REPLAY_ATTACK_DETECTED',
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
  ALREADY_REGISTERED = 'ALREADY_REGISTERED',
  SHIFT_FULL = 'SHIFT_FULL',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  CONCURRENT_MUTATION_IN_PROGRESS = 'CONCURRENT_MUTATION_IN_PROGRESS',
  SWAP_INVALID = 'SWAP_INVALID',
  SWAP_CONFLICT = 'SWAP_CONFLICT',
  FACTION_ALLEGIANCE_LOCKED = 'FACTION_ALLEGIANCE_LOCKED',
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',
  NOT_FOUND = 'NOT_FOUND',

  // Rate limiting (429)
  /** Too many calls in the window — the per-lead presence listing, or a limiter bucket. */
  RATE_LIMITED = 'RATE_LIMITED',

  // Server & Database Errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
}
