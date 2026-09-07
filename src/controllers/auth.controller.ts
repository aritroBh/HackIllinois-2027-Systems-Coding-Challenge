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
import { presenceService } from '../presence/service';

/** Role hierarchy for revocation checks. HACKER and VOLUNTEER are peers at the bottom. */
const ROLE_RANK: Record<string, number> = { HACKER: 0, VOLUNTEER: 0, SHIFT_LEAD: 1, ORGANIZER: 2, ADMIN: 3 };

export class AuthController {
  /**
   * The sign-in menu, and the only handler in this file that is synchronous and takes no
   * `next` — there is nothing here that can fail, so there is nothing to forward.
   *
   * Which providers appear is a property of the deployment rather than of the caller: the
   * magic link is offered whenever a mailer exists (outside production the console mailer
   * always counts, so it is listed there even with no SMTP configured), Adonix only when
   * `ADONIX_ENABLED` is set, and the demo volunteer only outside production. The login screen
   * has to render before anybody has a session, which is why this path is one of the few on
   * `enforceAuthMode`'s anonymous allow-list.
   */
  public static providers(_req: Request, res: Response): void {
    res.status(200).json({ success: true, data: AuthService.providers() });
  }

  /**
   * Badge code for a session — the way in that needs nothing but the badge in someone's hand.
   *
   * `Cache-Control: no-store` is set on this and on the other three exchanges below because
   * the body carries the CSRF nonce. A shared or proxied cache holding that would hand the
   * next person at the same laptop a working nonce for somebody else's session.
   *
   * A code that is wrong, expired, or already spent all come back as the same 401 with the
   * same wording, so a caller cannot tell which of the three happened; only a code of the
   * wrong length is distinguishable, and that tells an attacker nothing they did not send.
   * The hard bound on guessing is `authExchangeLimiter` on the route. The service also counts
   * failures process-wide and shouts on the **ops** channel, which is an alarm for a lead to look
   * at rather than a second bound. Ops and not announce, deliberately and by the routing table in
   * `eventHub` (`CLAIM_BRUTE_FORCE: 'ops'`): `announce` is readable without a session, so telling
   * the floor that somebody is guessing badge codes would tell the guesser too. This comment said
   * `announce`, which would have sent an operator to watch the one channel the alarm never
   * reaches.
   */
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

  /**
   * Asks for a sign-in link. Answers 202 with a fixed sentence whether or not the address
   * belongs to an account. The service's `{ delivered }` return is discarded rather than
   * echoed, and it has to be: `delivered: false` means "no such account", which is precisely
   * the bit the two identical bodies exist to hide.
   *
   * The constant body is only half of not being an enumeration oracle. The other half is the
   * clock, and it is in the service: delivery is dispatched rather than awaited, because
   * awaiting SMTP for a real address and returning after one indexed lookup for an unknown
   * one put a readable difference between the two answers.
   *
   * The one thing this does disclose is a fact about the deployment rather than about the
   * address: with no mailer configured the service raises 403 PROVIDER_DISABLED, which is the
   * same answer for every address anyone could send.
   */
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

  /**
   * Redeems a magic link. Single use and fifteen minutes, both enforced by the one conditional
   * update that marks the token spent, so a link forwarded on to somebody else is worth
   * nothing once the first person has followed it.
   *
   * The token arrives in the request body, not in the URL: the mail carries it in the location
   * fragment and the dashboard posts it here, so it never reaches the server as a query string
   * that access logs and proxies would keep.
   */
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

  /**
   * HackIllinois SSO, and the one exchange whose meaning depends on whether the caller already
   * has a session: sign-in for an anonymous caller, account linking for a signed-in one. The
   * inline comment below is the important part and covers why linking demands explicit intent.
   *
   * Three outcomes to expect. 200 with a session. 409 ACCOUNT_LINK_CONFIRM from here, when a
   * signed-in caller did not confirm. And 409 ACCOUNT_LINK_REQUIRED from the service, when an
   * anonymous caller's upstream email already belongs to an account — that refusal is the
   * design rather than a gap, because matching on an email this system never verified would
   * let a spoofed or compromised SSO mint a session for any volunteer whose address is known.
   */
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

  /**
   * Signs in as any seeded account by id, with no credential whatsoever. That is the whole
   * point of it — `npm run demo` has to reach a signed-in browser with no mailbox, no SSO
   * issuer and no printed badge — and it is why the route is not registered at all when
   * `NODE_ENV=production`: there is no handler to probe rather than a handler that refuses.
   * The service checks the environment a second time, so a direct call cannot reach it either.
   */
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

