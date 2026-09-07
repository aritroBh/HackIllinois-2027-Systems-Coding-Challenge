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
 *      → 30/min/IP. Bounds brute force on 50-bit claim codes. `auth.routes.ts` mounts
 *      `authExchangeLimiter` per route — on those three, on `/auth/dev-login`, and on the
 *      two claim-code issuance routes, which take the organiser secret instead.
 *  (c) **Anonymous everything else** → 600/min/IP (`anonymousLimiter`). In `legacy` mode
 *      this is what the open dashboard reads use; in `required` mode only `ANONYMOUS_ALLOW`
 *      (`/auth/providers`, `/content`, `/announcements`, `/plugins`) gets past the gate
 *      behind it, though note the limiter runs *before* `enforceAuthMode`, so a request the
 *      gate is about to 401 is counted here first.
 *  (d) **IP ceiling**, 3,000/min over anonymous traffic only (`ipCeilingLimiter`) — the
 *      sum of (b)+(c) from one address. An anti-abuse stop, not a capacity control.
 *
 * What is deliberately outside all four: every limiter here is mounted on `/api/v1` in
 * `app.ts`, so nothing at the server root passes through one. `/health`, `/ready`, the
 * dashboard's static assets and Swagger UI are unlimited by this file — which is the point
 * for the static assets (they must not spend an account's budget) and simply a known gap for
 * the two probes. `GET /api/v1/stats/events` is mounted ahead of the stack for the same
 * reason and is bounded instead by the stream-slot table in `common/streamLimits.ts`.
 *
 * Addresses in `TRUSTED_EGRESS_CIDRS` (the venue's egress ranges) get a 10× allowance on
 * **two of the three per-IP limiters built here** — `authExchangeLimiter` and
 * `ipCeilingLimiter` — and never an exemption. The venue is the one place a shared address is
 * legitimately hot, but it is also where an attacker on the Wi-Fi sits.
 *
 * `anonymousLimiter` is keyed per IP as well (`ip:${ipOf(req)}`) and is deliberately *not*
 * widened: a venue NAT address gets the same 600/min for anonymous reads that anyone else
 * does. That is the whole reason this sentence has to name the limiters instead of saying
 * "the per-IP limiters".
 *
 * And the 10×-never-an-exemption rule stops at this file's edge: the stream-slot table in
 * `common/streamLimits.ts` reads the same list and *skips* its PER_IP ceiling outright for a
 * trusted address. `src/config/env.ts` enumerates all three consumers next to the variable.
 *
 * This sentence has now been wrong three times, which is worth more than the sentence itself.
 * It said the ceilings "do not apply" (no per-IP limit at all — false). The correction said
 * "the two per-IP limiters that consult them", which undercounted the consumers by missing the
 * stream table. The correction to *that* said "the per-IP limiters *in this file*" — which
 * fixed the cross-file half and broke the local half, because this file builds three per-IP
 * limiters and only two of them are widened. Every version was written carefully and read as
 * authoritative. **Enumerate; do not quantify.** Naming `authExchangeLimiter` and
 * `ipCeilingLimiter` is checkable in a way that "the two" and "the per-IP limiters" are not.
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

/**
 * Every tunable in one shape, so that the limiters the process uses and the limiters the
 * tests use differ only in these numbers.
 *
 * Note how little of this an operator can actually reach: `windowMs` and `accountMax` come
 * from `RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX` and `trustedCidrs` from `TRUSTED_EGRESS_CIDRS`,
 * but the other four ceilings are literals inside `buildLimiters` with no environment variable
 * behind them. That is deliberate — they are anti-abuse stops rather than capacity knobs to be
 * turned at three in the morning — and it is also why they are on this interface at all: the
 * override path exists so the tests can drive them, not so a deployment can.
 */
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
  /** CIDRs given a 10× allowance on the credential and ceiling limiters, never an exemption. Defaults to `TRUSTED_EGRESS_CIDRS`. */
  trustedCidrs?: string[];
  /** Raise every ceiling to ≥ 10,000 (default: `NODE_ENV === 'test'`). */
  testMode: boolean;
}

/**
 * One built set. They are returned together rather than individually because they only make
 * sense stacked: `ipCeilingLimiter` is the sum bound over what `anonymousLimiter` and
 * `authExchangeLimiter` each count separately, and `mutationLimiter` is a second, tighter
 * budget that a request already counted by `accountLimiter` also has to fit inside.
 */
export interface Limiters {
  accountLimiter: RateLimitRequestHandler;
  anonymousLimiter: RateLimitRequestHandler;
  authExchangeLimiter: RateLimitRequestHandler;
  mutationLimiter: RateLimitRequestHandler;
  ipCeilingLimiter: RateLimitRequestHandler;
  /** A proved session gets `accountLimiter`; everything else, including a legacy-claimed identity, gets `anonymousLimiter`. */
  apiRateLimiter: RequestHandler;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function ipOf(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * A *proved* identity — a session cookie this server minted — not a claimed one.
 *
 * The per-account buckets and the per-IP skips exist because a signed-in caller has already
 * been rationed by the credential that got them in. That reasoning does not survive `legacy`
 * mode, where `attachIdentity` believes a `volunteerId` in the body or query: an account id
 * is not a credential, it is a public string handed out by `GET /volunteers` and the
 * leaderboard.
 *
 * Keyed on `req.account` alone, an attacker rotated public ids and got a fresh 300/min
 * account bucket for each while the per-IP ceiling — the anti-abuse stop that exists for
 * exactly this — skipped them for having an "account". N ids bought N × 300/min from one
 * address with no credential at all. A claimed identity is now treated as anonymous by the
 * limiters, which is what it is.
 */
function isProvenSession(req: Request): boolean {
  return req.account?.source === 'session';
}

/**
 * Wrapped rather than passed by reference at each call site below.
 *
 * `express-rate-limit` treats the *same function instance* appearing as `skip` on more than
 * one limiter as a configuration to be validated, and the limiter then silently stops
 * applying — no headers, no counting. Handing each limiter its own closure is one character
 * of noise and the difference between a rate limiter and a decoration.
 */
const skipProvenSession = () => (req: Request): boolean => isProvenSession(req);

function isMutation(req: Request): boolean {
  return MUTATING_METHODS.has(req.method);
}

/**
 * Construct a fresh, independent set of limiters.
 *
 * Fresh matters more than it sounds: each `rateLimit()` call allocates its own in-memory
 * store, so two sets built here share no counters. That is what lets the limiter's own tests
 * run tiny ceilings without the singletons below — or one test file — leaking counts into the
 * next. It is also why the singletons are built exactly once, at the bottom of this module:
 * calling this per request would hand every caller an empty bucket.
 *
 * `overrides` exists for those tests, and `testMode: false` is the one that has to be passed
 * explicitly: it defaults to `NODE_ENV === 'test'`, under which every ceiling is floored at
 * 10,000, so a test that expects a 429 would never see one.
 */
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
    skip: (req) => !isProvenSession(req),
    message: envelope('for this account', opts.windowMs),
  });

  const anonymousLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: ceiling(opts.anonymousMax),
    requestPropertyName: 'rateLimitAnonymous',
    keyGenerator: (req) => `ip:${ipOf(req)}`,
    skip: skipProvenSession(),
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
    // A legacy-claimed identity counts as anonymous here for the same reason it does above:
    // otherwise naming a different id each time buys a fresh mutation budget each time.
    skip: (req) => !isProvenSession(req) || !isMutation(req),
    message: envelope('for this account (mutations)', MINUTE_MS),
  });

  // Same principle for the anonymous sum ceiling: trusted egress gets 10×, never unlimited.
  const ipCeilingLimiter = rateLimit({
    ...common,
    windowMs: MINUTE_MS,
    limit: (req) => ceiling(trusted(req) ? opts.ipCeilingMax * 10 : opts.ipCeilingMax),
    requestPropertyName: 'rateLimitIpCeiling',
    keyGenerator: (req) => `ceil:${ipOf(req)}`,
    skip: skipProvenSession(),
    message: envelope('from this IP', MINUTE_MS),
  });

  const apiRateLimiter: RequestHandler = (req, res, next) =>
    isProvenSession(req) ? accountLimiter(req, res, next) : anonymousLimiter(req, res, next);

  return { accountLimiter, anonymousLimiter, authExchangeLimiter, mutationLimiter, ipCeilingLimiter, apiRateLimiter };
}

/**
 * The process-wide set, built once at import from `env`. Every counter the running server
 * keeps lives in these six objects; importing this module anywhere gets the same buckets,
 * which is the whole point.
 */
const defaults = buildLimiters();

/** The 300/min account bucket. Not mounted anywhere directly — `apiRateLimiter` dispatches to it. */
export const accountLimiter = defaults.accountLimiter;
/** The 600/min per-IP bucket. Likewise reached only through `apiRateLimiter`. */
export const anonymousLimiter = defaults.anonymousLimiter;
/** 30/min/IP on the routes that take a credential — mounted per route in `auth.routes.ts`. */
export const authExchangeLimiter = defaults.authExchangeLimiter;
/** The tighter 90/min write budget, stacked on `/api/v1` after `apiRateLimiter`. */
export const mutationLimiter = defaults.mutationLimiter;
/** The 3,000/min anonymous sum ceiling, first in the `/api/v1` stack so it rejects cheapest. */
export const ipCeilingLimiter = defaults.ipCeilingLimiter;
/** The dispatcher `app.ts` actually mounts: proved session to the account bucket, everyone else to the IP bucket. */
export const apiRateLimiter = defaults.apiRateLimiter;
