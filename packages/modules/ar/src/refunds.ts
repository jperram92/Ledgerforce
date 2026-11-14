/**
 * Customer refunds (T-0055, UC-11 step 3, design §3.8, GP-006, postings.md Q9, DL-0305).
 *
 * createCustomerRefund records a refund of a customer's credit balance (status requested). The
 * amount may not exceed the party's available credit: its AR credit balance (the sum of its open
 * AR items, when negative) less the refunds already requested. Method `bank_batch` is paid in the
 * next supplier payment batch, to the customer's verified bank account after the same cooling-off
 * as suppliers (Q9; @ledgerforce/ap payment-batches.ts); method `stripe` is T-0122.
 *
 * payCustomerRefund posts GP-006 through the engine when the money has left the bank (the batch
 * confirmation calls it): one entry per refund, source ar_refund, source id = the refund id,
 *   Dr AR control (customer) / Cr the bank account the batch paid from,
 * then allocates the refund's open item (+amount) to the customer's credit items, oldest first, so
 * the credit is cleared (GP-006 subledger). The refund row records its entry (migration 0049
 * guard: only its own posted ar_refund entry can mark it paid). Money is decimal strings.
 *
 * Approval (T-0152, ADR-0074, migration 0070): a refund is paid only after another person approves
 * it (maker-checker; SOD_REFUND_SELF_APPROVAL is checked by the API guard). approveCustomerRefund
 * records the append-only approval; the payment batch takes only approved refunds and
 * payCustomerRefund refuses an unapproved one (NOT_APPROVED); the database refuses both too.
 * previewCustomerRefundJournal is the engine's preview of the GP-006 entry, writing nothing.
 */
import type { Database } from '@ledgerforce/db';
import {
  allocate,
  nextNumber,
  post,
  preview,
  subledgerEntriesOf,
  type PostingLineInput,
  type PostOptions,
} from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export const REFUND_NUMBER_SERIES = 'ar_refund_document';
export const REFUND_SOURCE_TYPE = 'ar_refund';

export type RefundMethod = 'bank_batch' | 'stripe';
export type RefundErrorCode =
  | 'INVALID_REFUND'
  | 'REFUND_EXCEEDS_CREDIT'
  | 'METHOD_NOT_AVAILABLE'
  | 'NOT_PAYABLE'
  | 'NOT_APPROVED'
  | 'NOT_APPROVABLE'
  | 'REFUND_NOT_FOUND'
  | 'PARTY_NOT_FOUND'
  | 'BANK_ACCOUNT_REQUIRED';

export class RefundError extends Error {
  readonly code: RefundErrorCode;
  constructor(code: RefundErrorCode, message: string) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
  }
}

export interface CustomerRefundInput {
  readonly companyId: string;
  /** Client-chosen uuid; a repeat returns the stored refund. */
  readonly id: string;
  readonly partyId: string;
  /** YYYY-MM-DD: the refund is payable from this date. */
  readonly refundDate: string;
  /** Decimal string > 0, ≤ 2 decimals. */
  readonly amount: string;
  readonly method: RefundMethod;
  readonly reason?: string;
  readonly createdBy?: string;
}

export interface CustomerRefundView {
  readonly refundId: string;
  readonly refundNo: string;
  readonly partyId: string;
  readonly refundDate: string;
  readonly amount: string;
  readonly method: RefundMethod;
  readonly status: 'requested' | 'paid' | 'cancelled';
  readonly entryId: string | null;
  readonly paidOn: string | null;
  readonly createdBy: string | null;
  /** ADR-0074: `approved` once another person approved it; a batch pays only approved refunds. */
  readonly approval: 'pending' | 'approved';
  readonly approvedBy: string | null;
  /** ISO timestamp of the approval. */
  readonly approvedAt: string | null;
  readonly replayed: boolean;
}

