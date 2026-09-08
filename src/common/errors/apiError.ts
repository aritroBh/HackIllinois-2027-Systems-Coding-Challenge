/**
 * Standardized HTTP ApiError for HackIllinois Adonix architecture.
 *
 * The one error a service is expected to throw. Everything above it — controllers, routes,
 * services — signals failure by throwing one of these and lets `middleware/errorHandler.ts`
 * turn it into a response; that handler is the only place in the process where an error
 * becomes JSON, and `err instanceof ApiError` is the branch it reaches second — ahead of it
 * sits `TransactionContentionError`, which is not an `ApiError` and carries advice ("nothing
 * was written, try again") that is correct for nothing else. Anything else that
 * escapes a handler is classified there by inspection (Mongoose duplicate keys, cast errors,
 * malformed JSON) or falls into a deliberately vague 500.
 *
 * **`details` is echoed to the caller verbatim.** The handler copies the field straight into
 * the response body, so it holds only what the caller may see: the per-field Zod issue list, a
 * more specific error code, an id the client already sent. It is not a place for a driver
 * message, a query, or an internal id — that belongs in the server log the 500 branch writes.
 * The three factories that answer a caller who is not allowed in — `unauthorized`,
 * `forbidden`, `internal` — take no `details` at all, so there is no structured field to leak
 * through them.
 *
 * The static factories exist so a status and a code are paired in one place rather than at
 * each of the ~170 call sites. Two of them take an override for the code (`notFound`,
 * `conflict`) because the status is the stable half of the pair and the code is the half that
 * varies by domain.
 */
import { ErrorCode } from './errorCodes';

/**
 * Standardized HTTP API error carrying an HTTP status code, machine-readable ErrorCode,
 * human-readable message, and optional sanitised structured details payload.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly details?: Record<string, unknown> | Array<unknown>;

  constructor(
    statusCode: number,
    errorCode: ErrorCode,
    message: string,
    details?: Record<string, unknown> | Array<unknown>
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    // `instanceof ApiError` is what the error handler dispatches on, and a class extending a
    // built-in loses its prototype when TypeScript downlevels below ES6. Under the ES2022
    // target this compiles to, native `extends Error` already sets it and this line changes
    // nothing; it is insurance against a target change. `new.target` rather than
    // `ApiError.prototype` so a subclass would keep its own — there is none today.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** The general-purpose 400. Several callers pass a more specific `ErrorCode` inside
   *  `details.code`; see the note on `MALFORMED_TOKEN` in `errorCodes.ts` for what that costs
   *  a client. */
  public static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
  }

  /** One caller only, `middleware/validate.ts`, turning a `ZodError` into one
   *  `{field, message, rule}` entry per failed check so a client can point at the offending
   *  input rather than guess. A 400 — and the Swagger document now says so too; it documented
   *  422 on two operations for a long time, which would have made a generated client miss every
   *  validation failure the server actually returns. */
  public static validationError(message: string, details?: Array<unknown>): ApiError {
    return new ApiError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }

  /** No usable identity. Distinct from `forbidden`, which is a caller who is known and still
   *  not allowed — the difference tells a client whether signing in would help. */
  public static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }

  /** Known caller, insufficient rights. Role gates raise `INSUFFICIENT_PERMISSIONS` through
   *  the constructor instead when they can say which rule was missed. */
  public static forbidden(message = 'Permission denied.'): ApiError {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }

  /**
   * A 404, with the code left to the caller: `SHIFT_NOT_FOUND`, `VOLUNTEER_NOT_FOUND` and
   * `SWAP_NOT_FOUND` all come through here, so the status lives in one place and the domain
   * detail stays at the throw site.
   *
   * It is also the answer for something that exists and must not be admitted to: `devLogin`
   * raises `notFound('Route not found.')` in production rather than a 403, because a 403 on a
   * development-only route confirms the route is there. A 404 is a disclosure decision as
   * often as it is a lookup result.
   */
  public static notFound(message = 'Requested resource not found.', code = ErrorCode.NOT_FOUND): ApiError {
    return new ApiError(404, code, message);
  }

  /**
   * The 409 family, which in this codebase is most of the interesting failures: a shift that
   * filled between the read and the write, a swap whose other leg moved, an idempotency key
   * re-used with a different payload, a token already scanned. The default code fits the
   * scheduling callers and nobody else, and every other meaning passes its own — so a 409
   * carrying `SCHEDULE_CONFLICT` from a path that has nothing to do with a schedule is a
   * caller that forgot the second argument, not a deliberate label.
   */
  public static conflict(message: string, code = ErrorCode.SCHEDULE_CONFLICT, details?: Record<string, unknown>): ApiError {
    return new ApiError(409, code, message, details);
  }

  /** Rarely thrown deliberately — the handler's catch-all already produces this shape for an
   *  unhandled error. Worth using when a service knows it has hit an impossible state and
   *  would rather say so than let a null propagate. */
  public static internal(message = 'An unexpected internal error occurred.'): ApiError {
    return new ApiError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}
