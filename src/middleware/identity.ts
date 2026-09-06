/**
 * Identity middleware — who is calling, and are they allowed to?
 *
 * `attachIdentity` runs on every `/api/v1` request. It verifies the session cookie, loads
 * the account through a 60-second cache (so revocation via `sessionVersion` lands within a
 * minute without a database read per request), and puts an `AccountContext` on
 * `req.account`. In `AUTH_MODE=legacy` a caller-supplied `volunteerId` (body, then query)
 * is accepted as a *legacy* identity so the zero-setup demo and the original test suite
 * keep working; that fallback never applies in `required` mode, where a body id that
 * names someone other than the session is a 403.
 *
 * `enforceAuthMode` is the gate that makes `required` mean something: any anonymous
 * request outside a short allow-list (the credential exchanges, the provider list, the
 * public content endpoint, health) is a 401 before it reaches a router.
 *
 * CSRF: cookie-authenticated mutations must echo the CSRF nonce in `X-CSRF-Token`. The
 * nonce is derived from (account, sessionVersion), so it is recomputed here rather than
 * stored. Legacy identities carry no cookie and therefore no CSRF exposure; anonymous
 * credential exchanges are exempt by construction (no session yet).
 */
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { Volunteer, AccountKind } from '../models/volunteer.model';
import { OBJECT_ID_PATTERN } from '../schemas/common';
import { AccountContext, AccountRole, LEAD_ROLES, ORGANIZER_ROLES } from '../common/types/account';
import { verifySessionToken, cookieNames, parseCookies, csrfNonceMatches } from '../common/utils/sessionToken';

const ACCOUNT_CACHE_TTL_MS = 60_000;

interface CachedAccount {
  ctx: Omit<AccountContext, 'source'>;
  fetchedAt: number;
}

const accountCache = new Map<string, CachedAccount>();

/** Test hook — the cache would otherwise hide a `sessionVersion` bump for up to 60 s. */
export function __clearAccountCache(): void {
  accountCache.clear();
}

async function loadAccount(id: string, nowMs: number): Promise<Omit<AccountContext, 'source'> | null> {
  const cached = accountCache.get(id);
  if (cached && nowMs - cached.fetchedAt < ACCOUNT_CACHE_TTL_MS) return cached.ctx;
  const doc = await Volunteer.findById(id).select('kind role faction name sessionVersion').lean();
  if (!doc) {
    accountCache.delete(id);
    return null;
  }
  const ctx: Omit<AccountContext, 'source'> = {
    id: String(doc._id),
    kind: (doc.kind ?? AccountKind.VOLUNTEER) as AccountContext['kind'],
    role: doc.role as AccountRole,
    faction: doc.faction ?? null,
    displayName: doc.name,
    sessionVersion: doc.sessionVersion ?? 0,
  };
  accountCache.set(id, { ctx, fetchedAt: nowMs });
  return ctx;
}

function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function legacyIdFrom(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const candidates = [body?.volunteerId, req.query?.volunteerId, req.params?.volunteerId];
  for (const c of candidates) {
    if (typeof c === 'string' && OBJECT_ID_PATTERN.test(c)) return c.toLowerCase();
  }
  return undefined;
}

