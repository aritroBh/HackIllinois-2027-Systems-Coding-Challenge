/**
 * Identity: one session, three ways in.
 *
 * Every adapter — badge claim code, email magic link, Adonix — returns a `Volunteer`
 * document and nothing else. `setSessionCookies` below is what turns one into the HttpOnly
 * session cookie and the JS-readable CSRF cookie, and `auth.controller.ts` calls it on every
 * successful exchange. An earlier version of this paragraph named a `mintSession` that does
 * not exist anywhere in the repository; the mint itself is `mintSessionToken` in
 * `common/utils/sessionToken`. Nothing else in the system knows which adapter a person used;
 * controllers only ever see `req.account`.
 *
 * Accounts are `Volunteer` documents with a `kind` (VOLUNTEER | HACKER). Hackers are
 * created on first Adonix login (or via an organiser import) and hold no shifts; the
 * `kind ⇔ role` invariant on the model keeps the two ladders coherent.
 *
 * Failure counting for claim codes is an in-process sliding window: fifty failed claims in
 * an hour raises `CLAIM_BRUTE_FORCE` once per hour. That event goes to the `ops` channel and
 * not, as an earlier version of this sentence said, to `announce` — `announce` is readable
 * anonymously, and an alarm that tells you somebody is guessing badge codes is exactly the
 * thing you do not publish to the people guessing. The per-IP limiter on the route is the
 * hard bound; this is only the alarm that tells a lead to look.
 */
import crypto from 'crypto';
import { Response } from 'express';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import {
  Volunteer,
  IVolunteer,
  AccountKind,
  VolunteerRole,
  IdentityProvider,
} from '../models/volunteer.model';
import { ClaimCode } from '../models/claimCode.model';
import { AuthToken } from '../models/authToken.model';
import {
  mintSessionToken,
  csrfNonceFor,
  cookieNames,
  sessionCookieOptions,
  csrfCookieOptions,
} from '../common/utils/sessionToken';
import { getMailer, magicLinkEnabled } from '../auth/mailer';
import { verifyAdonixToken, mapAdonixRoles, adonixEnabled, adonixStartUrl } from '../auth/adonix';

/** Crockford base32 — no I, L, O, U, so codes survive handwriting and bad printers. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * Ten Crockford characters, so fifty bits of entropy. The brute-force arithmetic that
 * number has to survive — and the reason there is no per-code attempt counter to go with it
 * — is in `claimCode.model.ts`.
 */
export const CLAIM_CODE_LENGTH = 10;

/**
 * What an account looks like from outside this file: the shape returned by every credential
 * exchange, by `GET /me`, and by a role change.
 *
 * It is an allow-list, and that is the point of it. `IVolunteer` also carries `identities`,
 * `phone`, `sessionVersion`, `streak`, `reliability`, `certifications` and `lastGymKarmaAt`,
 * none of which appear here — so a field added to the model later is not published by
 * accident, which is the failure mode a deny-list has and this does not.
 *
 * `email` is in the shape but is not always populated on the way out: `GET /me` nulls it for
 * a caller whose identity was claimed rather than proved, because in `legacy` mode an
 * account id is public and the route would otherwise be an address book. The reasoning is at
 * that route, in `me.routes.ts`.
 */
export interface PublicAccount {
  id: string;
  kind: AccountKind;
  role: VolunteerRole;
  displayName: string;
  email: string | null;
  faction: string | null;
  karmaPoints: number;
  hoursServed: number;
  prestigeTier: string;
  badges: string[];
  avatarHash: string | null;
  presenceOptIn: boolean;
}

/**
 * One row of the login screen.
 *
 * A provider that cannot work on this deployment is still listed, with `enabled: false`,
 * rather than being omitted — so the set of ids a client sees is the same everywhere and
 * "this build has no such adapter" is distinguishable from "this host has no SMTP".
 * `startUrl` is present only for Adonix, and only while it is enabled, because it is the
 * one provider whose flow begins somewhere other than this API.
 */
