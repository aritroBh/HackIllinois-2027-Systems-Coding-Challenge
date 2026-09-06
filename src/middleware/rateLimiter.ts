/**
 * The one rate-key table (plan A3). Identity first, then path.
 *
 * The old limiter keyed everything by IP, which is the wrong axis for this event: 1,200
 * people on venue Wi-Fi arrive from a handful of NAT egress addresses, so any per-IP figure
 * tight enough to stop one abuser locks out the whole room. Buckets are therefore chosen by
 * *who is asking*:
 *
 *  (a) **Authenticated request** (`req.account` set by the identity middleware) → an
 *      account bucket only — `RATE_LIMIT_MAX`/window (default 300/min) for everything,
 *      plus 90/min for mutations. Authenticated traffic never touches an IP bucket, so 300
 *      people behind one address cannot exhaust anything by polling.
 *  (b) **Anonymous credential exchange** (`POST /auth/claim`, `/auth/magic*`, `/auth/adonix`)
 *      → 30/min/IP. Bounds brute force on 50-bit claim codes; the identity middleware
 *      mounts `authExchangeLimiter` on exactly those routes.
 *  (c) **Anonymous everything else** → 600/min/IP (`anonymousLimiter`). In `legacy` mode
 *      this is what the open dashboard reads use; in `required` mode only the small
 *      allow-list (`/health`, `/ready`, `/auth/providers`, `/api/v1/content`) gets here
 *      because the identity middleware 401s the rest.
 *  (d) **IP ceiling**, 3,000/min over anonymous traffic only (`ipCeilingLimiter`) — the
 *      sum of (b)+(c) from one address. An anti-abuse stop, not a capacity control.
 *
 * Addresses in `TRUSTED_EGRESS_CIDRS` (the venue's egress ranges) get a 10× allowance on
 * the per-IP limiters, never an exemption: the venue is the one place a shared address is
 * legitimately hot, but it is also where an attacker on the Wi-Fi sits.
 *
 * `TRUST_PROXY_HOPS` decides what "per IP" means. Left at 0 behind a proxy, every client
 * collapses into one bucket and the whole event shares a single allowance; `app.ts` sets
 * `trust proxy` from it.
 *
 * Two things that keep the suites honest: under `NODE_ENV=test` every ceiling is raised to
 * at least 10,000 (the suites drive hundreds of requests through one in-process client —
 * they exercise invariants, not throttling), and `buildLimiters(opts)` lets the limiter's
 * own tests construct instances with small explicit ceilings and `testMode: false`.
 *
 * Every limiter has its own `express-rate-limit` store and `requestPropertyName`, so
 * stacking them on one request neither double-counts nor trips the library's
 * double-count validation. Rejections use the same JSON envelope as every other error.
 */
import { Request, RequestHandler } from 'express';
import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env';
import { isTrustedEgress, parseCidrList, trustedEgressCidrs } from '../common/streamLimits';
import type {} from '../common/types/account';

const MINUTE_MS = 60_000;

export interface LimiterOptions {
  /** Window for the per-account bucket (`RATE_LIMIT_WINDOW_MS`). The fixed per-minute buckets ignore it. */
  windowMs: number;
  /** Per-account ceiling for all requests (`RATE_LIMIT_MAX`). */
  accountMax: number;
  /** Per-account ceiling for POST/PATCH/PUT/DELETE, per minute. */
  mutationMax: number;
  /** Per-IP ceiling for anonymous requests, per minute. */
  anonymousMax: number;
  /** Per-IP ceiling for anonymous credential exchanges, per minute. */
  authExchangeMax: number;
  /** Per-IP sum ceiling over all anonymous traffic, per minute. */
  ipCeilingMax: number;
  /** CIDRs exempt from the credential and ceiling limiters. Defaults to `TRUSTED_EGRESS_CIDRS`. */
  trustedCidrs?: string[];
  /** Raise every ceiling to ≥ 10,000 (default: `NODE_ENV === 'test'`). */
  testMode: boolean;
}

