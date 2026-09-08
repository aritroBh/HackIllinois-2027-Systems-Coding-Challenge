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
 * public content endpoint, public announcements and the plugin manifest — see
 * `ANONYMOUS_ALLOW` for the authoritative set) is a 401 before it reaches a router. The
 * allow-list only ever describes paths *under* `/api/v1`, because that is the only place
 * this middleware is mounted; `/health` and `/ready` sit at the server root and never pass
 * through it at all.
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

/**
 * Re-resolve an account's current role, kind and session version.
 *
 * Exported for long-lived connections, which are the one place the request-scoped identity
 * middleware cannot help: an SSE stream authorises itself once at connect and can then stay
 * open for hours. Reads through the same sixty-second cache as `attachIdentity`, so calling
 * it once per heartbeat per client costs nothing beyond the first miss.
 *
 * Returns null when the account no longer exists.
 */
export async function refreshAccountContext(
  accountId: string
): Promise<Omit<AccountContext, 'source'> | null> {
  return loadAccount(accountId, Date.now());
}

/**
 * Drop one account from the cache so a revocation on THIS instance is immediate.
 *
 * The sixty-second TTL is how long this process may keep believing a stale copy of an account,
 * and for the three writes that change what a session is allowed to do — logout and
 * `POST /auth/revoke/:id`, which bump `sessionVersion`, and `PATCH /auth/accounts/:id/role`,
 * which changes the role — a minute is too long to wait for a change the caller just asked
 * for. `auth.controller.ts` calls this straight after each of those writes, which closes the
 * window on the process that served the request. It does nothing for any other replica; there
 * the TTL is still the bound, and that is the deliberate limit of a per-process cache with no
 * invalidation channel.
 *
 * (This comment previously sat above `refreshAccountContext` instead, where it described
 * neither that function nor anything else.)
 */
export function evictAccountCache(accountId: string): void {
  accountCache.delete(accountId);
}

/** TTL-cached account read. A miss re-reads a narrow projection; a gone account evicts. */
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

/** Reads are GET, HEAD and OPTIONS; everything else is a mutation. */
function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/** Caller-claimed id from body or query. Believed in legacy mode only; never a credential. */
function legacyIdFrom(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  // Every body field that names the CALLER. (`targetVolunteerId` on a swap proposal names the
  // other party and is deliberately not here; on `accept` the controller derives the acceptor
  // from the session regardless.)
  const candidates = [body?.volunteerId, body?.proposerVolunteerId, req.query?.volunteerId, req.params?.volunteerId];
  for (const c of candidates) {
    if (typeof c === 'string' && OBJECT_ID_PATTERN.test(c)) return c.toLowerCase();
  }
  return undefined;
}

/**
 * Resolve the session account from a raw Cookie header — what the WebSocket upgrade
 * handler uses, since an upgrade never passes through Express middleware. Returns null
 * for anonymous, revoked or expired cookies; the `csrfNonceOk` callback lets the caller
 * verify the nonce it received out of band (the `Sec-WebSocket-Protocol` subprotocol).
 */
export async function resolveAccountFromCookies(
  cookieHeader: string | undefined,
  nowMs: number = Date.now()
): Promise<{ account: AccountContext; csrfNonceOk: (presented: string | undefined) => boolean } | null> {
  const cookies = parseCookies(cookieHeader);
  const names = cookieNames();
  const verification = verifySessionToken(cookies[names.session], nowMs);
  if (!verification.valid) return null;
  const ctx = await loadAccount(verification.payload.sub, nowMs);
  if (!ctx || ctx.sessionVersion !== verification.payload.sv) return null;
  return {
    account: { ...ctx, source: 'session' },
    csrfNonceOk: (presented) => csrfNonceMatches(presented, ctx.id, ctx.sessionVersion),
  };
}

/**
 * Establish who is calling, and how well they proved it. Everything downstream reads the
 * answer off `req.account`; nothing downstream re-reads a cookie.
 *
 * It almost never rejects. Three of the four outcomes are "carry on": a good cookie sets
 * `req.account` with `source: 'session'`, a cookie whose `sv` no longer matches the account's
 * `sessionVersion` (revoked, or the account is gone) falls through as anonymous, and an
 * absent cookie in `legacy` mode may still pick up a claimed identity from a
 * caller-identifying field on the request. Refusing a stale cookie here would be the wrong
 * layer: `enforceAuthMode` decides whether anonymous is acceptable for this path, and it has
 * the allow-list to decide that with.
 *
 * The one rejection is the impersonation guard, and it is narrower than it looks. In
 * `required` mode, a request that carries a valid session *and* names a different account in
 * a caller-identifying field is a 403 rather than being silently reinterpreted — the point is
 * that a client which still speaks the legacy protocol finds out, instead of quietly acting
 * as the session while its body says otherwise. Lead-or-above is exempt from the 403, which
 * is not a delegation grant: `resolveActorId` returns the session's own id regardless of what
 * the body says, so an exempt lead does not act as the named account either. Real delegation
 * is `resolveOnBehalf`, which needs its own dedicated field.
 *
 * **`csrfVerified` is computed here, and only for mutations.** It is a boolean, not a
 * rejection: this middleware records whether the nonce matched and `requireCsrf` — mounted
 * later, so that the rate limiters get their cheap rejection in first — decides what to do
 * about it. On a read the property is left undefined, which is why nothing may treat
 * `csrfVerified === false` as "this was a failed CSRF check" without also knowing the method.
 *
 * The account read goes through a sixty-second cache, so the common authenticated request
 * costs a cookie parse, an HMAC verification and a map lookup. That is what makes it
 * affordable to mount this ahead of the rate limiters on every `/api/v1` request.
 */
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
  'GET /auth/dev-accounts', // registered only outside production (auth.routes)
  'POST /auth/claim',
  'POST /auth/magic-link',
  'POST /auth/magic',
  'POST /auth/adonix',
  'POST /auth/dev-login',
  // Bootstrap: printing the first badge codes happens before anyone has a session. The
  // route itself demands the organiser secret (checked regardless of mode).
  'POST /auth/claim-codes',
  'POST /auth/claim-codes/bulk',
  'GET /content',
  'GET /announcements', // the login screen shows public notices before anyone signs in
  // The client plugin loader fetches the manifest as the shell boots, which in `required`
  // mode is before a session exists. A 401 there is silent: the loader treats an unreachable
  // manifest as "this deployment has no plugins" and carries on, so a plugin would simply
  // never appear. The manifest is a list of names, versions and digests of files the server
  // already serves to anyone who asks, so there is nothing in it to protect.
  'GET /plugins',
]);