export interface ProviderInfo {
  id: 'claim' | 'magic' | 'adonix' | 'dev';
  enabled: boolean;
  label: string;
  startUrl?: string;
}

/**
 * Claim codes and magic-link tokens are stored as this and never in the clear.
 *
 * A bare unsalted SHA-256 rather than a password KDF, deliberately. The inputs are fifty
 * bits of `randomBytes` and a 256-bit `randomBytes` token, so there is no dictionary to
 * stretch against; and the lookup is *by* the digest — `findOneAndUpdate({ codeHash })` —
 * which a per-row salt would turn into a collection scan. What it buys is the property
 * `claimCode.model.ts` states: a leaked database yields nothing that can be typed into the
 * login screen.
 */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * The tolerant reader for a code somebody is typing off a badge.
 *
 * Crockford base32 leaves out I, L, O and U so that they can be folded back in on input: a
 * person who reads a printed `0` as `O`, or a `1` as `l`, gets the code they meant rather
 * than a rejection they have no way to debug. Case, dashes and spaces go the same way.
 *
 * This is not the inverse of `generateClaimCode`, and that asymmetry is what makes the fold
 * safe. No generated code contains any of those four characters, so folding them can only
 * ever turn a mistyped character into the one that was printed — it can never turn one valid
 * code into a different valid code.
 */
