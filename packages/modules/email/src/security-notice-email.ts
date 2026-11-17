/**
 * Security notice dispatcher (T-0197, ADR-0092, RQ-0174).
 *
 * The database writes durable notices in the approving transaction:
 * - app.remittance_account_notice (0072, ADR-0086 L2) goes to each active Owner and Finance Admin
 *   when the invoice remittance account changes;
 * - app.bank_detail_change_notice (0025, design §6.5 rule 2) goes to a supplier's previous
 *   remittance contact when its bank details change.
 * `dispatchSecurityNotices` sends one tenant's due notices, as lf_app under RLS. Each notice is
 * handled in its own tenant transaction, locked FOR UPDATE SKIP LOCKED, so two dispatchers never
 * send the same notice at once. Every attempt is recorded in app.security_notice_delivery (one
 * `sent` row per notice at most, by a unique index), and the notice moves to `sent` or `failed`.
 * A failed attempt n is due again after min(6 h, 1 min · 2^(n−1)); there is no give-up.
 * `no_recipient` notices are never selected. Sending is at-least-once across a crash between the
 * SMTP accept and the commit (ADR-0046 rule 3).
 *
 * Content (RQ-0174): plain text only, no links, no HTML; account numbers only as their last 3
 * digits (the payloads hold nothing more); "if you did not expect this" guidance that sends the
 * reader to a contact they already know. Text a requester could have typed (bank account labels,
 * names) is made inert: one line, at most 80 characters, URL schemes and `www.` broken.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { EmailSender } from './sender.ts';

type Trx = Transaction<Database>;

export type SecurityNoticeKind = 'remittance_account_changed' | 'bank_details_changed';

const KINDS: readonly SecurityNoticeKind[] = ['remittance_account_changed', 'bank_details_changed'];
const FIRST_DELAY_SECONDS = 60;
export const SECURITY_NOTICE_MAX_DELAY_SECONDS = 6 * 60 * 60;
const DEFAULT_ZONE = 'Australia/Sydney';
const DEFAULT_LIMIT = 100;

/** Seconds to wait after failed attempt `attempt` (1-based): 1 min doubling, capped at 6 h. */
export function securityNoticeRetryDelaySeconds(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${String(attempt)}`);
  }
  const exponent = Math.min(attempt - 1, 20);
  return Math.min(SECURITY_NOTICE_MAX_DELAY_SECONDS, FIRST_DELAY_SECONDS * 2 ** exponent);
}

/**
 * Make text a requester may have typed safe to print in a security email: control characters
 * removed, whitespace collapsed to one line, URL schemes and `www.` broken, at most `max`
 * characters.
 */
export function inertText(value: unknown, max = 80): string {
  if (typeof value !== 'string') return '';
  const line = value
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/:\/\//g, '[:]//')
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}[.]`);
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** "BSB 062-000, account ending in 321" from a masked payload account (`***321`). */
function accountLine(account: unknown, withLabel: boolean): string | null {
  const a = obj(account);
  if (!a) return null;
  const masked = typeof a['account_number'] === 'string' ? a['account_number'] : '';
  const last = /(\d{1,4})$/.exec(masked)?.[1] ?? 'unknown';
  const bsb = inertText(a['bsb'], 20);
  const label = withLabel ? inertText(a['name']) : '';
  return [label, bsb ? `BSB ${bsb}` : '', `account ending in ${last}`]
    .filter((p) => p.length > 0)
    .join(', ');
}

function when(value: unknown, zone: string): string {
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return 'an unknown time';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(d);
}

function person(value: unknown): string {
  const p = obj(value);
  if (!p) return 'unknown';
  const name = inertText(p['name']) || 'unknown';
  const email = inertText(p['email'], 120);
  return email ? `${name} (${email})` : name;
}

export interface RenderedNotice {
  readonly subject: string;
  readonly text: string;
}

