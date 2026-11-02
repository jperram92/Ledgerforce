/**
 * Payment batch confirmation (T-0057, UC-06 step 5, design §3.8 row 7, GP-009, DL-0285).
 *
 * Nothing posts when a batch is released (payment-batches.ts). When the bank confirms the batch,
 * confirmPaymentBatch posts ONE journal per batch through the engine (source ap_payment, entry
 * date = the confirmation date):
 *   Dr AP control (supplier) — one line per bill, at the payment amount
 *   Cr the batch's operating bank account — one line for the batch total
 * (postings.md Q6, answered by RQ-0096: one entry per batch, one AP line per bill, one bank line
 * per batch, so the bank statement's single batch debit matches one journal line). Each AP line's
 * open item is then allocated to its bill's open item (ledger allocate()), so the bill is paid.
 * The confirmation is recorded in app.payment_batch_confirmation (migration 0048); a repeat
 * returns the first confirmation. The payments' remittance advices go out from the
 * `ledger.entry.posted` event of this entry (remittance.ts). Money is decimal strings; no floats.
 *
 * Customer refunds in the batch (T-0055, GP-006, DL-0288) each post their own entry, as GP-006
 * shows (source ar_refund, Dr AR control (customer) / Cr the batch's bank account), through
 * @ledgerforce/ar payCustomerRefund, which also clears the customer's credit. The GP-009 entry then
 * credits the bank with the bills' total only, and a batch that pays only refunds has no GP-009
 * entry: its confirmation row names its first refund's GP-006 entry (migration 0049) and the view
 * reports entryId null.
 */
import type { Database } from '@ledgerforce/db';
import { payCustomerRefund, RefundError } from '@ledgerforce/ar';
import { resolveRecipients } from '@ledgerforce/email';
import { allocate, post, subledgerEntriesOf, type PostOptions } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { getPaymentBatch, PaymentBatchError, type PaymentBatchView } from './payment-batches.ts';

type Trx = Transaction<Database>;

export const PAYMENT_SOURCE_TYPE = 'ap_payment';

export interface ConfirmPaymentBatchInput {
  readonly companyId: string;
  readonly batchId: string;
  /** YYYY-MM-DD the bank confirmed the payments; not before the batch's payment date. */
  readonly confirmedOn: string;
  /** The bank's reference for the batch (1–100 characters), if any. */
  readonly bankReference?: string;
  readonly confirmedBy?: string;
}