export function normaliseClaimCode(raw: string): string {
  // Accept what humans type: lowercase, dashes/spaces, and the letters Crockford excludes.
  return raw
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/**
 * Uniform over the alphabet, which `% 32` is only because `CROCKFORD` is exactly 32
 * characters long and a byte has exactly 256 values: eight byte values per symbol, no
 * remainder, no bias. The same line against a 33-character alphabet would quietly favour the
 * symbols at the start of the string. The length of that constant is load-bearing rather
 * than decorative.
 */
export function generateClaimCode(): string {
  const bytes = crypto.randomBytes(CLAIM_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/**
 * Core authentication service handling credential exchange, magic link verification, session cookies, and token management.
 */
export class AuthService {
  private static claimFailures: number[] = [];
  private static lastBruteForceAlarmAt = 0;

  /** Projects an account onto `PublicAccount`; what is left out, and why, is documented there. */
  public static toPublicAccount(doc: IVolunteer): PublicAccount {
    return {
      id: doc.id,
      kind: doc.kind,
      role: doc.role,
      displayName: doc.name,
      email: doc.email ?? null,
      faction: doc.faction ?? null,
      karmaPoints: doc.karmaPoints,
      hoursServed: doc.hoursServed,
      prestigeTier: doc.prestigeTier,
      badges: doc.badges,
      avatarHash: doc.avatarHash ?? null,
      presenceOptIn: doc.presenceOptIn,
    };
  }

  /**
   * What the login screen may offer on this deployment.
   *
   * The `dev` entry is the one to be careful with, because whether it works is decided in
   * three places that have to agree: this flag, the `if (env.NODE_ENV !== 'production')` in
   * `auth.routes.ts` that decides whether the handler is registered at all, and the guard at
   * the top of `devLogin`. The route not existing is the real control. This flag only stops
   * a client drawing a button, and `devLogin`'s own check is what keeps it safe if the route
   * is ever mounted by mistake.
   */
  public static providers(): { mode: 'legacy' | 'required'; providers: ProviderInfo[] } {
    return {
      mode: env.AUTH_MODE,
      providers: [
        { id: 'claim', enabled: true, label: 'Badge code' },
        { id: 'magic', enabled: magicLinkEnabled(), label: 'Email me a link' },
        { id: 'adonix', enabled: adonixEnabled(), label: 'Sign in with HackIllinois', ...(adonixEnabled() ? { startUrl: adonixStartUrl() } : {}) },
        { id: 'dev', enabled: env.NODE_ENV !== 'production', label: 'Demo volunteer' },
      ],
    };
  }

  // ---------------------------------------------------------------- sessions

  /** Writes both cookies. The session cookie is HttpOnly; the CSRF cookie is JS-readable by design. */
  public static setSessionCookies(res: Response, account: IVolunteer): { csrf: string } {
    const names = cookieNames();
    const token = mintSessionToken({ sub: account.id, sv: account.sessionVersion, kind: account.kind });
    const csrf = csrfNonceFor(account.id, account.sessionVersion);
    res.cookie(names.session, token, sessionCookieOptions());
    res.cookie(names.csrf, csrf, csrfCookieOptions());
    return { csrf };
  }

  /**
   * Clears the two cookies and nothing else, so on its own this is not a sign-out. The
   * session token is stateless: a copy taken out of the browser before this ran stays valid
   * for the rest of its 48 hours. `logout` is the one that revokes, and it does so by
   * bumping `sessionVersion` rather than by clearing anything.
   */
  public static clearSessionCookies(res: Response): void {
    const names = cookieNames();
    // Attributes must match the ones the cookies were set with, or the browser keeps them.
    const { maxAge: _s, ...sessionOpts } = sessionCookieOptions();
    const { maxAge: _c, ...csrfOpts } = csrfCookieOptions();
    void _s;
    void _c;
    res.clearCookie(names.session, sessionOpts);
    res.clearCookie(names.csrf, csrfOpts);
  }

  /**
   * Sign out = revoke. The token is stateless, so clearing the cookie alone would leave a
   * copied cookie valid for the rest of its 48 h; bumping `sessionVersion` kills every
   * session of the account (all tabs, all devices), which is the right semantics on the
   * shared laptops and borrowed phones of an event.
   */
  public static async logout(res: Response, accountId: string | undefined): Promise<void> {
    if (accountId) {
      await Volunteer.updateOne({ _id: accountId }, { $inc: { sessionVersion: 1 } });
    }
    this.clearSessionCookies(res);
  }

  /** Revocation: every token minted before the bump stops verifying within the cache window. */
  public static async revoke(accountId: string): Promise<number> {
    const updated = await Volunteer.findByIdAndUpdate(accountId, { $inc: { sessionVersion: 1 } }, { new: true });
    if (!updated) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    return updated.sessionVersion;
  }

  // ------------------------------------------------------------- claim codes

  /**
   * Mints one code for one account and returns it in the clear — the only moment it exists
   * in readable form anywhere, since only its digest is stored.
   *
   * The TTL is clamped between one hour and fourteen days whatever the caller asks for. A
   * code is a bearer credential printed on a badge, so one that outlives the event is a
   * credential nobody is watching any more, and one that expires in a minute is a support
   * queue at the registration desk.
   *
   * Issuing does **not** invalidate the account's earlier codes, and nothing else in this
   * repository does either: two live codes for one account are two ways in, and both stay
   * usable until they are redeemed or the TTL index sweeps them out of the collection.
   * Re-printing a lost badge therefore widens the window rather than closing the old one.
   * Note that `POST /auth/revoke/:id` does not help here — it bumps `sessionVersion`, which
   * kills existing sessions and leaves every outstanding claim code exactly as valid.
   */
  public static async issueClaimCode(params: {
    accountId?: string;
    email?: string;
    ttlHours?: number;
    issuedBy: string;
  }): Promise<{ code: string; accountId: string; expiresAt: Date }> {
    const account = params.accountId
      ? await Volunteer.findById(params.accountId)
      : params.email
        ? await Volunteer.findOne({ email: params.email.toLowerCase() })
        : null;
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    const code = generateClaimCode();
    const ttl = Math.min(Math.max(params.ttlHours ?? 72, 1), 24 * 14);
    const expiresAt = new Date(Date.now() + ttl * 3600_000);
    await ClaimCode.create({ codeHash: sha256(code), accountId: account._id, issuedBy: params.issuedBy, expiresAt });
    return { code, accountId: account.id, expiresAt };
  }

  /**
   * One fresh code per account, as rows for badge printing; the controller can render the
   * same rows as CSV.
   *
   * Serial by construction — one insert per account, each awaited — and unbounded: the
   * filter is `{}` or `{ kind }` with no limit and no cursor, so a thousand-account event is
   * a thousand round trips inside one request. That is tolerable because this runs once,
   * before the event, from an organiser's laptop. It would not be tolerable on any path a
   * hacker can reach.
   *
   * Additive for the same reason `issueClaimCode` is: running this twice leaves every
   * account holding two live codes rather than replacing the first.
   */
  public static async issueClaimCodesBulk(params: {
    kind?: AccountKind;
    ttlHours?: number;
    issuedBy: string;
  }): Promise<Array<{ accountId: string; name: string; email: string | null; code: string; expiresAt: Date }>> {
    const filter = params.kind ? { kind: params.kind } : {};
    const accounts = await Volunteer.find(filter).select('_id name email').lean();
    const rows: Array<{ accountId: string; name: string; email: string | null; code: string; expiresAt: Date }> = [];
    for (const acc of accounts) {
      const issued = await this.issueClaimCode({ accountId: String(acc._id), ttlHours: params.ttlHours, issuedBy: params.issuedBy });
      rows.push({ accountId: issued.accountId, name: acc.name, email: acc.email ?? null, code: issued.code, expiresAt: issued.expiresAt });
    }
    return rows;
  }

  /**
   * Redeems a badge code — the adapter with no dependencies at all: no mail server, no
   * upstream SSO, nothing but the badge in somebody's hand.
   *
   * Single use is a property of the update rather than of the ordering of two statements.
   * The filter names `usedAt: null` and an unexpired `expiresAt` alongside the digest, so two
   * people racing the same code produce exactly one match and exactly one session.
   *
   * Both failure paths count towards the brute-force alarm and answer 401
   * `CREDENTIAL_INVALID`. The second message deliberately does not separate "no such code"
   * from "already redeemed" from "expired": they are one filter, so they get one answer.
   *
   * One sharp edge, recorded rather than fixed: the code is burned before the account is
   * loaded. A code whose account has since been deleted is therefore spent by the attempt
   * that discovers it is orphaned, and the 404 that attempt receives cannot be retried into
   * anything better.
   */
  public static async claim(rawCode: string): Promise<IVolunteer> {
    const code = normaliseClaimCode(rawCode);
    if (code.length !== CLAIM_CODE_LENGTH) {
      this.recordClaimFailure();
      throw new ApiError(401, ErrorCode.CREDENTIAL_INVALID, 'That code is not valid.');
    }
    // Single use, atomically: the update only matches an unused, unexpired code.
    const doc = await ClaimCode.findOneAndUpdate(
      { codeHash: sha256(code), usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { new: true }
    );
    if (!doc) {
      this.recordClaimFailure();
      throw new ApiError(401, ErrorCode.CREDENTIAL_INVALID, 'That code is not valid, has expired, or was already used.');
    }
    const account = await Volunteer.findById(doc.accountId);
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    await this.linkIdentity(account, 'claim', doc.id);
    return account;
  }

  /**
   * The brute-force alarm, which is not the brute-force limit.
   *
   * The limit is `authExchangeLimiter` on the route — 30/min/IP by default, ten times that
   * for a trusted caller — and that is what actually bounds guessing. This counts failures
   * across all callers over a rolling hour and raises `CLAIM_BRUTE_FORCE` at fifty, at most
   * once an hour, so that a lead is told to go and look while it is happening rather than the
   * event finding out afterwards.
   *
   * It is in-process, so on a multi-replica deployment each instance counts only its own
   * share and the effective threshold is fifty per instance. For something whose whole job is
   * to be noticed that is an acceptable weakening; for a limit it would not be.
   */
  private static recordClaimFailure(now: number = Date.now()): void {
    const hourAgo = now - 3600_000;
    this.claimFailures = this.claimFailures.filter((t) => t > hourAgo);
    this.claimFailures.push(now);
    if (this.claimFailures.length >= 50 && now - this.lastBruteForceAlarmAt > 3600_000) {
      this.lastBruteForceAlarmAt = now;
      eventHub.broadcast({
        type: 'CLAIM_BRUTE_FORCE',
        data: { failuresLastHour: this.claimFailures.length, at: new Date(now).toISOString() },
      });
    }
  }

  /** Test hook. */
  public static __resetClaimFailures(): void {
    this.claimFailures = [];
    this.lastBruteForceAlarmAt = 0;
  }

  // -------------------------------------------------------------- magic link

  /**
   * Sends a sign-in link, and takes some trouble not to disclose whether there was anywhere
   * to send it.
   *
   * An unknown address returns `{ delivered: false }` and the controller answers 202 with the
   * same body it uses for a known one, so the response body is not an enumeration oracle. The
   * clock is the other half of that problem, and the reasoning for the un-awaited `send` is
   * at the call itself rather than repeated here.
   */
  public static async requestMagicLink(email: string): Promise<{ delivered: boolean }> {
    if (!magicLinkEnabled()) throw new ApiError(403, ErrorCode.PROVIDER_DISABLED, 'Email sign-in is not enabled on this deployment.');
    const account = await Volunteer.findOne({ email: email.toLowerCase() });
    // Always 202 to the caller: whether an address exists is not for an anonymous client to learn.
    if (!account) return { delivered: false };
    const token = crypto.randomBytes(32).toString('base64url');
    await AuthToken.create({
      tokenHash: sha256(token),
      accountId: account._id,
      purpose: 'MAGIC',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    const link = `${env.PUBLIC_URL}/dashboard/#magic=${token}`;
    // Dispatched, not awaited — the 202 must not be paced by whether there was anything to
    // send.
    //
    // The response body is identical either way, which is half of not being an enumeration
    // oracle. The other half is the clock: the no-account branch above returns after one
    // indexed lookup, while awaiting `send()` on a real SMTP transport put hundreds of
    // milliseconds between the two answers, readable at thirty attempts a minute. Whether an
    // address exists is exactly what that difference discloses.
    //
    // Fire-and-forget also has the property the caller needs: a delivery failure must not
    // change what the caller sees, because "the mail bounced" is itself the fact being
    // protected. It is logged instead, where the operator can act on it.
    //
    // What remains is the token insert — one local write against an indexed collection,
    // microseconds against SMTP's milliseconds. Constant-time to the resolution an attacker
    // can measure over the network, which is the standard this needs to meet.
    void getMailer()
      .send({
        to: account.email as string,
        subject: 'Your Nexus Quest sign-in link',
        text: `Tap to sign in (valid 15 minutes, single use):\n\n${link}\n\nIf you did not ask for this, ignore it.`,
      })
      .catch((err: unknown) => {
        console.error(`[auth] magic-link delivery failed for account ${account._id}:`, err);
      });
    // The link is never returned to the caller (that would make the 202 an enumeration
    // oracle); in development the console mailer prints it to the server log instead.
    return { delivered: true };
  }

  /**
   * Burns the token and hands back the account, on the same single-statement filter as
   * `claim`: digest, purpose, unused, unexpired. Four ways to fail, one answer.
   *
   * Note what is deliberately *not* checked here: `magicLinkEnabled()`. Turning the adapter
   * off — removing `SMTP_URL` in production — stops new links being minted but does not
   * invalidate one already sitting in somebody's inbox, and the fifteen-minute TTL on
   * `AuthToken` is the whole of the bound on that. `requestMagicLink` is the only thing in
   * the codebase that creates one of these rows, so there is no second source to close.
   */
  public static async redeemMagic(token: string): Promise<IVolunteer> {
    const doc = await AuthToken.findOneAndUpdate(
      { tokenHash: sha256(token), purpose: 'MAGIC', usedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { usedAt: new Date() } },
      { new: true }
    );
    if (!doc) throw new ApiError(401, ErrorCode.CREDENTIAL_INVALID, 'That link is not valid, has expired, or was already used.');
    const account = await Volunteer.findById(doc.accountId);
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    await this.linkIdentity(account, 'email', (account.email as string).toLowerCase());
    return account;
  }

  // ------------------------------------------------------------------ adonix

  /**
   * Adonix trust boundary. The Adonix subject is the only thing we match on. An email that
   * happens to equal an existing account's email is NOT a link: upstream email is unverified
   * from our point of view, so honouring it would let a spoofed or compromised SSO mint a
   * session for any volunteer whose address is known. Linking requires an already signed-in
   * session (`currentAccountId`) — "sign in with your badge code, then connect Adonix".
   *
   * New Adonix accounts are always HACKER. Staff accounts are created by organisers (CSV /
   * claim codes) and link Adonix afterwards; an upstream role claim never mints staff here.
   */
  public static async adonixLogin(token: string, currentAccountId?: string): Promise<IVolunteer> {
    const identity = await verifyAdonixToken(token);
    // Role mapping is still evaluated so an unmapped role set fails closed (403).
    mapAdonixRoles(identity.roles);

    const bySubject = await Volunteer.findOne({ identities: { $elemMatch: { provider: 'adonix', subject: identity.subject } } });
    if (bySubject) return bySubject;

    if (currentAccountId) {
      const current = await Volunteer.findById(currentAccountId);
      if (!current) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      await this.linkIdentity(current, 'adonix', identity.subject);
      return current;
    }

    if (identity.email) {
      const byEmail = await Volunteer.exists({ email: identity.email.toLowerCase() });
      if (byEmail) {
        throw new ApiError(
          409,
          ErrorCode.ACCOUNT_LINK_REQUIRED,
          'An account with this email already exists. Sign in with your badge code first, then connect HackIllinois from your profile.'
        );
      }
    }

    return Volunteer.create({
      name: identity.name ?? `Hacker ${identity.subject.slice(-4)}`,
      email: identity.email?.toLowerCase() ?? null,
      kind: AccountKind.HACKER,
      role: VolunteerRole.HACKER,
      identities: [{ provider: 'adonix', subject: identity.subject, linkedAt: new Date() }],
    });
  }

  // ------------------------------------------------------------- development

  /**
   * Signs in as any account by id, with no credential whatsoever. Two independent things
   * keep it out of production: `auth.routes.ts` does not register the handler at all when
   * `NODE_ENV === 'production'`, and this refuses if it is somehow reached anyway.
   *
   * The refusal is a 404 `Route not found.` rather than a 403. A 403 would confirm that the
   * route exists and is merely switched off, which is the one fact a prober is after; the 404
   * is indistinguishable from the handler not being mounted, which in production is also the
   * truth.
   */
  public static async devLogin(accountId: string): Promise<IVolunteer> {
    if (env.NODE_ENV === 'production') throw ApiError.notFound('Route not found.');
    if (!Types.ObjectId.isValid(accountId)) throw ApiError.badRequest('Invalid account id.');
    const account = await Volunteer.findById(accountId);
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    return account;
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Records "this account can also be reached through this provider", idempotently and
   * without a read-modify-write.
   *
   * The early return covers the ordinary repeat: signing in with the same badge code twice
   * must not push a second identical entry. The `$not: { $elemMatch: … }` in the filter
   * covers the case the early return cannot see — two requests for the same account and
   * provider in flight at once, both having read an `identities` array that did not contain
   * the pair yet. The push applies only while it is still true that the pair is absent.
   *
   * A (provider, subject) pair belongs to at most one account event-wide, because
   * `volunteer.model.ts` carries a unique sparse index on
   * `(identities.provider, identities.subject)`. This cannot therefore be used to attach one
   * Adonix subject to two accounts: the second write is refused by the index rather than
   * ignored here.
   */
  private static async linkIdentity(account: IVolunteer, provider: IdentityProvider, subject: string): Promise<void> {
    if (account.identities.some((i) => i.provider === provider && i.subject === subject)) return;
    await Volunteer.updateOne(
      { _id: account._id, identities: { $not: { $elemMatch: { provider, subject } } } },
      { $push: { identities: { provider, subject, linkedAt: new Date() } } }
    );
  }
}
