/**
 * The authenticated caller, as seen by every layer above the identity middleware.
 *
 * `AccountContext` is what `attachIdentity` (src/middleware/identity.ts) puts on
 * `req.account` after verifying the session cookie. Everything that used to read a
 * caller-supplied `volunteerId` from the body reads this instead; the body field is only
 * consulted as a legacy fallback while `AUTH_MODE=legacy`.
 *
 * The shape is deliberately tiny and denormalised (kind, role, faction are copied from
 * the account document at request time) so that services, the SSE hub, the presence
 * layer and the rate limiter can all make authorisation decisions without another
 * database read.
 *
 *   kind  — VOLUNTEER or HACKER. The only axis for "is this a staff member" checks
 *           (shifts, check-in, swaps, SOS resolve, rosters are volunteer-only).
 *   role  — VOLUNTEER | SHIFT_LEAD | ORGANIZER | ADMIN for volunteers, HACKER for hackers
 *           (the model enforces `kind === 'HACKER' ⇔ role === 'HACKER'`). Lead/organiser
 *           gates read this.
 *   source — how the identity was established. `legacy` means the id came from the request
 *           body in `AUTH_MODE=legacy` and must not be trusted for anything a session would
 *           protect; it exists so the existing demo/test paths keep working unchanged.
 */
export type AccountKind = 'VOLUNTEER' | 'HACKER';

/** What the account may do; `LEAD_ROLES` below is the set that counts as a lead. */
export type AccountRole = 'VOLUNTEER' | 'SHIFT_LEAD' | 'ORGANIZER' | 'ADMIN' | 'HACKER';

/** How the identity was established: a signed session, or a body-supplied id in legacy mode. */
export type IdentitySource = 'session' | 'legacy';

/** The resolved caller every gate reads: who, what they may do, and how proved. */
export interface AccountContext {
  id: string;
  kind: AccountKind;
  role: AccountRole;
  faction: string | null;
  displayName: string;
  /** Session version the cookie was minted for; compared against the account's current value. */
  sessionVersion: number;
  source: IdentitySource;
}

/** Roles that satisfy a "lead or above" check. ORGANIZER and ADMIN satisfy every check. */
export const LEAD_ROLES: ReadonlySet<AccountRole> = new Set(['SHIFT_LEAD', 'ORGANIZER', 'ADMIN']);
/** The narrower ring: minting claim codes, changing a role, anything that creates authority rather than exercising it. */
export const ORGANIZER_ROLES: ReadonlySet<AccountRole> = new Set(['ORGANIZER', 'ADMIN']);

/**
 * "Does this caller *say* they are a lead?"
 *
 * The right question for an action and the wrong one for a disclosure — in `AUTH_MODE=legacy`
 * the role behind this comes from a `?volunteerId=` the caller chose, and account ids are
 * public. Use `isProvenLead` below for anything that reveals data. This one stays because the
 * open-demo contract is that a claimed id may act, and because in `AUTH_MODE=required` there
 * is no other kind of identity.
 *
 * Undefined is false: an anonymous caller is not a lead. Written as a set membership rather
 * than a comparison ladder so that adding a role above SHIFT_LEAD is one edit rather than a
 * search for every `role === 'ORGANIZER' || role === 'ADMIN'` in the tree — which is how the
 * nine sites in the note below came to disagree with each other.
 */
export function isLeadOrAbove(account: AccountContext | undefined): boolean {
  return !!account && LEAD_ROLES.has(account.role);
}

/** The same claimed-identity caveat applies. Organiser or admin; SHIFT_LEAD is deliberately not enough. */
export function isOrganizerOrAbove(account: AccountContext | undefined): boolean {
  return !!account && ORGANIZER_ROLES.has(account.role);
}

/**
 * The same checks, for **disclosure** decisions, where a claimed identity is not enough.
 *
 * `isLeadOrAbove` and a bare `kind === 'VOLUNTEER'` answer "what does this caller say they
 * are". That is the right question for an *action* — `AUTH_MODE=legacy` is a documented open
 * demo and believing a claimed id for a write is the contract. It is the wrong question for a
 * *read*, because in `legacy` the id comes from the query string and `GET /volunteers` and the
 * leaderboard hand account ids to anonymous callers. Naming a lead's public id is therefore
 * one string away from being treated as that lead.
 *
 * Nine separate sites got this wrong, in four different review rounds, each fixed on its own
 * and each time leaving siblings that read the same way. They live here now so the next one is
 * a call to a named function rather than a fresh `/SHIFT_LEAD|ORGANIZER/.test(...)`.
 *
 * The rule, stated once: **an action may believe a claimed identity; a disclosure may not.**
 * If what you are about to do reveals something the caller could not otherwise see, use these.
 */
export function isProvenSession(account: AccountContext | undefined): boolean {
  return account?.source === 'session';
}

/** Lead-or-above **and** proved it. For anything that discloses somebody else's data. */
export function isProvenLead(account: AccountContext | undefined): boolean {
  return isProvenSession(account) && isLeadOrAbove(account);
}

/** Staff kind **and** proved it. The roster/registration line, for disclosure. */
export function isProvenKind(account: AccountContext | undefined, kind: AccountKind): boolean {
  return isProvenSession(account) && account?.kind === kind;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `attachIdentity`; absent when the request is anonymous. */
      account?: AccountContext;
      /** Set by `attachIdentity` when the CSRF nonce on the request matched the session. */
      csrfVerified?: boolean;
    }
  }
}