export async function attachIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const now = Date.now();
    const cookies = parseCookies(req.headers.cookie);
    const names = cookieNames();
    const verification = verifySessionToken(cookies[names.session], now);

    if (verification.valid) {
      const ctx = await loadAccount(verification.payload.sub, now);
      if (ctx && ctx.sessionVersion === verification.payload.sv) {
        req.account = { ...ctx, source: 'session' };
        if (isMutation(req.method)) {
          const presented = req.headers['x-csrf-token'];
          req.csrfVerified = csrfNonceMatches(typeof presented === 'string' ? presented : undefined, ctx.id, ctx.sessionVersion);
        }
        // A body id naming someone else is the impersonation the session exists to stop.
        const legacyId = legacyIdFrom(req);
        if (env.AUTH_MODE === 'required' && legacyId && legacyId !== ctx.id && !LEAD_ROLES.has(ctx.role)) {
          next(new ApiError(403, ErrorCode.IDENTITY_MISMATCH, 'This request names a different account than your session.'));
          return;
        }
        next();
        return;
      }
      // Revoked or deleted: fall through as anonymous.
    }

    if (env.AUTH_MODE === 'legacy') {
      const legacyId = legacyIdFrom(req);
      if (legacyId) {
        const ctx = await loadAccount(legacyId, now);
        if (ctx) req.account = { ...ctx, source: 'legacy' };
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Anonymous requests that must work before a session exists. Paths are relative to /api/v1. */
const ANONYMOUS_ALLOW = new Set<string>([
  'GET /auth/providers',
  'POST /auth/claim',
  'POST /auth/magic-link',
  'POST /auth/magic',
  'POST /auth/adonix',
  'POST /auth/dev-login',
  'GET /content',
]);

export function isAnonymousAllowed(method: string, path: string): boolean {
  if (method === 'OPTIONS' || method === 'HEAD') return true;
  const clean = path.replace(/\/+$/, '') || '/';
  return ANONYMOUS_ALLOW.has(`${method} ${clean}`);
}

/** In `required` mode, anonymous requests outside the allow-list stop here with a 401. */
export function enforceAuthMode(req: Request, _res: Response, next: NextFunction): void {
  if (env.AUTH_MODE !== 'required' || req.account) {
    next();
    return;
  }
  if (isAnonymousAllowed(req.method, req.path)) {
    next();
    return;
  }
  next(ApiError.unauthorized('Sign in to use this endpoint.'));
}

/** Cookie-authenticated mutations must carry the CSRF nonce. Legacy and anonymous requests are unaffected. */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (!isMutation(req.method) || !req.account || req.account.source !== 'session') {
    next();
    return;
  }
  if (!req.csrfVerified) {
    next(new ApiError(403, ErrorCode.CSRF_INVALID, 'Missing or invalid X-CSRF-Token.'));
    return;
  }
  next();
}

export function requireAccount(req: Request, _res: Response, next: NextFunction): void {
  if (!req.account) {
    next(ApiError.unauthorized('Sign in to use this endpoint.'));
    return;
  }
  next();
}

/**
 * Lead/organiser gate. ORGANIZER and ADMIN satisfy every check; asking for SHIFT_LEAD
 * accepts any lead-or-above role. Like `requireVolunteerKind`, an anonymous request in
 * `legacy` mode passes (open demo); in `required` mode `enforceAuthMode` has already
 * turned it into a 401 before this runs.
 */
export function requireRole(...roles: AccountRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.account) {
      if (env.AUTH_MODE === 'legacy') {
        next();
        return;
      }
      next(ApiError.unauthorized('Sign in to use this endpoint.'));
      return;
    }
    const role = req.account.role;
    const ok = ORGANIZER_ROLES.has(role) || roles.includes(role) || (roles.includes('SHIFT_LEAD') && LEAD_ROLES.has(role));
    if (!ok) {
      next(new ApiError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'Your role does not allow this.'));
      return;
    }
    next();
  };
}

/**
 * Staff-only routes (shifts, check-in, swaps, SOS resolution). In `legacy` mode an
 * anonymous request passes — that is the open-demo contract — but a signed-in hacker is
 * still refused in either mode: the kind check is about who you are, not how you proved it.
 */
export function requireVolunteerKind(req: Request, _res: Response, next: NextFunction): void {
  if (!req.account) {
    if (env.AUTH_MODE === 'legacy') {
      next();
      return;
    }
    next(ApiError.unauthorized('Sign in to use this endpoint.'));
    return;
  }
  if (req.account.kind !== 'VOLUNTEER') {
    next(new ApiError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'This is a volunteer-only action.'));
    return;
  }
  next();
}

/**
 * The actor a controller should act as. Session (or legacy) identity first; the body field
 * only as a legacy fallback, so that in `required` mode nothing ever acts on a body id.
 */
export function resolveActorId(req: Request, bodyField = 'volunteerId'): string | undefined {
  if (req.account) return req.account.id;
  if (env.AUTH_MODE === 'legacy') {
    const body = req.body as Record<string, unknown> | undefined;
    const v = body?.[bodyField] ?? req.query?.[bodyField];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}
