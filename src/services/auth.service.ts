/**
 * Identity: one session, three ways in.
 *
 * Every adapter — badge claim code, email magic link, Adonix — ends in `mintSession`,
 * which produces the HttpOnly session cookie and the JS-readable CSRF cookie. Nothing else
 * in the system knows which adapter a person used; controllers only ever see
 * `req.account`.
 *
 * Accounts are `Volunteer` documents with a `kind` (VOLUNTEER | HACKER). Hackers are
 * created on first Adonix login (or via an organiser import) and hold no shifts; the
 * `kind ⇔ role` invariant on the model keeps the two ladders coherent.
 *
 * Failure counting for claim codes is an in-process sliding window: fifty failed claims in
 * an hour raises `CLAIM_BRUTE_FORCE` on the announce channel once per hour. The per-IP
 * limiter on the route is the hard bound; this is the alarm that tells a lead to look.
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
export const CLAIM_CODE_LENGTH = 10;

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

export interface ProviderInfo {
  id: 'claim' | 'magic' | 'adonix' | 'dev';
  enabled: boolean;
  label: string;
  startUrl?: string;
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function normaliseClaimCode(raw: string): string {
  // Accept what humans type: lowercase, dashes/spaces, and the letters Crockford excludes.
  return raw
    .toUpperCase()
    .replace(/[-\s]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function generateClaimCode(): string {
  const bytes = crypto.randomBytes(CLAIM_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

export class AuthService {
  private static claimFailures: number[] = [];
  private static lastBruteForceAlarmAt = 0;

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

  public static clearSessionCookies(res: Response): void {
    const names = cookieNames();
    res.clearCookie(names.session, { path: '/' });
    res.clearCookie(names.csrf, { path: '/' });
  }

  /** Revocation: every token minted before the bump stops verifying within the cache window. */
  public static async revoke(accountId: string): Promise<number> {
    const updated = await Volunteer.findByIdAndUpdate(accountId, { $inc: { sessionVersion: 1 } }, { new: true });
    if (!updated) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    return updated.sessionVersion;
  }

  // ------------------------------------------------------------- claim codes

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

  /** One code per account; returned as rows for badge printing. */
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

  public static async requestMagicLink(email: string): Promise<{ delivered: boolean; debugLink?: string }> {
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
    await getMailer().send({
      to: account.email as string,
      subject: 'Your Nexus Quest sign-in link',
      text: `Tap to sign in (valid 15 minutes, single use):\n\n${link}\n\nIf you did not ask for this, ignore it.`,
    });
    return { delivered: true, ...(env.NODE_ENV !== 'production' ? { debugLink: link } : {}) };
  }

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

  public static async adonixLogin(token: string): Promise<IVolunteer> {
    const identity = await verifyAdonixToken(token);
    const mapped = mapAdonixRoles(identity.roles);

    let account = await Volunteer.findOne({ identities: { $elemMatch: { provider: 'adonix', subject: identity.subject } } });
    if (!account && identity.email) {
      account = await Volunteer.findOne({ email: identity.email.toLowerCase() });
    }
    if (!account) {
      account = await Volunteer.create({
        name: identity.name ?? `Hacker ${identity.subject.slice(-4)}`,
        email: identity.email?.toLowerCase() ?? null,
        kind: mapped.kind,
        role: mapped.role,
        identities: [{ provider: 'adonix', subject: identity.subject, linkedAt: new Date() }],
      });
      return account;
    }
    // An existing volunteer keeps their staff role; Adonix never downgrades a known account.
    await this.linkIdentity(account, 'adonix', identity.subject);
    return account;
  }

  // ------------------------------------------------------------- development

  public static async devLogin(accountId: string): Promise<IVolunteer> {
    if (env.NODE_ENV === 'production') throw ApiError.notFound('Route not found.');
    if (!Types.ObjectId.isValid(accountId)) throw ApiError.badRequest('Invalid account id.');
    const account = await Volunteer.findById(accountId);
    if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
    return account;
  }

  // ----------------------------------------------------------------- helpers

  private static async linkIdentity(account: IVolunteer, provider: IdentityProvider, subject: string): Promise<void> {
    if (account.identities.some((i) => i.provider === provider && i.subject === subject)) return;
    await Volunteer.updateOne(
      { _id: account._id, identities: { $not: { $elemMatch: { provider, subject } } } },
      { $push: { identities: { provider, subject, linkedAt: new Date() } } }
    );
  }
}
