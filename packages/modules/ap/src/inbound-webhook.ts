/**
 * Bills inbox SaaS transport: Mailgun route `forward()` webhook (T-0215, ADR-0099, RQ-0181).
 *
 * Mailgun POSTs `multipart/form-data` with the raw message in `body-mime` (forward URL ending in
 * `mime`) and `timestamp`, `token`, `signature` = hex HMAC-SHA256(signing key, timestamp ‖ token).
 * The signature does not cover the body or the recipient (RQ-0181 F1), so the token is single use
 * (`app.inbound_webhook_receipt`, global unique, written in the ingest transaction) and the
 * timestamp must be within ±300 s. The company is found only from the recipient address
 * `bills-<token>@<inbound domain>` through the SECURITY DEFINER `app.bill_inbox_route()`, looked
 * up after the signature check. The message is parsed (by `ingestBillEmail`) only after every
 * check passed. Errors carry fixed reason codes, never keys, tokens or message content.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ingestBillEmail, InboxError } from './inbox.ts';

type Trx = Transaction<Database>;

export const MAILGUN_TOLERANCE_SECONDS = 300;
/** Largest request body read: the 25 MiB message ceiling (RQ-0177 F5) plus form overhead. */
export const INBOUND_BODY_LIMIT = 26 * 1024 * 1024;
const MAX_PARTS = 32;
const MAX_PART_HEADER_BYTES = 8 * 1024;

export type InboundRefusalReason =
  | 'not_configured'
  | 'unsupported_media_type'
  | 'malformed_form'
  | 'missing_signature'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'misconfigured_route'
  | 'unknown_recipient'
  | 'replayed'
  | 'message_refused';

const STATUS: Record<InboundRefusalReason, number> = {
  not_configured: 503,
  unsupported_media_type: 415,
  malformed_form: 400,
  missing_signature: 401,
  bad_signature: 401,
  stale_timestamp: 401,
  // Mailgun never retries a 406 (RQ-0181 F3): refusals a retry cannot fix.
  misconfigured_route: 406,
  unknown_recipient: 406,
  replayed: 406,
  message_refused: 406,
};

export class InboundWebhookError extends Error {
  readonly reason: InboundRefusalReason;
  readonly status: number;
  constructor(reason: InboundRefusalReason) {
    super(`inbound webhook refused: ${reason}`);
    this.name = 'InboundWebhookError';
    this.reason = reason;
    this.status = STATUS[reason];
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const TIMESTAMP = /^\d{1,12}$/;

/** Throws InboundWebhookError unless the fields are a fresh Mailgun signature by one of `keys`. */
export function verifyMailgunSignature(
  f: { timestamp?: string | undefined; token?: string | undefined; signature?: string | undefined },
  keys: readonly string[],
  nowSeconds: number,
  toleranceSeconds: number = MAILGUN_TOLERANCE_SECONDS,
): void {
  if (keys.length === 0 || keys.some((k) => k.length === 0)) {
    throw new InboundWebhookError('not_configured');
  }
  if (f.timestamp === undefined || f.token === undefined || f.signature === undefined) {
    throw new InboundWebhookError('missing_signature');
  }
  if (!TIMESTAMP.test(f.timestamp) || !TOKEN.test(f.token)) {
    throw new InboundWebhookError('malformed_form');
  }
  const sig = f.signature.toLowerCase();
  if (!HEX64.test(sig)) throw new InboundWebhookError('bad_signature');
  const given = Buffer.from(sig, 'hex');
  let matched = false;
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(`${f.timestamp}${f.token}`).digest();
    // Both are 32 bytes (HEX64), so timingSafeEqual never throws; every key is tried.
    if (timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) throw new InboundWebhookError('bad_signature');
  // Whole seconds compared as integers (TIMESTAMP guarantees digits only).
  const age = BigInt(Math.trunc(nowSeconds)) - BigInt(f.timestamp);
  const tolerance = BigInt(Math.trunc(toleranceSeconds));
  if (age > tolerance || age < -tolerance) {
    throw new InboundWebhookError('stale_timestamp');
  }
}

export interface FormPart {
  readonly name: string;
  readonly filename: string | null;
  readonly data: Buffer;
}

function boundaryOf(contentType: string): string {
  const [type = '', ...params] = contentType.split(';').map((s) => s.trim());
  if (type.toLowerCase() !== 'multipart/form-data') throw new InboundWebhookError('malformed_form');
  for (const p of params) {
    const m = /^boundary\s*=\s*(?:"([^"]{1,70})"|([^\s";]{1,70}))$/i.exec(p);
    if (m) return m[1] ?? m[2] ?? '';
  }
  throw new InboundWebhookError('malformed_form');
}

