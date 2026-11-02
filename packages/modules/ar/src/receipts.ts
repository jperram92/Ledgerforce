/**
 * Customer receipts and allocations (T-0046, design §3.8 row 2, UC-03, GP-002, DL-0274).
 *
 * recordReceipt posts at once through the engine (source ar_receipt):
 *   Dr bank account (or Undeposited funds for cheques/cash not yet banked, GP-002 variant)
 *   / Cr AR control (party)
 * and allocates it to the customer's invoices (ledger allocate()). What is not allocated stays on
 * the receipt's open item (customer credit) and can be allocated later with allocateReceipt.
 * An invoice's payment status is derived from its open item — unpaid, partially_paid or paid —
 * so a posted (frozen) invoice row never changes. Money is decimal strings; no floating point.
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

export const RECEIPT_NUMBER_SERIES = 'ar_receipt_document';

export type ReceiptErrorCode = 'INVALID_RECEIPT' | 'OVER_ALLOCATED';

export class ReceiptError extends Error {
  readonly code: ReceiptErrorCode;
  constructor(code: ReceiptErrorCode, message: string) {
    super(message);
    this.name = 'ReceiptError';
    this.code = code;
  }
}

export interface ReceiptInput {
  readonly companyId: string;
  readonly partyId: string;
  readonly receiptDate: string;
  /** Decimal string > 0, ≤ 2 decimals. */
  readonly amount: string;
  readonly method: 'eft' | 'cheque' | 'cash' | 'card';
  /** A bank (or other postable asset) account, or the Undeposited funds role. */
  readonly depositTo: { readonly accountId: string } | { readonly undeposited: true };
  readonly reference?: string;
  readonly idempotencyKey: string;
  readonly createdBy?: string;
  /**
   * The journal's source type: `ar_receipt` (default), or `payments_stripe_charge` for a card
   * payment received through Stripe into the clearing account (GP-003, T-0074).
   */
  readonly sourceType?: 'ar_receipt' | 'payments_stripe_charge';
  readonly allocations: readonly { readonly invoiceId: string; readonly amount: string }[];
}

export interface ReceiptView {
  readonly receiptId: string;
  readonly receiptNo: string;
  readonly entryId: string;
  readonly replayed: boolean;
  readonly amount: string;
  /** Still unallocated (customer credit), NUMERIC text. */
  readonly unallocated: string;
}

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

async function viewOf(
  trx: Trx,
  companyId: string,
  receiptId: string,
  replayed: boolean,
): Promise<ReceiptView> {
  const r = await trx
    .selectFrom('app.customer_receipt')
    .select(['id', 'receipt_no', 'entry_id', 'amount'])
    .where('company_id', '=', companyId)
    .where('id', '=', receiptId)
    .executeTakeFirst();
  if (!r)
    throw new ReceiptError(
      'INVALID_RECEIPT',
      `receipt ${receiptId} is not in company ${companyId}`,
    );
  const [item] = await subledgerEntriesOf(trx, r.entry_id);
  return {
    receiptId: r.id,
    receiptNo: r.receipt_no,
    entryId: r.entry_id,
    replayed,
    amount: numeric(r.amount),
    unallocated: numeric(new Decimal(item?.openAmount ?? '0').abs()),
  };
}

async function applyToInvoice(
  trx: Trx,
  c: {
    companyId: string;
    partyId: string;
    receiptEntryId: string;
    invoiceId: string;
    amount: string;
    date: string;
    key: string;
  },
): Promise<void> {
  if (!AMOUNT_RE.test(c.amount) || !new Decimal(c.amount).gt(0)) {
    throw new ReceiptError('INVALID_RECEIPT', 'an allocation must be > 0 with ≤ 2 decimals');
  }
  const inv = await trx
    .selectFrom('app.sales_invoice')
    .select(['party_id', 'status', 'entry_id'])
    .where('company_id', '=', c.companyId)
    .where('id', '=', c.invoiceId)
    .executeTakeFirst();
  if (!inv || inv.status !== 'posted' || !inv.entry_id) {
    throw new ReceiptError(
      'INVALID_RECEIPT',
      `invoice ${c.invoiceId} is not a posted invoice of this company`,
    );
  }
  if (inv.party_id !== c.partyId) {
    throw new ReceiptError('INVALID_RECEIPT', `invoice ${c.invoiceId} belongs to another customer`);
  }
  const [from] = await subledgerEntriesOf(trx, c.receiptEntryId);
  const [to] = await subledgerEntriesOf(trx, inv.entry_id);
  if (!from || !to)
    throw new ReceiptError('INVALID_RECEIPT', 'receipt or invoice has no open item');
  const amount = new Decimal(c.amount);
  if (amount.gt(new Decimal(from.openAmount).abs()) || amount.gt(new Decimal(to.openAmount))) {
    throw new ReceiptError(
      'OVER_ALLOCATED',
      `allocation ${numeric(amount)} exceeds the receipt's unallocated ${numeric(new Decimal(from.openAmount).abs())} or the invoice's open ${numeric(to.openAmount)}`,
    );
  }
  await allocate(trx, {
    companyId: c.companyId,
    idempotencyKey: c.key,
    fromEntryId: from.id,
    toEntryId: to.id,
    amount: numeric(amount),
    allocationDate: c.date,
  });
}

