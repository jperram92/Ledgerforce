/**
 * Salesforce write-back snapshot for a customer receipt (design §5.4 contract v1, DL-0191;
 * T-0074, SS-UC03-04). Values are current state, not deltas, so a replayed event rewrites the same
 * values. Built from the subledger (open items and allocations) and the invoice header; reads only.
 * Money is NUMERIC text (decimal strings); no floating point.
 */
import { createHash } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { accountWriteBack, type AccountWriteBack } from './aged.ts';

type Trx = Transaction<Database>;

export const PAYMENT_RECEIVED = 'payment.received';

/** Journal source types whose open items are customer payments (receipts). */
const RECEIPT_SOURCES = ['ar_receipt', 'payments_stripe_charge'];

const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export interface ReceiptWriteBack {
  readonly version: 1;
  readonly invoices: Record<string, unknown>[];
  readonly payments: Record<string, unknown>[];
  readonly accounts: AccountWriteBack[];
  readonly opportunities?: Record<string, unknown>[];
}

/** Receipts allocated into each invoice open item: amount paid and the latest allocation date. */
async function paidInto(
  trx: Trx,
  companyId: string,
  invoiceEntryIds: readonly string[],
): Promise<Map<string, { paid: string; last: string | null }>> {
  if (invoiceEntryIds.length === 0) return new Map();
  const rows = (
    await sql<{ entry_id: string; paid: string; last: string | null }>`
      SELECT inv.entry_id::text AS entry_id, coalesce(sum(a.amount), 0)::text AS paid,
             to_char(max(a.allocation_date), 'YYYY-MM-DD') AS last
        FROM app.subledger_entry inv
        JOIN app.allocation a
          ON a.company_id = inv.company_id AND (a.from_entry_id = inv.id OR a.to_entry_id = inv.id)
        JOIN app.subledger_entry o
          ON o.id = CASE WHEN a.from_entry_id = inv.id THEN a.to_entry_id ELSE a.from_entry_id END
       WHERE inv.company_id = ${companyId}::uuid
         AND inv.entry_id = ANY(${invoiceEntryIds as string[]}::uuid[])
         AND inv.control_role = 'AR_CONTROL'
         AND o.source_type = ANY(${RECEIPT_SOURCES}::text[])
       GROUP BY inv.entry_id`.execute(trx)
  ).rows;
  return new Map(rows.map((r) => [r.entry_id, { paid: r.paid, last: r.last }]));
}

/**
 * The `writeBack` snapshot after receipt `receiptId`: each invoice it is allocated to, one payment
 * row per invoice, the customer's Account and the invoices' Opportunities. Null when the customer
 * is not linked to a Salesforce Account (nothing to write back).
 */