/** The email to an Owner or Finance Admin about an approved remittance account change. */
export function renderRemittanceAccountNotice(n: {
  recipientName: string | null;
  payload: Record<string, unknown>;
  zone: string;
}): RenderedNotice {
  const p = n.payload;
  const company = inertText(p['company_name']) || 'your company';
  const lines = [
    `Hello ${inertText(n.recipientName) || 'there'},`,
    '',
    `This is an automatic security notice from LedgerForce for ${company}.`,
    '',
    `The bank account printed on invoices of ${company}, which customers pay into, was changed.`,
    '',
    `New account:      ${accountLine(p['account'], true) ?? 'none (invoices no longer show bank details)'}`,
    `Previous account: ${accountLine(p['previous_account'], true) ?? 'none'}`,
    `Requested by:     ${person(p['requested_by'])} on ${when(p['requested_at'], n.zone)}`,
    `Approved by:      ${person(p['approved_by'])} on ${when(p['approved_at'], n.zone)}`,
    ...(p['self_approved'] === true
      ? ['', 'The requester approved their own change (small-team mode).']
      : []),
    '',
    'Only the last 3 digits of account numbers are shown. This email contains no links.',
    '',
    'If you expected this change, you do not need to do anything.',
    '',
    'If you did not expect this change:',
    '- Do not reply to this email, and do not use any link or phone number sent to you about it.',
    '- Call the requester or the approver on a phone number you already know, and confirm it.',
    '- Sign in to LedgerForce the way you usually do (your own bookmark or the address you',
    '  type), check the remittance account in the settings, and if the change was not',
    '  authorised, request and approve a change back to the correct account.',
    '- If customers may have paid into the wrong account, contact your bank straight away.',
    '',
    `You receive this because you are an Owner or Finance Admin of ${company}.`,
    '',
  ];
  return {
    subject: `Security notice: the remittance bank account of ${company} was changed`,
    text: lines.join('\n'),
  };
}

/** The email to a supplier's previous remittance contact about a verified bank-detail change. */
export function renderBankDetailNotice(n: {
  recipientName: string | null;
  companyName: string;
  partyName: string;
  payload: Record<string, unknown>;
  zone: string;
}): RenderedNotice {
  const p = n.payload;
  const company = inertText(n.companyName) || 'Your customer';
  const party = inertText(n.partyName) || 'your business';
  const lines = [
    `Hello ${inertText(n.recipientName) || 'there'},`,
    '',
    `This is an automatic security notice from ${company}, sent by its accounting system`,
    '(LedgerForce).',
    '',
    `${company} keeps a record of the bank account it pays ${party} into.`,
    `That record was changed on ${when(p['verified_at'], n.zone)}.`,
    '',
    `New account:      ${accountLine(p['new_account'], false) ?? 'unknown'}`,
    `Previous account: ${accountLine(p['previous_account'], false) ?? 'none on record'}`,
    '',
    'Only the last 3 digits of account numbers are shown. This email contains no links and',
    'asks you for nothing.',
    '',
    `If ${party} asked for this change, you do not need to do anything.`,
    '',
    `If you did not ask for it, contact ${company} straight away on a phone number you`,
    'already hold for them. Do not use a phone number, link or bank details from any email,',
    `including this one. ${company} will not pay into the new account before`,
    `${when(p['payable_from'], n.zone)}.`,
    '',
    `You receive this because you are the remittance contact of ${party} in the records of`,
    `${company}.`,
    '',
  ];
  return {
    subject: `Security notice: the bank details ${company} holds for ${party} were changed`,
    text: lines.join('\n'),
  };
}

/** A secret-free summary of a send failure (nodemailer sets `code` and `responseCode`). */
function failureOf(error: unknown): {
  error_name: string;
  error_code: string | null;
  smtp_code: number | null;
  error_message: string;
} {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
  const name =
    typeof e['name'] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(e['name'])
      ? e['name']
      : 'Error';
  const code =
    typeof e['code'] === 'string' && e['code'].length > 0 ? e['code'].slice(0, 100) : null;
  const rc = e['responseCode'];
  const smtp = typeof rc === 'number' && Number.isInteger(rc) && rc >= 200 && rc <= 599 ? rc : null;
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
  return { error_name: name, error_code: code, smtp_code: smtp, error_message: message };
}

interface DueNotice {
  id: string;
  recipient_name: string | null;
  recipient_email: string;
  payload: Record<string, unknown>;
  company_name: string | null;
  party_name: string | null;
}

