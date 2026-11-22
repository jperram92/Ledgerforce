/**
 * Failed security notices and retry-now (T-0209, ADR-0097, RQ-0179).
 *
 * The dispatcher (T-0197, ADR-0092) never gives up on a failed notice; it retries every 6 h at
 * most. These functions put the failures in front of an administrator:
 * - `listFailedSecurityNotices` returns the tenant's notices in `failed` status with the latest
 *   attempt's error, the attempt count and the next attempt time. Recipients are masked to their
 *   first character and domain, also inside the SMTP error text; account numbers come only from
 *   the masked payload (last 3 digits).
 * - `requestSecurityNoticeRetry` appends an app.security_notice_retry row that releases the latest
 *   failed attempt, so the notice is due at the next dispatch. Nothing is updated or deleted. One
 *   release per failed attempt: a second request (replay, double press, race) adds nothing and
 *   answers `created: false`.
 * Both run as lf_app inside the caller's tenant transaction (RLS).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { SecurityNoticeKind } from './security-notice-email.ts';

type Trx = Transaction<Database>;

export const SECURITY_NOTICE_KINDS: readonly SecurityNoticeKind[] = [
  'remittance_account_changed',
  'bank_details_changed',
];

export function isSecurityNoticeKind(k: string): k is SecurityNoticeKind {
  return (SECURITY_NOTICE_KINDS as readonly string[]).includes(k);
}

export interface FailedSecurityNotice {
  readonly kind: SecurityNoticeKind;
  readonly id: string;
  /** Whose notice: the company (remittance account) or the supplier (bank details). */
  readonly context: string;
  /** Last 3 digits of the new account, from the masked payload. */
  readonly accountLast3: string | null;
  /** The recipient's address, masked (`o•••@example.com`). */
  readonly recipient: string;
  readonly createdAt: Date;
  readonly attempts: number;
  readonly lastAttemptAt: Date;
  readonly lastSmtpCode: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  /** When the dispatcher's backoff would retry; a released notice goes at the next dispatch. */
  readonly nextAttemptAt: Date;
  /** An administrator released the latest failed attempt; it has not been retried yet. */
  readonly retryRequested: boolean;
}

export class SecurityNoticeRetryRefused extends Error {
  readonly reason: 'NOT_FOUND' | 'NOT_FAILED';
  constructor(reason: 'NOT_FOUND' | 'NOT_FAILED') {
    super(`security notice retry refused: ${reason}`);
    this.reason = reason;
    this.name = 'SecurityNoticeRetryRefused';
  }
}

const MASK = '•••';
const EMAIL = /[^\s@<>()[\]",;:]+@([^\s@<>()[\]",;:]+)/g;

/** `oscar.owner@example.com` → `o•••@example.com` (first character and domain only). */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return MASK;
  return `${address.slice(0, 1)}${MASK}${address.slice(at)}`;
}

/** Every address inside a text masked the same way (SMTP replies often quote the recipient). */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL, (m) => maskEmailAddress(m));
}

function last3(account: unknown): string | null {
  if (typeof account !== 'object' || account === null) return null;
  const n = (account as Record<string, unknown>)['account_number'];
  if (typeof n !== 'string') return null;
  return /(\d{3})$/.exec(n)?.[1] ?? null;
}

interface Row {
  kind: SecurityNoticeKind;
  id: string;
  context: string | null;
  account: unknown;
  recipient_email: string;
  created_at: Date;
  attempts: number;
  last_attempt_at: Date;
  smtp_code: number | null;
  error_code: string | null;
  error_message: string | null;
  next_attempt_at: Date;
  latest_attempt: number;
  retry_requested: boolean;
}

