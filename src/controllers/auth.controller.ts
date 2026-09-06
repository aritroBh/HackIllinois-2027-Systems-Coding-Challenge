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

export class AuthController {
  public static providers(_req: Request, res: Response): void {
    res.status(200).json({ success: true, data: AuthService.providers() });
  }

  public static async claim(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.claim(req.body.code);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async magicLink(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await AuthService.requestMagicLink(req.body.email);
      // 202 either way: the response must not reveal whether the address exists.
      res.status(202).json({
        success: true,
        data: { message: 'If that address belongs to an account, a sign-in link is on its way.', ...(result.debugLink ? { debugLink: result.debugLink } : {}) },
      });
    } catch (error) {
      next(error);
    }
  }

  public static async magic(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.redeemMagic(req.body.token);
      const { csrf } = AuthService.setSessionCookies(res, account);
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static async adonix(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await AuthService.adonixLogin(req.body.token);
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
      res.status(200).json({ success: true, data: { account: AuthService.toPublicAccount(account), csrf } });
    } catch (error) {
      next(error);
    }
  }

  public static logout(_req: Request, res: Response): void {
    AuthService.clearSessionCookies(res);
    res.status(200).json({ success: true, data: { message: 'Signed out.' } });
  }

  public static async revoke(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sessionVersion = await AuthService.revoke(req.params.id as string);
      res.status(200).json({ success: true, data: { accountId: req.params.id, sessionVersion } });
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
      const wantsCsv = (req.headers.accept ?? '').includes('text/csv');
      if (wantsCsv) {
        const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
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
      account.role = req.body.role as VolunteerRole;
      await account.save();
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
