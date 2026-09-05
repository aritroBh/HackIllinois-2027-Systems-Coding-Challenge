import { ErrorCode } from './errorCodes';

/**
 * Standardized HTTP ApiError for HackIllinois Adonix architecture.
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
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
  }

  public static validationError(message: string, details?: Array<unknown>): ApiError {
    return new ApiError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }

  public static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }

  public static forbidden(message = 'Permission denied.'): ApiError {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }

  public static notFound(message = 'Requested resource not found.', code = ErrorCode.BAD_REQUEST): ApiError {
    return new ApiError(404, code, message);
  }

  public static conflict(message: string, code = ErrorCode.SCHEDULE_CONFLICT, details?: Record<string, unknown>): ApiError {
    return new ApiError(409, code, message, details);
  }

  public static internal(message = 'An unexpected internal error occurred.'): ApiError {
    return new ApiError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}
