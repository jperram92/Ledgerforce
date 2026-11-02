/**
 * Customer refunds (T-0055, UC-11 step 3, design §3.8, GP-006, postings.md Q9, DL-0288).
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
 */
import type { Database } from '@ledgerforce/db';
import {
  allocate,
  nextNumber,
  post,
  subledgerEntriesOf,
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
  'INVALID_REFUND' | 'REFUND_EXCEEDS_CREDIT' | 'METHOD_NOT_AVAILABLE' | 'NOT_PAYABLE';

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
  const r = await trx
    .selectFrom('app.customer_refund')
    .select([
      'id',
      'refund_no',
      'party_id',
      'amount',
      'method',
      'status',
      'entry_id',
      sql<string>`to_char(refund_date, 'YYYY-MM-DD')`.as('refund_date'),
      sql<string | null>`to_char(paid_on, 'YYYY-MM-DD')`.as('paid_on'),
    ])
    .where('company_id', '=', cid)
    .where('id', '=', refundId.toLowerCase())
    .executeTakeFirst();
  if (!r) throw new RefundError('INVALID_REFUND', `refund ${refundId} is not in company ${cid}`);
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
  if (!party) throw new RefundError('INVALID_REFUND', `party ${partyId} is not in this company`);
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
      lines: [
        {
          account: { role: 'AR_CONTROL' as const },
          debit: r.amount,
          partyId: r.partyId,
          memo: r.refundNo,
        },
        { account: { id: c.bankAccountId }, credit: r.amount },
      ],
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