export interface CustomerCredit {
  /** Sum of the party's open AR items (negative = the customer is in credit). */
  readonly balance: string;
  /** Refunds requested and not yet paid. */
  readonly requested: string;
  /** What can still be refunded: max(0, −balance − requested). */
  readonly available: string;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const isDate = (d: string) =>
  DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** One refund of the company. */
export async function getCustomerRefund(
  trx: Trx,
  companyId: string,
  refundId: string,
  replayed = false,
): Promise<CustomerRefundView> {
  const cid = companyId.toLowerCase();
  if (!UUID_RE.test(refundId) || !UUID_RE.test(cid))
    throw new RefundError('REFUND_NOT_FOUND', `refund ${refundId} is not in company ${cid}`);
  const r = await trx
    .selectFrom('app.customer_refund as r')
    .leftJoin('app.customer_refund_approval as a', (j) =>
      j.onRef('a.tenant_id', '=', 'r.tenant_id').onRef('a.refund_id', '=', 'r.id'),
    )
    .select([
      'r.id',
      'r.refund_no',
      'r.party_id',
      'r.amount',
      'r.method',
      'r.status',
      'r.entry_id',
      'r.created_by',
      'a.approved_by',
      sql<string>`to_char(r.refund_date, 'YYYY-MM-DD')`.as('refund_date'),
      sql<string | null>`to_char(r.paid_on, 'YYYY-MM-DD')`.as('paid_on'),
      sql<
        string | null
      >`to_char(a.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
        'approved_at',
      ),
    ])
    .where('r.company_id', '=', cid)
    .where('r.id', '=', refundId.toLowerCase())
    .executeTakeFirst();
  if (!r) throw new RefundError('REFUND_NOT_FOUND', `refund ${refundId} is not in company ${cid}`);
  return {
    refundId: r.id,
    refundNo: r.refund_no,
    partyId: r.party_id,
    refundDate: r.refund_date,
    amount: numeric(r.amount),
    method: r.method,
    status: r.status,
    entryId: r.entry_id,
    paidOn: r.paid_on,
    createdBy: r.created_by,
    approval: r.approved_by ? 'approved' : 'pending',
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    replayed,
  };
}

/** The party's AR balance, refunds requested and the credit still refundable. */
export async function customerCredit(
  trx: Trx,
  companyId: string,
  partyId: string,
): Promise<CustomerCredit> {
  const cid = companyId.toLowerCase();
  const r = (
    await sql<{ balance: string; requested: string }>`
      SELECT
        (SELECT coalesce(sum(base_open_amount), 0)::text FROM app.subledger_entry
          WHERE company_id = ${cid} AND party_id = ${partyId}::uuid AND control_role = 'AR_CONTROL') AS balance,
        (SELECT coalesce(sum(amount), 0)::text FROM app.customer_refund
          WHERE company_id = ${cid} AND party_id = ${partyId}::uuid AND status = 'requested') AS requested`.execute(
      trx,
    )
  ).rows[0];
  const balance = new Decimal(r?.balance ?? '0');
  const requested = new Decimal(r?.requested ?? '0');
  return {
    balance: numeric(balance),
    requested: numeric(requested),
    available: numeric(Decimal.max(0, balance.negated().minus(requested))),
  };
}

const partyLock = (trx: Trx, companyId: string, partyId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${`ar-refund:${companyId}:${partyId}`}))`.execute(trx);

/** Request a refund of (part of) a customer's credit balance. */
export async function createCustomerRefund(
  trx: Trx,
  c: CustomerRefundInput,
): Promise<CustomerRefundView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.id)) throw new RefundError('INVALID_REFUND', 'the refund id is a uuid');
  if (!UUID_RE.test(c.partyId)) throw new RefundError('INVALID_REFUND', 'the party id is a uuid');
  const id = c.id.toLowerCase();
  const partyId = c.partyId.toLowerCase();
  await partyLock(trx, companyId, partyId);
  const existing = await trx
    .selectFrom('app.customer_refund')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (existing) return getCustomerRefund(trx, companyId, id, true);

  if (!isDate(c.refundDate))
    throw new RefundError('INVALID_REFUND', 'the refund date is YYYY-MM-DD');
  if (!AMOUNT_RE.test(c.amount) || !new Decimal(c.amount).gt(0)) {
    throw new RefundError('INVALID_REFUND', 'a refund is > 0 with at most 2 decimals');
  }
  const reason = c.reason?.trim();
  if (reason !== undefined && (reason.length < 1 || reason.length > 500)) {
    throw new RefundError('INVALID_REFUND', 'the reason is 1–500 characters');
  }
  if (c.method === 'stripe') {
    throw new RefundError(
      'METHOD_NOT_AVAILABLE',
      'refunds through Stripe are not available yet (T-0122); refund by payment batch',
    );
  }
  if (c.method !== 'bank_batch') {
    throw new RefundError('INVALID_REFUND', `unknown refund method ${JSON.stringify(c.method)}`);
  }
  const party = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', '=', partyId)
    .executeTakeFirst();
  if (!party) throw new RefundError('PARTY_NOT_FOUND', `party ${partyId} is not in this company`);
  const credit = await customerCredit(trx, companyId, partyId);
  if (new Decimal(c.amount).gt(credit.available)) {
    throw new RefundError(
      'REFUND_EXCEEDS_CREDIT',
      `refund ${numeric(c.amount)} exceeds the customer's refundable credit ${credit.available}`,
    );
  }
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.customer_refund')
    .values({
      id,
      company_id: companyId,
      refund_no: await nextNumber(trx, companyId, REFUND_NUMBER_SERIES),
      party_id: partyId,
      refund_date: c.refundDate,
      amount: numeric(c.amount),
      currency: company.base_currency,
      method: c.method,
      reason: reason ?? null,
      created_by: c.createdBy ?? null,
    })
    .execute();
  return getCustomerRefund(trx, companyId, id);
}

/**
 * Pay a requested bank refund: post GP-006 (Dr AR control / Cr `bankAccountId`) dated `paidOn`
 * and clear the customer's credit. A repeat returns the paid refund (`replayed`).
 */
export async function payCustomerRefund(
  trx: Trx,
  c: {
    companyId: string;
    refundId: string;
    /** YYYY-MM-DD the bank paid the refund; not before the refund date. */
    paidOn: string;
    /** The GL bank account the refund left from. */
    bankAccountId: string;
    /** e.g. the payment batch number, for the entry memo. */
    reference?: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<CustomerRefundView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.refundId)) throw new RefundError('INVALID_REFUND', 'the refund id is a uuid');
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  await partyLock(trx, companyId, before.partyId);
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.status === 'paid') return { ...r, replayed: true };
  if (r.status !== 'requested' || r.method !== 'bank_batch') {
    throw new RefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status} (${r.method})`);
  }
  if (r.approval !== 'approved') {
    throw new RefundError('NOT_APPROVED', `refund ${r.refundNo} is not approved (ADR-0074)`);
  }
  if (!isDate(c.paidOn) || c.paidOn < r.refundDate) {
    throw new RefundError(
      'INVALID_REFUND',
      `refund ${r.refundNo} cannot be paid on ${c.paidOn}, before its date ${r.refundDate}`,
    );
  }
  const credit = await customerCredit(trx, companyId, r.partyId);
  if (new Decimal(r.amount).gt(new Decimal(credit.balance).negated())) {
    throw new RefundError(
      'REFUND_EXCEEDS_CREDIT',
      `refund ${r.refundNo} of ${r.amount} exceeds the customer's credit balance ${credit.balance}`,
    );
  }
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-refund:${r.refundId}`,
      entryDate: c.paidOn,
      sourceType: REFUND_SOURCE_TYPE,
      sourceId: r.refundId,
      memo: `Customer refund ${r.refundNo}${c.reference ? ` ${c.reference}` : ''}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: refundJournal(r, c.bankAccountId),
    },
    opts,
  );
  // Clear the credit: the refund's open item against the customer's credit items, oldest first.
  const [refundItem] = await subledgerEntriesOf(trx, posted.entryId);
  if (!refundItem) throw new RefundError('NOT_PAYABLE', 'the refund entry has no open item');
  const credits = (
    await sql<{ id: string; open: string }>`
      SELECT id::text, (-open_amount)::text AS open FROM app.subledger_entry
       WHERE company_id = ${companyId} AND party_id = ${r.partyId}::uuid
         AND control_role = 'AR_CONTROL' AND open_amount < 0 AND document_date <= ${c.paidOn}::date
       ORDER BY document_date, created_at, id`.execute(trx)
  ).rows;
  let left = new Decimal(r.amount);
  for (const [i, item] of credits.entries()) {
    if (left.lte(0)) break;
    const amount = Decimal.min(left, item.open);
    await allocate(trx, {
      companyId,
      idempotencyKey: `ar-refund-alloc:${r.refundId}:${String(i + 1)}`,
      fromEntryId: refundItem.id,
      toEntryId: item.id,
      amount: numeric(amount),
      allocationDate: c.paidOn,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
    });
    left = left.minus(amount);
  }
  await trx
    .updateTable('app.customer_refund')
    .set({
      status: 'paid',
      entry_id: posted.entryId,
      paid_on: c.paidOn,
      updated_at: sql`clock_timestamp()`,
    })
    .where('company_id', '=', companyId)
    .where('id', '=', r.refundId)
    .execute();
  return getCustomerRefund(trx, companyId, r.refundId);
}

