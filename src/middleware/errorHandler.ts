import { Request, Response, NextFunction } from 'express';
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

  // Handle Mongoose Duplicate Key Error (E11000)
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
    res.status(409).json({
      success: false,
      error: ErrorCode.ALREADY_REGISTERED,
      message: 'Duplicate key conflict: A record with these unique properties already exists.',
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

  // Unhandled internal server error
  console.error('Unhandled Internal Server Error:', err);
  res.status(500).json({
    success: false,
    error: ErrorCode.INTERNAL_ERROR,
    message: err instanceof Error ? err.message : 'An unexpected error occurred.',
    statusCode: 500,
  });
}
