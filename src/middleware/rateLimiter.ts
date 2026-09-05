import rateLimit from 'express-rate-limit';

/**
 * Standard API rate limiter.
 * Allows 200 requests per minute per IP, with bypass for testing environments.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 10000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    message: 'Too many requests from this IP, please try again after a minute.',
    statusCode: 429,
  },
});