function dispositionParam(header: string, key: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${key}="([^"]*)"`, 'i').exec(header);
  if (m) return m[1] ?? '';
  const bare = new RegExp(`(?:^|;)\\s*${key}=([^\\s";]+)`, 'i').exec(header);
  return bare ? (bare[1] ?? '') : null;
}

/**
 * Parse multipart/form-data (RFC 7578) from bytes, keeping every value octet-exact (raw MIME may
 * hold 8-bit bytes, RQ-0181 F2). At most 32 parts and 8 KiB of headers per part; anything
 * malformed or truncated is refused. The caller bounds the body size before calling.
 */
export function parseMultipartForm(body: Buffer, contentType: string): FormPart[] {
  const boundary = boundaryOf(contentType);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  // The first delimiter may start the body without the leading CRLF.
  const first = Buffer.from(`--${boundary}`);
  if (!body.subarray(0, first.length).equals(first))
    throw new InboundWebhookError('malformed_form');
  let pos = first.length;
  const parts: FormPart[] = [];
  for (;;) {
    // After a delimiter: "--" closes the form, CRLF starts a part (transport padding ignored).
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts;
    while (body[pos] === 0x20 || body[pos] === 0x09) pos++;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a)
      throw new InboundWebhookError('malformed_form');
    pos += 2;
    if (parts.length === MAX_PARTS) throw new InboundWebhookError('malformed_form');
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0 || headerEnd - pos > MAX_PART_HEADER_BYTES) {
      throw new InboundWebhookError('malformed_form');
    }
    const headers = body.subarray(pos, headerEnd).toString('latin1').split('\r\n');
    const disposition = headers
      .map((h) => /^content-disposition\s*:\s*(.*)$/i.exec(h)?.[1])
      .find((v) => v !== undefined);
    if (!disposition || !/^form-data\s*(;|$)/i.test(disposition)) {
      throw new InboundWebhookError('malformed_form');
    }
    const name = dispositionParam(disposition, 'name');
    if (name === null || name === '') throw new InboundWebhookError('malformed_form');
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next < 0) throw new InboundWebhookError('malformed_form');
    parts.push({
      name,
      filename: dispositionParam(disposition, 'filename'),
      data: body.subarray(dataStart, next),
    });
    pos = next + delimiter.length;
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new inbound-address token: 26 base32 characters (130 random bits). */
export function newInboundToken(): string {
  const bytes = randomBytes(17); // 136 bits; 26 × 5 = 130 are used
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export const inboundAddress = (token: string, domain: string): string =>
  `bills-${token}@${domain.toLowerCase()}`;

/** The token of a recipient `bills-<token>@<domain>`, or null for anything else (one address only). */
export function inboundTokenOf(recipient: string, domain: string): string | null {
  const m = /^bills-([a-z2-7]{26})@([a-z0-9.-]{1,253})$/.exec(recipient.trim().toLowerCase());
  if (!m || m[2] !== domain.toLowerCase()) return null;
  return m[1] ?? null;
}

/** The company's active inbound-address token, created on first use. */
export async function ensureInboxAddress(
  trx: Trx,
  c: { companyId: string; createdBy?: string },
): Promise<string> {
  const companyId = c.companyId.toLowerCase();
  const existing = await trx
    .selectFrom('app.bill_inbox_address')
    .select('token')
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (existing) return existing.token;
  const token = newInboundToken();
  await trx
    .insertInto('app.bill_inbox_address')
    .values({
      id: randomUUID(),
      company_id: companyId,
      token,
      created_by: c.createdBy ?? null,
    })
    .execute();
  return token;
}

/** Replace the company's inbound address: the old token stops routing at once (superseded). */
export async function rotateInboxAddress(
  trx: Trx,
  c: { companyId: string; createdBy?: string },
): Promise<string> {
  const companyId = c.companyId.toLowerCase();
  await trx
    .updateTable('app.bill_inbox_address')
    .set({ status: 'superseded' })
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .execute();
  return ensureInboxAddress(trx, c);
}

export interface MailgunInboundOptions {
  readonly signingKeys: readonly string[];
  readonly inboundDomain: string;
  readonly nowSeconds?: number;
}

export interface InboundOutcome {
  readonly outcome: 'created' | 'duplicate';
}

/** The single value of a field; a repeated signature field is refused (no ambiguity). */
function single(parts: readonly FormPart[], name: string): string | undefined {
  const found = parts.filter((p) => p.name === name);
  if (found.length > 1) throw new InboundWebhookError('malformed_form');
  return found[0]?.data.toString('utf8');
}

/**
 * Handle one Mailgun forward() POST whose body (≤ INBOUND_BODY_LIMIT) has been read. Order:
 * form → signature → timestamp → route shape → recipient routing → replay record → ingest.
 */
export async function receiveMailgunInbound(
  db: Kysely<Database>,
  req: { body: Buffer; contentType: string },
  opts: MailgunInboundOptions,
): Promise<InboundOutcome> {
  if (opts.signingKeys.length === 0 || opts.inboundDomain === '') {
    throw new InboundWebhookError('not_configured');
  }
  const parts = parseMultipartForm(req.body, req.contentType);
  const token = single(parts, 'token');
  verifyMailgunSignature(
    { timestamp: single(parts, 'timestamp'), token, signature: single(parts, 'signature') },
    opts.signingKeys,
    opts.nowSeconds ?? Math.floor(Date.now() / 1000),
  );
  const mime = parts.filter((p) => p.name === 'body-mime');
  if (mime.length !== 1 || parts.some((p) => p.name === 'attachments')) {
    throw new InboundWebhookError('misconfigured_route');
  }
  const recipients = parts.filter((p) => p.name === 'recipient');
  const routeToken =
    recipients.length === 1
      ? inboundTokenOf(recipients[0]?.data.toString('utf8') ?? '', opts.inboundDomain)
      : null;
  if (routeToken === null) throw new InboundWebhookError('unknown_recipient');
  const route = (
    await sql<{ tenant_id: string; company_id: string }>`
      SELECT tenant_id::text, company_id::text FROM app.bill_inbox_route(${routeToken})`.execute(db)
  ).rows;
  const target = route.length === 1 ? route[0] : undefined;
  if (!target) throw new InboundWebhookError('unknown_recipient');

  return withTenant(db, target.tenant_id, async (trx) => {
    // Single use, before the message is parsed. A conflicting insert waits for a concurrent
    // holder of the same token and then finds it (unique index across tenants).
    const receipt = await trx
      .insertInto('app.inbound_webhook_receipt')
      .values({ company_id: target.company_id, provider: 'mailgun', provider_token: token ?? '' })
      .onConflict((oc) => oc.columns(['provider', 'provider_token']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!receipt) throw new InboundWebhookError('replayed');
    let item;
    try {
      item = await ingestBillEmail(trx, {
        companyId: target.company_id,
        raw: mime[0]?.data ?? Buffer.alloc(0),
      });
    } catch (e) {
      // Throwing rolls the receipt back too: nothing of a refused message is kept.
      if (e instanceof InboxError) throw new InboundWebhookError('message_refused');
      throw e;
    }
    await trx
      .updateTable('app.inbound_webhook_receipt')
      .set({ inbox_item_id: item.id })
      .where('id', '=', receipt.id)
      .execute();
    return { outcome: item.replayed ? 'duplicate' : 'created' };
  });
}