/**
 * Membership test for `ANONYMOUS_ALLOW`, exact-matched on `METHOD path`.
 *
 * Exact, not prefix: a path is either written out above or it is not allowed, so nobody can
 * widen the hole by mounting a new route under an allowed prefix. The only normalisation is a
 * trailing slash, because `/content` and `/content/` are the same route to Express and would
 * otherwise be two different answers here.
 *
 * `path` is `req.path`, which excludes the query string — the set is therefore compared
 * against the route and never against caller-supplied values.
 */
export function isAnonymousAllowed(method: string, path: string): boolean {
  // Only CORS preflight is exempt. HEAD is served by GET handlers, so it must be gated like GET.
  if (method === 'OPTIONS') return true;
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

/**
 * There has to be *somebody* — the weakest gate in this file, and the one most often chosen
 * by mistake.
 *
 * It asks whether `req.account` is set, not how it got set, so in `legacy` mode a
 * `?volunteerId=<public id>` satisfies it. That is the right question for an action the open
 * demo is meant to allow anonymously, and the wrong question for anything that reveals data
 * about the named account: account ids are handed out by the leaderboard, so "any account"
 * there means "anyone at all, acting as whoever they name". Nine separate sites were fixed
 * for exactly that across four review rounds — see `isProvenSession` in `common/types/account.ts`
 * for the rule and `me.routes.ts` for the fixes. If the handler behind this discloses
 * something, you want `requireSession` instead.
 *
 * Routes that use both put `requireSession` first, so the failure a caller sees names the
 * missing session rather than the missing account.
 */
export function requireAccount(req: Request, _res: Response, next: NextFunction): void {
  if (!req.account) {
    next(ApiError.unauthorized('Sign in to use this endpoint.'));
    return;
  }
  next();
}

/**
 * A real, proven session — not a legacy claim.
 *
 * `legacy` mode lets a caller assert an identity with a body/query `volunteerId`, which is
 * fine for the open demo's game actions but must never unlock privacy-sensitive reads: a
 * stranger could otherwise name a lead's id and read everyone's exact position. Routes that
 * disclose somebody else's location or moderate other people's content use this instead of
 * `requireAccount`, so they behave identically in both modes.
 */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (req.account?.source === 'session') {
    next();
    return;
  }
  next(ApiError.unauthorized('This endpoint needs a signed-in session, not a claimed identity.'));
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
 *
 * Deliberately NOT the place for act-on-behalf. Six controllers call this — registration,
 * check-in, SOS resolution, gym battles, HackStop spins and swaps — so honouring a body id
 * for leads here would let a shift lead spin another player's HackStop, resolve an SOS as
 * them and take the bounty, or bank their karma on checkout. Delegation is opt-in per route
 * instead: see `resolveOnBehalf`.
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

/**
 * Explicit act-on-behalf, honoured **only** by the routes that opt in (today: registration
 * reserve and cancel — the roster desk signing someone up at the table, and the Chaos Lab
 * driving many actors at once).
 *
 * Three conditions, all required: the caller holds a real session (a legacy-claimed
 * identity may never delegate), that session is lead-or-above, and the request names the
 * subject in the dedicated `onBehalfVolunteerId` field rather than in the ordinary
 * `volunteerId` slot — so a delegated call is always visibly different from a self call.
 * Every use is logged. Returns null when the request is not a delegation.
 */
export function resolveOnBehalf(req: Request): { subjectId: string; delegatedBy: string } | null {
  const account = req.account;
  if (!account || account.source !== 'session') return null;
  if (!LEAD_ROLES.has(account.role)) return null;
  const body = req.body as Record<string, unknown> | undefined;
  const named = body?.onBehalfVolunteerId;
  if (typeof named !== 'string' || !OBJECT_ID_PATTERN.test(named)) return null;
  // Case-insensitively: an ObjectId hex string compares equal to itself in either case, and
  // a lead who typed their own id with capitals would otherwise be logged as delegating to
  // themselves and take the on-behalf path for a self call.
  if (named.toLowerCase() === account.id.toLowerCase()) return null;
  console.info(`[on-behalf] ${account.role} ${account.id} acting for ${named} on ${req.method} ${req.originalUrl}`);
  return { subjectId: named, delegatedBy: account.id };
}
