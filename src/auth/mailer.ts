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

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly kind: 'smtp' | 'console';
  send(mail: OutboundMail): Promise<void>;
}

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

export function magicLinkEnabled(): boolean {
  return env.NODE_ENV !== 'production' || !!env.SMTP_URL;
}