export interface PaymentConfirmationView {
  readonly batchId: string;
  readonly batchNo: string;
  /** The GP-009 entry; null when the batch pays only customer refunds. */
  readonly entryId: string | null;
  readonly confirmedOn: string;
  readonly bankReference: string | null;
  readonly confirmedBy: string | null;
  /** The batch total paid (NUMERIC text). */
  readonly total: string;
  readonly replayed: boolean;
  /** The payments posted, in batch line order. */
  readonly payments: readonly { billId: string; billNo: string; partyId: string; amount: string }[];
  /** The customer refunds paid, each with its own GP-006 entry (T-0055). */
  readonly refunds: readonly {
    refundId: string;
    refundNo: string;
    partyId: string;
    amount: string;
    entryId: string | null;
  }[];
  /** Suppliers paid who have no Remittance contact (no advice can be emailed to them). */
  readonly remittanceMissing: readonly string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const isDate = (d: string) =>
  DATE_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** The batch's payments with their bills' numbers and journal entries, in line order. */
async function paymentsOf(trx: Trx, batch: PaymentBatchView) {
  const ids = batch.payments.map((p) => p.billId);
  if (ids.length === 0) return []; // a batch of customer refunds only (T-0055)
  const bills = new Map(
    (
      await trx
        .selectFrom('app.supplier_bill')
        .select(['id', 'bill_no', 'entry_id', 'supplier_ref'])
        .where('id', 'in', ids)
        .execute()
    ).map((b) => [b.id, b]),
  );
  return batch.payments.map((p) => {
    const b = bills.get(p.billId);
    if (!b?.bill_no || !b.entry_id) {
      throw new PaymentBatchError('NOT_CONFIRMABLE', `bill ${p.billId} is not a posted bill`);
    }
    return { ...p, billNo: b.bill_no, billEntryId: b.entry_id, supplierRef: b.supplier_ref };
  });
}

/** The batch's payments with bill numbers and references (for confirmations and remittances). */
export async function batchPayments(
  trx: Trx,
  batch: PaymentBatchView,
): Promise<
  {
    billId: string;
    billNo: string;
    supplierRef: string;
    partyId: string;
    amount: string;
  }[]
> {
  return (await paymentsOf(trx, batch)).map((p) => ({
    billId: p.billId,
    billNo: p.billNo,
    supplierRef: p.supplierRef,
    partyId: p.partyId,
    amount: p.amount,
  }));
}

async function viewOf(
  trx: Trx,
  companyId: string,
  batch: PaymentBatchView,
  replayed: boolean,
): Promise<PaymentConfirmationView> {
  const c = batch.confirmation;
  if (!c) throw new PaymentBatchError('NOT_CONFIRMABLE', `batch ${batch.batchNo} is unconfirmed`);
  const payments = await paymentsOf(trx, batch);
  const refundEntries = new Map(
    batch.refunds.length === 0
      ? []
      : (
          await trx
            .selectFrom('app.customer_refund')
            .select(['id', 'entry_id'])
            .where(
              'id',
              'in',
              batch.refunds.map((r) => r.refundId),
            )
            .execute()
        ).map((r) => [r.id, r.entry_id]),
  );
  const parties = [...new Set(payments.map((p) => p.partyId))];
  const remittanceMissing: string[] = [];
  for (const party of parties) {
    const r = await resolveRecipients(trx, companyId, party, 'remittance');
    if (r.to.length === 0) remittanceMissing.push(party);
  }
  return {
    batchId: batch.batchId,
    batchNo: batch.batchNo,
    entryId: c.entryId,
    confirmedOn: c.confirmedOn,
    bankReference: c.bankReference,
    confirmedBy: c.confirmedBy,
    total: batch.total,
    replayed,
    payments: payments.map((p) => ({
      billId: p.billId,
      billNo: p.billNo,
      partyId: p.partyId,
      amount: p.amount,
    })),
    refunds: batch.refunds.map((r) => ({
      refundId: r.refundId,
      refundNo: r.refundNo,
      partyId: r.partyId,
      amount: r.amount,
      entryId: refundEntries.get(r.refundId) ?? null,
    })),
    remittanceMissing,
  };
}

/** Record the bank's confirmation of a released batch: post GP-009 and pay the bills. */
export async function confirmPaymentBatch(
  trx: Trx,
  c: ConfirmPaymentBatchInput,
  opts: PostOptions = {},
): Promise<PaymentConfirmationView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.batchId)) {
    throw new PaymentBatchError('INVALID_BATCH', 'the batch id is a uuid');
  }
  const batchId = c.batchId.toLowerCase();
  // The release lock: a confirmation never interleaves with a release or another confirmation.
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`ap-payment-batch-release:${batchId}`}))`.execute(
    trx,
  );
  const batch = await getPaymentBatch(trx, companyId, batchId);
  if (batch.confirmation) return viewOf(trx, companyId, batch, true);
  if (batch.status !== 'released') {
    throw new PaymentBatchError(
      'NOT_CONFIRMABLE',
      `payment batch ${batch.batchNo} is ${batch.status}; only a released batch can be confirmed`,
    );
  }
  if (!isDate(c.confirmedOn)) {
    throw new PaymentBatchError('INVALID_BATCH', 'the confirmation date is YYYY-MM-DD');
  }
  if (c.confirmedOn < batch.paymentDate) {
    throw new PaymentBatchError(
      'INVALID_BATCH',
      `the bank cannot confirm ${batch.batchNo} on ${c.confirmedOn}, before its payment date ${batch.paymentDate}`,
    );
  }
  const bankReference = c.bankReference?.trim();
  if (bankReference !== undefined && (bankReference.length < 1 || bankReference.length > 100)) {
    throw new PaymentBatchError('INVALID_BATCH', 'the bank reference is 1–100 characters');
  }

  // Every bill must still owe at least its payment (a credit note since the batch was built
  // would otherwise over-pay it): refuse, and let the bank-rejection flow handle that payment.
  const payments = await paymentsOf(trx, batch);
  const billItems = [];
  for (const p of payments) {
    const item = (await subledgerEntriesOf(trx, p.billEntryId)).find(
      (i) => i.controlRole === 'AP_CONTROL',
    );
    const owed = new Decimal(item?.openAmount ?? '0').negated();
    if (!item || owed.lt(p.amount)) {
      throw new PaymentBatchError(
        'NOT_CONFIRMABLE',
        `bill ${p.billNo} now owes ${numeric(Decimal.max(owed, 0))}, less than its payment ${p.amount}`,
      );
    }
    billItems.push(item);
  }

  const billsTotal = payments.reduce((s, p) => s.plus(p.amount), new Decimal(0));
  const posted =
    payments.length === 0
      ? null
      : await post(
          trx,
          {
            companyId,
            idempotencyKey: `ap-payment-batch:${batchId}`,
            entryDate: c.confirmedOn,
            sourceType: PAYMENT_SOURCE_TYPE,
            sourceId: batchId,
            memo: `Payment batch ${batch.batchNo}${bankReference ? ` ${bankReference}` : ''}`,
            ...(c.confirmedBy ? { createdBy: c.confirmedBy } : {}),
            lines: [
              ...payments.map((p) => ({
                account: { role: 'AP_CONTROL' as const },
                debit: p.amount,
                partyId: p.partyId,
                memo: p.billNo,
              })),
              { account: { id: batch.accountId }, credit: numeric(billsTotal) },
            ],
          },
          opts,
        );
  const paymentItems = posted ? await subledgerEntriesOf(trx, posted.entryId) : [];
  for (const [i, p] of payments.entries()) {
    const from = paymentItems.find((x) => x.lineNo === i + 1);
    const to = billItems[i];
    if (!from || !to) throw new PaymentBatchError('NOT_CONFIRMABLE', 'payment has no open item');
    await allocate(trx, {
      companyId,
      idempotencyKey: `ap-payment-alloc:${batchId}:${String(i + 1)}`,
      fromEntryId: from.id,
      toEntryId: to.id,
      amount: p.amount,
      allocationDate: c.confirmedOn,
      ...(c.confirmedBy ? { createdBy: c.confirmedBy } : {}),
    });
  }
  // Each refund: its own GP-006 entry, from the batch's bank account, clearing the credit.
  let firstRefundEntry: string | null = null;
  for (const r of batch.refunds) {
    const paid = await payCustomerRefund(
      trx,
      {
        companyId,
        refundId: r.refundId,
        paidOn: c.confirmedOn,
        bankAccountId: batch.accountId,
        reference: batch.batchNo,
        ...(c.confirmedBy ? { createdBy: c.confirmedBy } : {}),
      },
      opts,
    ).catch((e: unknown) => {
      if (e instanceof RefundError) {
        throw new PaymentBatchError('NOT_CONFIRMABLE', `refund ${r.refundNo}: ${e.message}`);
      }
      throw e;
    });
    firstRefundEntry ??= paid.entryId;
  }
  const entryId = posted?.entryId ?? firstRefundEntry;
  if (!entryId)
    throw new PaymentBatchError('NOT_CONFIRMABLE', `batch ${batch.batchNo} pays nothing`);
  await trx
    .insertInto('app.payment_batch_confirmation')
    .values({
      company_id: companyId,
      batch_id: batchId,
      entry_id: entryId,
      confirmed_on: c.confirmedOn,
      bank_reference: bankReference ?? null,
      confirmed_by: c.confirmedBy ?? null,
    })
    .execute();
  return viewOf(trx, companyId, await getPaymentBatch(trx, companyId, batchId), false);
}
