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

export type AccountRole = 'VOLUNTEER' | 'SHIFT_LEAD' | 'ORGANIZER' | 'ADMIN' | 'HACKER';

export type IdentitySource = 'session' | 'legacy';

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
export const ORGANIZER_ROLES: ReadonlySet<AccountRole> = new Set(['ORGANIZER', 'ADMIN']);

export function isLeadOrAbove(account: AccountContext | undefined): boolean {
  return !!account && LEAD_ROLES.has(account.role);
}

export function isOrganizerOrAbove(account: AccountContext | undefined): boolean {
  return !!account && ORGANIZER_ROLES.has(account.role);
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