/** The next due notice of a kind, locked; another dispatcher's locked rows are skipped. */
async function nextDue(trx: Trx, kind: SecurityNoticeKind, now: Date): Promise<DueNotice | null> {
  const { rows } =
    kind === 'remittance_account_changed'
      ? await sql<DueNotice>`
          SELECT n.id, n.recipient_name, n.recipient_email, n.payload,
                 NULL::text AS company_name, NULL::text AS party_name
            FROM app.remittance_account_notice n
           WHERE n.status IN ('pending', 'failed')
             AND NOT EXISTS (
                   SELECT 1 FROM app.security_notice_delivery d
                    WHERE d.tenant_id = n.tenant_id AND d.remittance_notice_id = n.id
                      AND (d.outcome = 'sent' OR d.next_attempt_at > ${now}))
           ORDER BY n.created_at, n.id
           LIMIT 1
             FOR UPDATE OF n SKIP LOCKED`.execute(trx)
      : await sql<DueNotice>`
          SELECT n.id, n.recipient_name, n.recipient_email, n.payload,
                 coalesce(co.legal_name, co.name) AS company_name, p.legal_name AS party_name
            FROM app.bank_detail_change_notice n
            JOIN app.bank_detail_change c ON c.tenant_id = n.tenant_id AND c.id = n.change_id
            JOIN app.party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
            JOIN app.company co ON co.tenant_id = c.tenant_id AND co.id = c.company_id
           WHERE n.status IN ('pending', 'failed')
             AND NOT EXISTS (
                   SELECT 1 FROM app.security_notice_delivery d
                    WHERE d.tenant_id = n.tenant_id AND d.bank_detail_notice_id = n.id
                      AND (d.outcome = 'sent' OR d.next_attempt_at > ${now}))
           ORDER BY n.created_at, n.id
           LIMIT 1
             FOR UPDATE OF n SKIP LOCKED`.execute(trx);
  return rows[0] ?? null;
}

/** The tenant's report time zone (latest app.sod_settings row), else Australia/Sydney. */
async function reportZone(trx: Trx): Promise<string> {
  const { rows } = await sql<{ report_timezone: string }>`
    SELECT report_timezone FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(
    trx,
  );
  const zone = rows[0]?.report_timezone ?? DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
}

/** Send one due notice of `kind` and record the attempt; null when none is due. */
async function dispatchOne(
  trx: Trx,
  kind: SecurityNoticeKind,
  sender: EmailSender,
  now: Date,
): Promise<'sent' | 'failed' | null> {
  const n = await nextDue(trx, kind, now);
  if (!n) return null;
  const zone = await reportZone(trx);
  const message =
    kind === 'remittance_account_changed'
      ? renderRemittanceAccountNotice({
          recipientName: n.recipient_name,
          payload: n.payload,
          zone,
        })
      : renderBankDetailNotice({
          recipientName: n.recipient_name,
          companyName: n.company_name ?? '',
          partyName: n.party_name ?? '',
          payload: n.payload,
          zone,
        });
  const idColumn =
    kind === 'remittance_account_changed' ? 'remittance_notice_id' : 'bank_detail_notice_id';
  const previous = await trx
    .selectFrom('app.security_notice_delivery')
    .select(sql<number>`count(*)::int`.as('n'))
    .where(idColumn, '=', n.id)
    .executeTakeFirstOrThrow();
  const attempt = previous.n + 1;
  const table =
    kind === 'remittance_account_changed'
      ? ('app.remittance_account_notice' as const)
      : ('app.bank_detail_change_notice' as const);
  const record = {
    notice_kind: kind,
    [idColumn]: n.id,
    attempt,
    to_addr: n.recipient_email,
    subject: message.subject,
  };
  let messageId: string;
  try {
    messageId = await sender.send({ to: [n.recipient_email], ...message });
  } catch (error) {
    const retryAt = new Date(now.getTime() + securityNoticeRetryDelaySeconds(attempt) * 1000);
    await trx
      .insertInto('app.security_notice_delivery')
      .values({ ...record, outcome: 'failed', next_attempt_at: retryAt, ...failureOf(error) })
      .execute();
    await sql`UPDATE ${sql.table(table)} SET status = 'failed' WHERE id = ${n.id}`.execute(trx);
    return 'failed';
  }
  await trx
    .insertInto('app.security_notice_delivery')
    .values({ ...record, outcome: 'sent', message_id: messageId.slice(0, 500) })
    .execute();
  await sql`UPDATE ${sql.table(table)} SET status = 'sent', sent_at = clock_timestamp()
             WHERE id = ${n.id}`.execute(trx);
  return 'sent';
}

export interface SecurityNoticeDispatch {
  readonly sent: number;
  readonly failed: number;
}

/**
 * Send the due security notices of one tenant (each in its own tenant transaction). `now` decides
 * which failed notices are due and when they retry; `limit` bounds the attempts per kind.
 */
export async function dispatchSecurityNotices(
  db: Kysely<Database>,
  tenantId: string,
  deps: { sender: EmailSender; now?: Date; limit?: number },
): Promise<SecurityNoticeDispatch> {
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? DEFAULT_LIMIT;
  let sent = 0;
  let failed = 0;
  for (const kind of KINDS) {
    for (let i = 0; i < limit; i += 1) {
      const r = await withTenant(db, tenantId, (trx) => dispatchOne(trx, kind, deps.sender, now));
      if (r === null) break;
      if (r === 'sent') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}
