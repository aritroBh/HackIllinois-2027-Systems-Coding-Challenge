/**
 * Per-IP API rate limiting.
 *
 * Both the ceiling and the window are configuration, not constants:
 * `RATE_LIMIT_MAX` (default 300) and `RATE_LIMIT_WINDOW_MS` (default 60 s).
 *
 * This used to be a hardcoded 300/min whose only larger branch was selected by
 * `NODE_ENV === 'test'` — an environment in which `index.ts` deliberately skips
 * `bootstrap()` and never binds a port. The higher limit was therefore unreachable by
 * any running server, and no environment variable could raise it. For an event with
 * thousands of concurrent users, most of them sharing campus NAT or a load balancer
 * address, that made the limiter the binding constraint on capacity long before the
 * database or the application became one.
 *
 * Two things to size together when tuning:
 *
 *  - **The dashboard is chatty.** A single war-room load issues well over a dozen API
 *    calls, and its Server-Sent Events stream holds a slot for as long as the tab is
 *    open. Budget per *open dashboard*, not per human.
 *  - **`TRUST_PROXY_HOPS` decides what "per IP" means.** Left at 0 behind a proxy, every
 *    client collapses into one bucket and the whole event shares a single allowance.
 *
 * Requests that exceed the limit receive a 429 in the same envelope as every other
 * error, so clients need no special-case parsing.
 */
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

/**
 * Under `NODE_ENV=test` the suite drives hundreds of requests through a single
 * in-process client, so the limiter is raised out of the way — we are exercising
 * invariants there, not throttling. `Math.max` rather than a fixed value so an
 * explicitly configured higher limit still wins.
 */
const effectiveMax = env.NODE_ENV === 'test' ? Math.max(env.RATE_LIMIT_MAX, 10_000) : env.RATE_LIMIT_MAX;

export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: effectiveMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'TOO_MANY_REQUESTS',
    // Derived from the configured window rather than hardcoded: the message used to say
    // "after a minute", which became a lie the moment the window was made configurable.
    message: `Too many requests from this IP. Try again in ${Math.ceil(env.RATE_LIMIT_WINDOW_MS / 1000)}s.`,
    statusCode: 429,
  },
});
