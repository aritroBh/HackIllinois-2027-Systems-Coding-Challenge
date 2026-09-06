/**
 * Identity HTTP surface — provider list, the three credential exchanges, dev login,
 * logout, revocation and role changes.
 *
 * Every successful exchange ends the same way: `AuthService.setSessionCookies` writes the
 * HttpOnly session cookie and the JS-readable CSRF cookie, and the body returns the public
 * account. The session token itself never appears in a response body, header or log.
 */
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service';
import { Volunteer, VolunteerRole, AccountKind } from '../models/volunteer.model';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { env } from '../config/env';
import { evictAccountCache } from '../middleware/identity';

/** Role hierarchy for revocation checks. HACKER and VOLUNTEER are peers at the bottom. */
const ROLE_RANK: Record<string, number> = { HACKER: 0, VOLUNTEER: 0, SHIFT_LEAD: 1, ORGANIZER: 2, ADMIN: 3 };

export class AuthController {
  public static providers(_req: Request, res: Response): void {
    res.status(200).json({ success: true, data: AuthService.providers() });
  }

  public static async claim(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.claim(req.body.code);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async magicLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await AuthService.requestMagicLink(req.body.email);
      // 202 with an identical body either way: the response must not reveal whether the
      // address exists, in any environment.
      res.status(202).json({
        success: true,
        data: { message: 'If that address belongs to an account, a sign-in link is on its way.' },
      });
    } catch (error) {
      next(error);
    }
  }

  public static async magic(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.redeemMagic(req.body.token);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async adonix(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // A signed-in caller is LINKING Adonix to their existing account; anonymous callers
      // sign in (or get 409 ACCOUNT_LINK_REQUIRED if the email is already taken).
      //
      // Linking requires explicit intent (`link: true`, sent only by the confirmation button):
      // otherwise an attacker could send a signed-in victim to /dashboard/#adonix=<attacker
      // token> and the page's own fragment exchange would tie the attacker's SSO identity to
      // the victim's account. The fragment path never sends `link`, so it gets a 409 and the
      // UI asks the person first.
      const linkTo = req.account?.source === 'session' ? req.account.id : undefined;
      if (linkTo && req.body.link !== true) {
        throw new ApiError(409, ErrorCode.ACCOUNT_LINK_CONFIRM, 'You are already signed in. Confirm that you want to connect this HackIllinois login to your account.');
      }
      const account = await AuthService.adonixLogin(req.body.token, linkTo);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async devLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.devLogin(req.body.accountId);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accountId = req.account?.source === 'session' ? req.account.id : undefined;
      await AuthService.logout(res, accountId);
      if (accountId) evictAccountCache(accountId);
      res.status(200).json({ success: true, data: { message: 'Signed out everywhere.' } });
    } catch (error) {
      next(error);
    }
  }

  public static async revoke(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const targetId = req.params.id as string;
      const target = await Volunteer.findById(targetId).select('role');
      if (!target) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      // A lead may revoke their own sessions or those of accounts below them; only ORGANIZER+
      // may revoke a lead, and only ADMIN may revoke an organizer or admin. Otherwise any
      // shift lead could lock the organisers out of the event.
      const caller = req.account!;
      if (caller.id !== targetId && ROLE_RANK[target.role] >= ROLE_RANK[caller.role] && caller.role !== 'ADMIN') {
        throw new ApiError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'You cannot revoke an account at or above your own role.');
      }
      const sessionVersion = await AuthService.revoke(targetId);
      evictAccountCache(targetId);
      res.status(200).json({ success: true, data: { accountId: targetId, sessionVersion } });
    } catch (error) {
      next(error);
    }
  }

  public static async issueClaimCode(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const issued = await AuthService.issueClaimCode({
        accountId: req.body.accountId,
        email: req.body.email,
        ttlHours: req.body.ttlHours,
        issuedBy: req.account?.id ?? 'organizer-secret',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ success: true, data: issued });
    } catch (error) {
      next(error);
    }
  }

  /** CSV for badge printing: accountId,name,email,code,expiresAt. */
  public static async issueClaimCodesBulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rows = await AuthService.issueClaimCodesBulk({
        kind: req.body.kind as AccountKind | undefined,
        ttlHours: req.body.ttlHours,
        issuedBy: req.account?.id ?? 'organizer-secret',
      });
      res.setHeader('Cache-Control', 'no-store');
      const wantsCsv = (req.headers.accept ?? '').includes('text/csv');
      if (wantsCsv) {
        // Quote every cell and neutralise spreadsheet formula prefixes (= + - @ and the tab/CR
        // variants), so a crafted account name cannot execute when the CSV is opened.
        const esc = (v: unknown) => {
          const raw = String(v ?? '');
          // Leading whitespace is stripped by spreadsheets before formula detection, so test
          // the first non-blank character.
          const safe = /^\s*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
          return `"${safe.replace(/"/g, '""')}"`;
        };
        const csv = ['accountId,name,email,code,expiresAt']
          .concat(rows.map((r) => [r.accountId, r.name, r.email, r.code, r.expiresAt.toISOString()].map(esc).join(',')))
          .join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="claim-codes.csv"');
        res.status(201).send(csv);
        return;
      }
      res.status(201).json({ success: true, data: { count: rows.length, rows } });
    } catch (error) {
      next(error);
    }
  }

  public static async setRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await Volunteer.findById(req.params.id as string);
      if (!account) throw ApiError.notFound('Account not found.', ErrorCode.VOLUNTEER_NOT_FOUND);
      if (account.kind !== AccountKind.VOLUNTEER) throw ApiError.badRequest('Hacker accounts cannot be given a staff role.');
      // Rank check, mirroring revoke: you may only hand out roles below your own, and only
      // change accounts below your own. Otherwise any organizer could promote a confederate to
      // ADMIN, who then revokes every organizer.
      const caller = req.account!;
      const granted = req.body.role as VolunteerRole;
      if (caller.role !== 'ADMIN' && (ROLE_RANK[granted] >= ROLE_RANK[caller.role] || ROLE_RANK[account.role] >= ROLE_RANK[caller.role])) {
        throw new ApiError(403, ErrorCode.INSUFFICIENT_PERMISSIONS, 'You can only assign roles below your own, to accounts below your own.');
      }
      account.role = granted;
      await account.save();
      evictAccountCache(account.id);
      res.status(200).json({ success: true, data: AuthService.toPublicAccount(account) });
    } catch (error) {
      next(error);
    }
  }

  /** Whether dev-login is mounted at all is decided at router construction (see auth.routes). */
  public static devLoginAvailable(): boolean {
    return env.NODE_ENV !== 'production';
  }
}