/** Record a customer receipt, post it and allocate it to invoices (one transaction). */
export async function recordReceipt(
  trx: Trx,
  c: ReceiptInput,
  opts: PostOptions = {},
): Promise<ReceiptView> {
  const companyId = c.companyId.toLowerCase();
  const existing = await trx
    .selectFrom('app.customer_receipt')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', c.idempotencyKey)
    .executeTakeFirst();
  if (existing) return viewOf(trx, companyId, existing.id, true);
  if (!AMOUNT_RE.test(c.amount) || !new Decimal(c.amount).gt(0)) {
    throw new ReceiptError('INVALID_RECEIPT', 'the amount must be > 0 with ≤ 2 decimals');
  }
  if (!DATE_RE.test(c.receiptDate))
    throw new ReceiptError('INVALID_RECEIPT', 'receipt date is YYYY-MM-DD');
  const allocated = c.allocations.reduce(
    (s, a) => s.plus(AMOUNT_RE.test(a.amount) ? a.amount : '0'),
    new Decimal(0),
  );
  if (allocated.gt(c.amount)) {
    throw new ReceiptError(
      'OVER_ALLOCATED',
      `allocations ${numeric(allocated)} exceed the receipt ${numeric(c.amount)}`,
    );
  }
  const debitAccount =
    'undeposited' in c.depositTo
      ? (
          await trx
            .selectFrom('app.account_system_role')
            .select('account_id')
            .where('company_id', '=', companyId)
            .where('role', '=', 'UNDEPOSITED_FUNDS')
            .executeTakeFirstOrThrow()
        ).account_id
      : c.depositTo.accountId;
  const receiptNo = await nextNumber(trx, companyId, RECEIPT_NUMBER_SERIES);
  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-receipt:${c.idempotencyKey}`,
      entryDate: c.receiptDate,
      sourceType: c.sourceType ?? 'ar_receipt',
      memo: `Receipt ${receiptNo}${c.reference ? ` ${c.reference}` : ''}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        { account: { id: debitAccount }, debit: c.amount },
        { account: { role: 'AR_CONTROL' }, credit: c.amount, partyId: c.partyId },
      ],
    },
    opts,
  );
  const row = await trx
    .insertInto('app.customer_receipt')
    .values({
      company_id: companyId,
      party_id: c.partyId,
      receipt_no: receiptNo,
      receipt_date: c.receiptDate,
      amount: c.amount,
      method: c.method,
      account_id: debitAccount,
      reference: c.reference ?? null,
      idempotency_key: c.idempotencyKey,
      entry_id: posted.entryId,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [i, a] of c.allocations.entries()) {
    await applyToInvoice(trx, {
      companyId,
      partyId: c.partyId,
      receiptEntryId: posted.entryId,
      invoiceId: a.invoiceId,
      amount: a.amount,
      date: c.receiptDate,
      key: `ar-receipt-alloc:${row.id}:${String(i + 1)}`,
    });
  }
  return viewOf(trx, companyId, row.id, false);
}

/** Allocate (part of) an existing receipt's unallocated amount to an invoice of the same customer. */
export async function allocateReceipt(
  trx: Trx,
  c: {
    companyId: string;
    receiptId: string;
    invoiceId: string;
    amount: string;
    allocationDate: string;
  },
): Promise<ReceiptView> {
  const companyId = c.companyId.toLowerCase();
  const r = await trx
    .selectFrom('app.customer_receipt')
    .select(['id', 'party_id', 'entry_id'])
    .where('company_id', '=', companyId)
    .where('id', '=', c.receiptId)
    .executeTakeFirst();
  if (!r)
    throw new ReceiptError(
      'INVALID_RECEIPT',
      `receipt ${c.receiptId} is not in company ${companyId}`,
    );
  const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.allocation a
    JOIN app.subledger_entry s ON s.tenant_id = a.tenant_id AND s.id = a.from_entry_id
   WHERE s.entry_id = ${r.entry_id}::uuid`.execute(trx);
  await applyToInvoice(trx, {
    companyId,
    partyId: r.party_id,
    receiptEntryId: r.entry_id,
    invoiceId: c.invoiceId,
    amount: c.amount,
    date: c.allocationDate,
    key: `ar-receipt-alloc:${r.id}:later-${String((n.rows[0]?.n ?? 0) + 1)}`,
  });
  return viewOf(trx, companyId, r.id, false);
}

/** An invoice's payment status, derived from its open item (UC-03). */
export async function invoicePaymentStatus(
  trx: Trx,
  companyId: string,
  invoiceId: string,
): Promise<{ status: 'unpaid' | 'partially_paid' | 'paid'; open: string }> {
  const inv = await trx
    .selectFrom('app.sales_invoice')
    .select(['entry_id', 'gross_total'])
    .where('company_id', '=', companyId.toLowerCase())
    .where('id', '=', invoiceId)
    .executeTakeFirst();
  if (!inv?.entry_id || inv.gross_total === null) {
    throw new ReceiptError('INVALID_RECEIPT', `invoice ${invoiceId} is not posted`);
  }
  const [item] = await subledgerEntriesOf(trx, inv.entry_id);
  const open = new Decimal(item?.openAmount ?? '0');
  const status = open.isZero()
    ? 'paid'
    : open.equals(inv.gross_total)
      ? 'unpaid'
      : 'partially_paid';
  return { status, open: numeric(open) };
}