/** The failed notices of the tenant, oldest first; `only` narrows to one notice. */
async function failedRows(
  trx: Trx,
  only?: { kind: SecurityNoticeKind; id: string },
): Promise<Row[]> {
  const kindFilter = only ? sql`AND f.kind = ${only.kind} AND f.id = ${only.id}` : sql``;
  const { rows } = await sql<Row>`
    WITH f AS (
      SELECT 'remittance_account_changed'::text AS kind, n.id, n.created_at, n.recipient_email,
             coalesce(n.payload->>'company_name', co.legal_name, co.name) AS context,
             n.payload->'account' AS account
        FROM app.remittance_account_notice n
        JOIN app.company co ON co.tenant_id = n.tenant_id AND co.id = n.company_id
       WHERE n.status = 'failed'
      UNION ALL
      SELECT 'bank_details_changed'::text, n.id, n.created_at, n.recipient_email,
             p.legal_name, n.payload->'new_account'
        FROM app.bank_detail_change_notice n
        JOIN app.bank_detail_change c ON c.tenant_id = n.tenant_id AND c.id = n.change_id
        JOIN app.party p ON p.tenant_id = c.tenant_id AND p.id = c.party_id
       WHERE n.status = 'failed'
    )
    SELECT f.kind, f.id, f.context, f.account, f.recipient_email, f.created_at,
           d.attempt AS attempts, d.attempt AS latest_attempt, d.attempted_at AS last_attempt_at,
           d.smtp_code, d.error_code, d.error_message, d.next_attempt_at,
           EXISTS (SELECT 1 FROM app.security_notice_retry r
                    WHERE (r.remittance_notice_id = f.id OR r.bank_detail_notice_id = f.id)
                      AND r.after_attempt >= d.attempt) AS retry_requested
      FROM f
      JOIN LATERAL (
             SELECT d.* FROM app.security_notice_delivery d
              WHERE d.remittance_notice_id = f.id OR d.bank_detail_notice_id = f.id
              ORDER BY d.attempt DESC
              LIMIT 1) d ON d.outcome = 'failed'
     WHERE true ${kindFilter}
     ORDER BY f.created_at, f.id`.execute(trx);
  return rows;
}

const view = (r: Row): FailedSecurityNotice => ({
  kind: r.kind,
  id: r.id,
  context: r.context ?? '',
  accountLast3: last3(r.account),
  recipient: maskEmailAddress(r.recipient_email),
  createdAt: r.created_at,
  attempts: r.attempts,
  lastAttemptAt: r.last_attempt_at,
  lastSmtpCode: r.smtp_code,
  lastErrorCode: r.error_code,
  lastErrorMessage: r.error_message === null ? null : maskEmailsIn(r.error_message),
  nextAttemptAt: r.next_attempt_at,
  retryRequested: r.retry_requested,
});

/** The tenant's failed security notices, oldest first, masked. */
export async function listFailedSecurityNotices(trx: Trx): Promise<FailedSecurityNotice[]> {
  return (await failedRows(trx)).map(view);
}

/**
 * Release the latest failed attempt of a notice for an immediate retry. `created` is false when
 * that attempt was already released. Refused NOT_FOUND (no such notice in the tenant) or
 * NOT_FAILED (pending, sent or without a recipient).
 */
export async function requestSecurityNoticeRetry(
  trx: Trx,
  r: { kind: SecurityNoticeKind; noticeId: string; requestedBy: string },
): Promise<{ created: boolean; afterAttempt: number; notice: FailedSecurityNotice }> {
  const table =
    r.kind === 'remittance_account_changed'
      ? sql`app.remittance_account_notice`
      : sql`app.bank_detail_change_notice`;
  // Lock the notice so a dispatch in flight finishes first (it holds FOR UPDATE while sending).
  const { rows: found } = await sql<{ status: string }>`
    SELECT status FROM ${table} WHERE id = ${r.noticeId} FOR UPDATE`.execute(trx);
  if (!found[0]) throw new SecurityNoticeRetryRefused('NOT_FOUND');
  const [row] = await failedRows(trx, { kind: r.kind, id: r.noticeId });
  if (found[0].status !== 'failed' || !row) throw new SecurityNoticeRetryRefused('NOT_FAILED');
  const idColumn =
    r.kind === 'remittance_account_changed' ? 'remittance_notice_id' : 'bank_detail_notice_id';
  const inserted = await trx
    .insertInto('app.security_notice_retry')
    .values({
      notice_kind: r.kind,
      [idColumn]: r.noticeId,
      after_attempt: row.latest_attempt,
      requested_by: r.requestedBy,
    })
    .onConflict((oc) => oc.columns(['tenant_id', idColumn, 'after_attempt']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return {
    created: inserted !== undefined,
    afterAttempt: row.latest_attempt,
    notice: view({ ...row, retry_requested: true }),
  };
}