export async function receiptWriteBack(
  trx: Trx,
  q: { companyId: string; receiptId: string },
): Promise<ReceiptWriteBack | null> {
  const companyId = q.companyId.toLowerCase();
  const r = await trx
    .selectFrom('app.customer_receipt as r')
    .innerJoin('app.party as p', (j) =>
      j.onRef('p.tenant_id', '=', 'r.tenant_id').onRef('p.id', '=', 'r.party_id'),
    )
    .select([
      'r.id',
      'r.party_id',
      'r.entry_id',
      'r.method',
      'r.reference',
      sql<string>`to_char(r.receipt_date, 'YYYY-MM-DD')`.as('receipt_date'),
      'p.salesforce_account_id',
    ])
    .where('r.company_id', '=', companyId)
    .where('r.id', '=', q.receiptId)
    .executeTakeFirst();
  if (!r?.salesforce_account_id) return null;
  const asOf = r.receipt_date;

  const allocated = (
    await sql<{
      invoice_id: string;
      invoice_no: string;
      entry_id: string;
      issue_date: string;
      due_date: string;
      gross_total: string;
      opportunity: string | null;
      amount: string;
    }>`
      WITH mine AS (SELECT id FROM app.subledger_entry
                     WHERE company_id = ${companyId}::uuid AND entry_id = ${r.entry_id}::uuid)
      SELECT i.id::text AS invoice_id, i.invoice_no, i.entry_id::text AS entry_id,
             to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
             to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.gross_total::text AS gross_total,
             i.salesforce_opportunity_id AS opportunity, sum(a.amount)::text AS amount
        FROM app.allocation a
        JOIN app.subledger_entry o
          ON o.id = CASE WHEN a.from_entry_id IN (SELECT id FROM mine) THEN a.to_entry_id ELSE a.from_entry_id END
        JOIN app.sales_invoice i ON i.company_id = o.company_id AND i.entry_id = o.entry_id
       WHERE a.company_id = ${companyId}::uuid
         AND (a.from_entry_id IN (SELECT id FROM mine) OR a.to_entry_id IN (SELECT id FROM mine))
       GROUP BY i.id
       ORDER BY i.invoice_no`.execute(trx)
  ).rows.filter((x) => new Decimal(x.amount).gt(0));

  const paid = await paidInto(
    trx,
    companyId,
    allocated.map((x) => x.entry_id),
  );
  const invoices: Record<string, unknown>[] = [];
  const payments: Record<string, unknown>[] = [];
  const statusOf = new Map<string, string>();
  for (const inv of allocated) {
    const open = (
      await sql<{ open: string }>`
        SELECT coalesce(sum(open_amount), 0)::text AS open FROM app.subledger_entry
         WHERE company_id = ${companyId}::uuid AND entry_id = ${inv.entry_id}::uuid
           AND control_role = 'AR_CONTROL'`.execute(trx)
    ).rows[0]?.open;
    const credited = (
      await sql<{ g: string }>`
        SELECT coalesce(sum(gross_total), 0)::text AS g FROM app.credit_note
         WHERE company_id = ${companyId}::uuid AND invoice_id = ${inv.invoice_id}::uuid
           AND status = 'posted'`.execute(trx)
    ).rows[0]?.g;
    const due = new Decimal(open ?? '0');
    const p = paid.get(inv.entry_id);
    const overdueDays = due.gt(0) ? Math.max(0, daysBetween(inv.due_date, asOf)) : 0;
    const status = due.lte(0)
      ? 'paid'
      : new Decimal(p?.paid ?? '0').gt(0)
        ? 'part_paid'
        : overdueDays > 0
          ? 'overdue'
          : 'posted';
    statusOf.set(inv.invoice_id, status);
    invoices.push({
      id: inv.invoice_id,
      number: inv.invoice_no,
      status,
      issueDate: inv.issue_date,
      dueDate: inv.due_date,
      total: numeric(inv.gross_total),
      amountDue: numeric(due),
      amountCredited: numeric(credited ?? '0'),
      daysOverdue: overdueDays,
      lastPaymentDate: p?.last ?? null,
      accountSfId: r.salesforce_account_id,
      ...(inv.opportunity ? { opportunitySfId: inv.opportunity } : {}),
    });
    payments.push({
      // One LF_Payment__c per receipt and invoice; a receipt split over invoices gets one each.
      id: allocated.length === 1 ? r.id : paymentRowId(r.id, inv.invoice_id),
      invoiceId: inv.invoice_id,
      paymentDate: asOf,
      amount: numeric(inv.amount),
      method: r.method,
      reference: r.reference,
      accountSfId: r.salesforce_account_id,
    });
  }

  const opportunities: Record<string, unknown>[] = [];
  for (const sfId of [...new Set(allocated.map((x) => x.opportunity).filter((x) => x !== null))]) {
    const all = await trx
      .selectFrom('app.sales_invoice')
      .select(['id', 'entry_id', 'gross_total'])
      .where('company_id', '=', companyId)
      .where('salesforce_opportunity_id', '=', sfId)
      .where('status', '=', 'posted')
      .execute();
    const paidAll = await paidInto(
      trx,
      companyId,
      all.flatMap((x) => (x.entry_id ? [x.entry_id] : [])),
    );
    const invoiced = all.reduce((s, x) => s.plus(x.gross_total ?? '0'), new Decimal(0));
    const amountPaid = [...paidAll.values()].reduce((s, x) => s.plus(x.paid), new Decimal(0));
    const mine = allocated.find((x) => x.opportunity === sfId);
    opportunities.push({
      sfId,
      invoiceStatus: (mine && statusOf.get(mine.invoice_id)) ?? 'posted',
      amountInvoiced: numeric(invoiced),
      amountPaid: numeric(amountPaid),
    });
  }

  return {
    version: 1,
    invoices,
    payments,
    accounts: [await accountWriteBack(trx, { companyId, partyId: r.party_id, asOf })],
    ...(opportunities.length > 0 ? { opportunities } : {}),
  };
}

/** A stable UUID (version-8 layout) for one invoice's share of a receipt split over invoices. */
function paymentRowId(receiptId: string, invoiceId: string): string {
  const h = createHash('sha256').update(`lf-payment:${receiptId}:${invoiceId}`).digest('hex');
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
