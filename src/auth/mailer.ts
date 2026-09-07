/**
 * Outbound mail for the magic-link adapter.
 *
 * Two implementations behind one interface: `SmtpMailer` (nodemailer over `SMTP_URL`) for
 * a real deployment, and `ConsoleMailer` for development, which prints the link to the
 * server log so `npm run demo` can exercise the flow with no mail server. The adapter
 * reports itself disabled when `SMTP_URL` is unset in production, so the login screen
 * never offers a button that cannot work.
 */
import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

/** Plain text only. A magic link is a URL and an HTML body would only add ways to mangle it. */
export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * `kind` is reported by `/auth/providers` so the dashboard can say "check the server log"
 * rather than "check your inbox" when a demo is running without SMTP.
 */
export interface Mailer {
  readonly kind: 'smtp' | 'console';
  send(mail: OutboundMail): Promise<void>;
}

/**
 * Prints the mail instead of sending it, and keeps every one in `sent`.
 *
 * That array is unbounded, which is fine for its two uses — a test inspecting the last link,
 * and a development console — and would be a leak in a long-running process. It is never
 * selected in production: `getMailer` picks this only when `SMTP_URL` is unset, and the boot
 * guard in `AuthService.providers` reports the magic-link adapter disabled in production
 * without one, so nothing routes mail here.
 */
export class ConsoleMailer implements Mailer {
  public readonly kind = 'console' as const;
  /** Captured for tests and for the dev console. */
  public readonly sent: OutboundMail[] = [];

  public async send(mail: OutboundMail): Promise<void> {
    this.sent.push(mail);
    if (env.NODE_ENV !== 'test') {
      console.log(`📧 [console mailer] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    }
  }
}

/**
 * Nodemailer over a single `SMTP_URL`. The transport is built once in the constructor and
 * reused, so the connection pool outlives an individual send; a send that fails rejects, and
 * the magic-link route deliberately does not await it (see `docs/LIMITATIONS.md` — a failure
 * is logged, not retried, and the response time must not disclose whether an address exists).
 */
export class SmtpMailer implements Mailer {
  public readonly kind = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(url: string) {
    this.transport = nodemailer.createTransport(url);
  }

  public async send(mail: OutboundMail): Promise<void> {
    await this.transport.sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

let instance: Mailer | null = null;

/** SMTP when configured; console otherwise. Production without SMTP → magic link disabled (see AuthService.providers). */
export function getMailer(): Mailer {
  if (!instance) {
    instance = env.SMTP_URL ? new SmtpMailer(env.SMTP_URL) : new ConsoleMailer();
  }
  return instance;
}

/** Test hook: swap the mailer (e.g. to a fresh ConsoleMailer to inspect `sent`). */
export function __setMailerForTests(mailer: Mailer | null): void {
  instance = mailer;
}

/**
 * Whether to offer the magic-link button at all.
 *
 * Outside production this is always true, because `ConsoleMailer` prints the link and the
 * demo flow works end to end with no mail server. In production it requires `SMTP_URL`, so a
 * deployment that forgot to configure mail shows no button rather than a button that accepts
 * an address and silently does nothing.
 */
export function magicLinkEnabled(): boolean {
  return env.NODE_ENV !== 'production' || !!env.SMTP_URL;
}
