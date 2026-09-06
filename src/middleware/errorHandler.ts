/**
 * The single place an error becomes an HTTP response.
 *
 * Express identifies an error handler by its four-argument signature and only routes to
 * it via `next(err)`, which is why this is registered last in `app.ts` — anything mounted
 * after it would bypass it entirely.
 *
 * The branches are ordered most-specific to least, and each one exists because the
 * generic 500 below was the wrong answer for that case:
 *
 *  1. `ApiError` — errors this codebase raised on purpose, already carrying a status and
 *     a machine-readable code. Passed through as-is.
 *  2. Malformed JSON — a client syntax error that used to report as a server fault *and*
 *     log a stack trace per request, making it a log-flooding vector.
 *  3. Duplicate key (E11000) — split by which index tripped, so a repeat registration and
 *     a duplicate email do not report the same code.
 *  4. `CastError` / `ValidationError` — Mongoose rejecting input. Client errors, 400.
 *  5. Everything else — a genuine 500.
 *
 * The 500 message is deliberately generic. Echoing raw error text back to a caller leaks
 * collection names, index names and driver internals, which is free reconnaissance; the
 * detail goes to the server log instead, where it is useful and not public.
 */
import { Request, Response, NextFunction } from 'express';
import { TransactionContentionError } from '../common/db/withTransactionRetry';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';

/**
 * Global Centralized Error Handler for Express.
 * Formats errors into HackIllinois Adonix-standardized JSON error responses.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // A transaction that lost every race it was allowed to run wrote nothing, so the caller's
  // request is intact and repeating it is the right advice. Answered as a conflict with that
  // advice rather than as a 500, which would read as a fault in the server when the only
  // thing that happened is that the server was busy.
  if (err instanceof TransactionContentionError) {
    res.status(409).json({
      success: false,
      error: ErrorCode.CONCURRENT_MUTATION_IN_PROGRESS,
      message: 'That was busy for a moment and nothing was changed. Try again.',
      statusCode: 409,
    });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.errorCode,
      message: err.message,
      statusCode: err.statusCode,
      details: err.details,
    });
    return;
  }

  // Malformed JSON body. `express.json()` raises a SyntaxError tagged
  // `entity.parse.failed` and already carrying `status: 400`, but it is not an ApiError,
  // so it used to fall through to the generic 500 branch below — reporting a client
  // syntax error as a server fault and logging a full stack trace for every occurrence.
  // Sending a few hundred malformed bodies was therefore also a log-flooding vector.
  if (
    err instanceof SyntaxError &&
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.parse.failed'
  ) {
    res.status(400).json({
      success: false,
      error: ErrorCode.BAD_REQUEST,
      message: 'Malformed JSON in request body.',
      statusCode: 400,
    });
    return;
  }

  // Handle Mongoose Duplicate Key Error (E11000). Registration-pair
  // conflicts keep ALREADY_REGISTERED; anything else (e.g. duplicate volunteer
  // email) previously misreported the same code.
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
    const keyValue =
      'keyValue' in err ? ((err as { keyValue?: Record<string, unknown> }).keyValue ?? {}) : {};
    const isRegistrationPair =
      typeof keyValue === 'object' && keyValue !== null && 'shiftId' in keyValue && 'volunteerId' in keyValue;
    res.status(409).json({
      success: false,
      error: isRegistrationPair ? ErrorCode.ALREADY_REGISTERED : ErrorCode.DUPLICATE_RESOURCE,
      message: isRegistrationPair
        ? 'Duplicate key conflict: This volunteer already holds an active registration for the shift.'
        : 'Duplicate key conflict: A record with these unique properties already exists.',
      statusCode: 409,
    });
    return;
  }

  // Handle Mongoose CastError (invalid ObjectId)
  if (typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'CastError') {
    res.status(400).json({
      success: false,
      error: ErrorCode.BAD_REQUEST,
      message: 'Invalid identifier format.',
      statusCode: 400,
    });
    return;
  }

  // Handle Mongoose ValidationError (schema min/max/enum) as 400, not a 500
  // with driver internals.
  if (typeof err === 'object' && err !== null && 'name' in err && (err as { name: string }).name === 'ValidationError') {
    res.status(400).json({
      success: false,
      error: ErrorCode.VALIDATION_ERROR,
      message: 'Request failed schema validation.',
      statusCode: 400,
    });
    return;
  }

  // Unhandled internal server error. The message is deliberately generic:
  // echoing raw error text leaks driver/collection internals to callers.
  // Full detail stays server-side in the `console.error` on the next line.
  console.error('Unhandled Internal Server Error:', err);
  res.status(500).json({
    success: false,
    error: ErrorCode.INTERNAL_ERROR,
    message: 'An unexpected internal error occurred.',
    statusCode: 500,
  });
}
