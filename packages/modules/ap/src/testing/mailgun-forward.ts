/**
 * Recorded Mailgun route `forward()` POSTs for tests (T-0215, RQ-0181 S1–S3). No live provider.
 *
 * Shape: `multipart/form-data` with top-level fields, as Mailgun sends to a forward URL ending in
 * `mime` — the field names and order of django-anymail's `test_inbound_mime` payload (recorded
 * from Mailgun): token, timestamp, recipient, sender, body-mime, then signature. The message is
 * the byte-exact recorded `fixtures/mailgun-inbound-bill.eml` (CRLF, a supplier invoice PDF).
 * The signature is hex HMAC-SHA256(signing key, timestamp ‖ token); tests sign at run time with a
 * per-run key because the timestamp must be fresh.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The recorded supplier email (Message-ID `<inv-2215@paperco.example>`, one PDF). */
export const MAILGUN_BILL_EML: Buffer = readFileSync(
  new URL('./fixtures/mailgun-inbound-bill.eml', import.meta.url),
);

export const mailgunSignature = (key: string, timestamp: string, token: string): string =>
  createHmac('sha256', key).update(`${timestamp}${token}`).digest('hex');

/** A Mailgun-style token: 50 random alphanumeric characters (RQ-0181 S1). */
export function mailgunToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(50)].map((b) => alphabet[b % alphabet.length]).join('');
}

export type FormField = readonly [name: string, value: string | Buffer];

/** Encode fields as multipart/form-data bytes (RFC 7578), values kept octet-exact. */
export function encodeMultipart(
  fields: readonly FormField[],
  boundary = `----mgfixture${randomBytes(8).toString('hex')}`,
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      typeof value === 'string' ? Buffer.from(value, 'utf8') : value,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface MailgunForwardOptions {
  readonly key: string;
  readonly recipient: string;
  readonly bodyMime?: Buffer;
  readonly timestamp?: number;
  readonly token?: string;
  /** Replace the computed signature (forgeries); `null` omits the field. */
  readonly signature?: string | null;
  /** Extra fields appended before the signature (e.g. `attachments` of a store() route). */
  readonly extra?: readonly FormField[];
  /** Field names to leave out. */
  readonly omit?: readonly string[];
}

/** A signed Mailgun forward() POST body for `recipient`. */
export function mailgunForward(o: MailgunForwardOptions): {
  body: Buffer;
  contentType: string;
  token: string;
  timestamp: string;
} {
  const timestamp = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const token = o.token ?? mailgunToken();
  const signature =
    o.signature === undefined ? mailgunSignature(o.key, timestamp, token) : o.signature;
  const fields: FormField[] = [
    ['token', token],
    ['timestamp', timestamp],
    ['recipient', o.recipient],
    ['sender', 'bounces+accounts=paperco.example@mg.paperco.example'],
    ['body-mime', o.bodyMime ?? MAILGUN_BILL_EML],
    ...(o.extra ?? []),
    ...(signature === null ? [] : ([['signature', signature]] as const)),
  ];
  const omit = new Set(o.omit ?? []);
  return { ...encodeMultipart(fields.filter(([n]) => !omit.has(n))), token, timestamp };
}