  /**
   * Signs out everywhere, not merely here. The session token is stateless, so clearing the
   * cookie alone would leave a copied one valid for the rest of its life; the service bumps
   * `sessionVersion` instead, which stops every token ever minted for the account verifying.
   * On the shared laptops and borrowed phones of an event that is the right reading of
   * "sign out".
   *
   * Only a proved session is bumped. A legacy-claimed identity resolves to `undefined` here
   * and gets nothing but its own cookies cleared, so naming somebody else's public id cannot
   * be used to sign that person out. The cache eviction is what makes the bump bite on this
   * instance immediately instead of within the account cache's sixty-second window.
   */
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

  /**
   * Stops every session of another account — the runbook answer to a lost phone or a badge
   * left on a table. 200 with the new `sessionVersion`, which is the number every existing
   * token is now compared against and fails.
   *
   * Two things the rank check below quietly depends on. `requireSession` on the route, so
   * `req.account!` is a real session rather than a claimed identity — the assertion is
   * load-bearing on that middleware staying mounted. And `objectId()` lowercasing the path
   * parameter, which is what makes the raw `!==` self-comparison safe against a caller who
   * spells their own id in capitals; every other ownership test in this codebase uses
   * `sameId` for exactly that reason.
   *
   * The two invalidations after the bump are not the same invalidation. `evictAccountCache`
   * drops the identity middleware's copy; `presenceService.invalidate` drops the presence
   * layer's separate one, which decides what that account may still see on the live map.
   */
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
      presenceService.invalidate(targetId);
      res.status(200).json({ success: true, data: { accountId: targetId, sessionVersion } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Mints one badge code for one account. 201, `no-store`, and the code appears exactly once
   * in its life — in this response body — because only its SHA-256 is stored.
   *
   * `issuedBy` records the string `organizer-secret` when the caller authenticated with the
   * bootstrap header rather than with a session. That is the honest entry rather than a
   * placeholder: at that point in a deployment's life there is no account to attribute it to,
   * and the alternative would be an audit row naming somebody who was not there.
   */
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

  /**
   * One code per account, for printing a whole event's badges in a single pass. CSV columns
   * are accountId,name,email,code,expiresAt.
   *
   * The escaping is the part worth reading. Every cell is quoted, and a cell beginning `=`,
   * `+`, `-` or `@` is prefixed with an apostrophe so that an account name typed as a formula
   * cannot execute when an organiser opens the file. The test runs against the first non-blank
   * character because a spreadsheet strips leading whitespace before it decides what is a
   * formula, and the tab and carriage return are in the class for the same reason.
   *
   * `Accept: text/csv` selects the CSV and anything else gets JSON rows; both are 201 and both
   * are `no-store`. Either way this is the single most sensitive response the API produces —
   * every claim code in the event, in plaintext, and a claim code is a session.
   */
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

  /**
   * Promotes or demotes a staff account. 200 with the updated public account.
   *
   * Two refusals come before the rank check and mean different things. An unknown id is 404.
   * A hacker account is 400 rather than 403, because the model ties `kind` and `role`
   * together and there is therefore no staff role to give it — that is a malformed request,
   * not a denied one, and answering 403 would suggest a more senior caller could do it.
   *
   * The two invalidations at the end are not redundant with each other; the comment beside
   * the second says why a demotion in particular cannot wait for a cache to expire.
   */
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
      // And the presence layer's own copy of the account, which is what decides whether this
      // person still sees off-shift volunteers and may hold a `presence:exact` stream. It has
      // a thirty-second life of its own, so without this a demotion took up to half a minute
      // to bite — the tick re-asserted the old role from stale facts every second in between.
      // Dropping a privilege has to be immediate even though granting one can wait.
      presenceService.invalidate(account.id);
      res.status(200).json({ success: true, data: AuthService.toPublicAccount(account) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * The demo account picker's list — id, name, role and kind of the seeded accounts, most
   * senior first. Mounted only outside production and next to dev-login, because it is only
   * of use to the endpoint that signs in without a credential.
   *
   * Rough edge worth knowing before you seed a large event: the fifty-row cap is applied by
   * the database in creation order and the rank ordering happens afterwards in memory, so on
   * a seed with more than fifty accounts this shows the first fifty created, sorted by rank —
   * not the fifty most senior. Harmless for the shipped seed and wrong for a bigger one.
   */
  public static async devAccounts(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const accounts = await Volunteer.find({}, 'name role kind').sort({ createdAt: 1 }).limit(50).lean();
      const rows = accounts
        .map((a) => ({ id: String(a._id), name: a.name, role: a.role, kind: a.kind }))
        .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, data: rows });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Whether dev-login is mounted at all is decided at router construction (see auth.routes),
   * which is why this exists and also why nothing calls it: the routes read `env.NODE_ENV`
   * directly and no caller in `src/`, `public/` or `tests/` references this method. It is
   * dead as of this writing — kept, and said so, rather than quietly documented as though it
   * were the source of truth for something.
   */
  public static devLoginAvailable(): boolean {
    return env.NODE_ENV !== 'production';
  }
}