export interface Limiters {
  accountLimiter: RateLimitRequestHandler;
  anonymousLimiter: RateLimitRequestHandler;
  authExchangeLimiter: RateLimitRequestHandler;
  mutationLimiter: RateLimitRequestHandler;
  ipCeilingLimiter: RateLimitRequestHandler;
  /** `req.account ? accountLimiter : anonymousLimiter` — the general API limiter. */
  apiRateLimiter: RequestHandler;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function ipOf(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function isMutation(req: Request): boolean {
  return MUTATING_METHODS.has(req.method);
}

export function buildLimiters(overrides: Partial<LimiterOptions> = {}): Limiters {
  const opts: LimiterOptions = {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    accountMax: env.RATE_LIMIT_MAX,
    mutationMax: 90,
    anonymousMax: 600,
    authExchangeMax: 30,
    ipCeilingMax: 3000,
    testMode: env.NODE_ENV === 'test',
    ...overrides,
  };

  // `Math.max` rather than a fixed value so an explicitly configured higher limit still wins.
  const ceiling = (max: number): number => (opts.testMode ? Math.max(max, 10_000) : max);
  const cidrs = opts.trustedCidrs ? parseCidrList(opts.trustedCidrs.join(',')) : trustedEgressCidrs();
  const trusted = (req: Request): boolean => isTrustedEgress(ipOf(req), cidrs);

  const envelope = (scope: string, windowMs: number) => ({
    success: false,
    error: 'TOO_MANY_REQUESTS',
    // Derived from the window rather than hardcoded: "after a minute" became a lie the
    // moment the window was made configurable.
    message: `Too many requests ${scope}. Try again in ${Math.ceil(windowMs / 1000)}s.`,
    statusCode: 429,
  });

  const common = { standardHeaders: true as const, legacyHeaders: false };

  const accountLimiter = rateLimit({
    ...common,
    windowMs: opts.windowMs,
    limit: ceiling(opts.accountMax),
    requestPropertyName: 'rateLimitAccount',
    keyGenerator: (req) => `acct:${req.account?.id}`,
    skip: (req) => !req.account,
    message: envelope('for this account', opts.windowMs),
  });

  const anonymousLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: ceiling(opts.anonymousMax),
    requestPropertyName: 'rateLimitAnonymous',
    keyGenerator: (req) => `ip:${ipOf(req)}`,
    skip: (req) => !!req.account,
    message: envelope('from this IP', MINUTE_MS),
  });

  // Trusted egress (the venue NAT) is where hundreds of people share one address — and also
  // where an attacker on venue Wi-Fi sits. So it never skips the credential limiter; it gets
  // a 10× allowance (300/min by default: ~5 sign-ins a second, far above any real doorway
  // rush, while still bounding brute force at 2^50 codes to ~7 million years).
  const authExchangeLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: (req) => ceiling(trusted(req) ? opts.authExchangeMax * 10 : opts.authExchangeMax),
    requestPropertyName: 'rateLimitAuthExchange',
    keyGenerator: (req) => `auth:${ipOf(req)}`,
    message: envelope('to sign in from this IP', MINUTE_MS),
  });

  const mutationLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: ceiling(opts.mutationMax),
    requestPropertyName: 'rateLimitMutation',
    keyGenerator: (req) => `mut:${req.account?.id}`,
    // Reads pass through; anonymous mutations pass through too — the identity middleware
    // rejects them in `required` mode, and in `legacy` mode they fall under the IP bucket.
    skip: (req) => !req.account || !isMutation(req),
    message: envelope('for this account (mutations)', MINUTE_MS),
  });

  // Same principle for the anonymous sum ceiling: trusted egress gets 10×, never unlimited.
  const ipCeilingLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: (req) => ceiling(trusted(req) ? opts.ipCeilingMax * 10 : opts.ipCeilingMax),
    requestPropertyName: 'rateLimitIpCeiling',
    keyGenerator: (req) => `ceil:${ipOf(req)}`,
    skip: (req) => !!req.account,
    message: envelope('from this IP', MINUTE_MS),
  });

  const apiRateLimiter: RequestHandler = (req, res, next) =>
    req.account ? accountLimiter(req, res, next) : anonymousLimiter(req, res, next);

  return { accountLimiter, anonymousLimiter, authExchangeLimiter, mutationLimiter, ipCeilingLimiter, apiRateLimiter };
}

const defaults = buildLimiters();

export const accountLimiter = defaults.accountLimiter;
export const anonymousLimiter = defaults.anonymousLimiter;
export const authExchangeLimiter = defaults.authExchangeLimiter;
export const mutationLimiter = defaults.mutationLimiter;
export const ipCeilingLimiter = defaults.ipCeilingLimiter;
export const apiRateLimiter = defaults.apiRateLimiter;