/** GP-006: Dr AR control (customer) / Cr the bank account. Shared by payment and preview. */
function refundJournal(r: CustomerRefundView, bankAccountId: string): PostingLineInput[] {
  return [
    { account: { role: 'AR_CONTROL' }, debit: r.amount, partyId: r.partyId, memo: r.refundNo },
    { account: { id: bankAccountId }, credit: r.amount },
  ];
}

/**
 * Approve a requested refund (ADR-0074). The caller (the API's SoD guard) has already refused the
 * refund's creator (SOD_REFUND_SELF_APPROVAL). A repeat returns the approved refund (`replayed`).
 */
export async function approveCustomerRefund(
  trx: Trx,
  c: { companyId: string; refundId: string; approvedBy: string },
): Promise<CustomerRefundView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.approvedBy))
    throw new RefundError('INVALID_REFUND', 'the approver is a user id');
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  await partyLock(trx, companyId, before.partyId);
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.approval === 'approved') return { ...r, replayed: true };
  if (r.status !== 'requested') {
    throw new RefundError('NOT_APPROVABLE', `refund ${r.refundNo} is ${r.status}`);
  }
  await trx
    .insertInto('app.customer_refund_approval')
    .values({ company_id: companyId, refund_id: r.refundId, approved_by: c.approvedBy })
    .execute();
  return getCustomerRefund(trx, companyId, r.refundId);
}

