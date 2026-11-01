/**
 * SMTP sender (ADR-0046): nodemailer over the URL in LF_SMTP_URL. TLS is required except for a
 * plain `smtp://` relay on the loopback interface (local relays and the test sink).
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments?: readonly EmailAttachment[];
}

export interface EmailSender {
  /** Sends one message; returns the SMTP message id. */
  send(m: EmailMessage): Promise<string>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class SmtpSender implements EmailSender {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(cfg: { url: string; from: string }) {
    const u = new URL(cfg.url);
    if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') {
      throw new Error('LF_SMTP_URL must be smtp:// or smtps://');
    }
    const local = u.protocol === 'smtp:' && LOOPBACK.has(u.hostname);
    this.#transport = nodemailer.createTransport({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port ? Number.parseInt(u.port, 10) : u.protocol === 'smtps:' ? 465 : 587,
      secure: u.protocol === 'smtps:',
      requireTLS: !local && u.protocol === 'smtp:',
      ignoreTLS: local,
      ...(u.username
        ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } }
        : {}),
    });
    this.#from = cfg.from;
  }

  /** From the environment: LF_SMTP_URL and LF_SMTP_FROM (credentials never logged). */
  static fromEnv(env: NodeJS.ProcessEnv): SmtpSender {
    const url = env['LF_SMTP_URL'];
    const from = env['LF_SMTP_FROM'];
    if (!url || !from) throw new Error('LF_SMTP_URL and LF_SMTP_FROM are required to send email');
    return new SmtpSender({ url, from });
  }

  async send(m: EmailMessage): Promise<string> {
    const info = await this.#transport.sendMail({
      from: this.#from,
      to: [...m.to],
      ...(m.cc && m.cc.length > 0 ? { cc: [...m.cc] } : {}),
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      attachments: (m.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.content),
      })),
    });
    return String(info.messageId);
  }
}