export interface RefundJournalPreview {
  readonly entryDate: string;
  readonly requestedDate: string;
  readonly redirected: boolean;
  readonly needsOverride: boolean;
  readonly baseCurrency: string;
  readonly total: string;
  /** Where the bank line comes from (ADR-0074): chosen, the paying batch, or the only bank account. */
  readonly bankAccountSource: 'chosen' | 'batch' | 'only_bank_account';
  readonly lines: readonly {
    readonly lineNo: number;
    readonly accountId: string;
    readonly accountCode: string;
    readonly accountName: string;
    readonly accountType: string;
    readonly debit: string;
    readonly credit: string;
    readonly partyId: string | null;
  }[];
}

/** The GL bank account GP-006 will credit (ADR-0074): chosen, else the paying batch's, else the only one. */
async function refundBankAccount(
  trx: Trx,
  companyId: string,
  refundId: string,
  chosen: string | undefined,
): Promise<{ id: string; source: RefundJournalPreview['bankAccountSource'] }> {
  if (chosen !== undefined) {
    if (!UUID_RE.test(chosen))
      throw new RefundError('INVALID_REFUND', 'the bank account is a GL account id');
    return { id: chosen.toLowerCase(), source: 'chosen' };
  }
  const batch = (
    await sql<{ account_id: string }>`
      SELECT b.account_id::text FROM app.payment_batch_refund i
        JOIN app.payment_batch b ON b.tenant_id = i.tenant_id AND b.id = i.batch_id
       WHERE i.company_id = ${companyId} AND i.refund_id = ${refundId}::uuid
         AND i.excluded_reason IS NULL AND b.status <> 'cancelled'`.execute(trx)
  ).rows[0];
  if (batch) return { id: batch.account_id, source: 'batch' };
  const banks = (
    await sql<{ gl: string }>`
      SELECT gl_account_id::text AS gl FROM app.bank_account
       WHERE company_id = ${companyId} AND status = 'active'`.execute(trx)
  ).rows;
  const [only] = banks;
  if (banks.length !== 1 || !only) {
    throw new RefundError(
      'BANK_ACCOUNT_REQUIRED',
      `choose the bank account the refund will be paid from (the company has ${String(banks.length)} active bank accounts)`,
    );
  }
  return { id: only.gl, source: 'only_bank_account' };
}

/**
 * "Show me the journal" for a requested refund (T-0152, SS-UC11-08, design §3.9): the engine's
 * preview of the GP-006 entry the bank confirmation will post, dated the refund date (the real
 * entry is dated the confirmation date). Writes nothing.
 */
export async function previewCustomerRefundJournal(
  trx: Trx,
  q: { companyId: string; refundId: string; accountId?: string },
): Promise<RefundJournalPreview> {
  const companyId = q.companyId.toLowerCase();
  const r = await getCustomerRefund(trx, companyId, q.refundId);
  if (r.status !== 'requested') {
    throw new RefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status}`);
  }
  const bank = await refundBankAccount(trx, companyId, r.refundId, q.accountId);
  const built = await preview(trx, {
    companyId,
    idempotencyKey: `ar-refund:${r.refundId}`,
    entryDate: r.refundDate,
    sourceType: REFUND_SOURCE_TYPE,
    sourceId: r.refundId,
    memo: `Customer refund ${r.refundNo} (preview)`,
    lines: refundJournal(r, bank.id),
  });
  const ids = [...new Set(built.lines.map((l) => l.accountId))];
  const names = new Map(
    (
      await sql<{ id: string; name: string; type: string }>`
        SELECT id::text, name, type FROM app.account
         WHERE company_id = ${companyId} AND id = ANY(${sql.val(ids)}::uuid[])`.execute(trx)
    ).rows.map((a) => [a.id, a]),
  );
  return {
    entryDate: built.entryDate,
    requestedDate: built.requestedDate,
    redirected: built.redirected,
    needsOverride: built.needsOverride,
    baseCurrency: built.baseCurrency,
    total: built.total,
    bankAccountSource: bank.source,
    lines: built.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.accountCode,
      accountName: names.get(l.accountId)?.name ?? l.accountCode,
      accountType: names.get(l.accountId)?.type ?? '',
      debit: l.debit,
      credit: l.credit,
      partyId: l.partyId,
    })),
  };
}
