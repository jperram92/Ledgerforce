/**
 * Test-only setup for credit notes (T-0045): the credit-note and journal number series, and an
 * INV-000123-like invoice (GP-001 lines) posted through the sales-invoice code. Runs inside the
 * caller's tenant transaction, after setupInvoicing (invoice-world.ts).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { autoApproveSalesInvoice, createSalesInvoice, getSalesInvoice } from '../sales-invoices.ts';
import type { InvoiceWorld } from './invoice-world.ts';

type Trx = Transaction<Database>;

export async function setupCreditNotes(trx: Trx, companyId: string): Promise<void> {
  // The golden world already numbers je_ar_credit_note; keep its series when present.
  await sql`
    INSERT INTO app.number_series (company_id, code, prefix)
    VALUES (${companyId}, 'ar_credit_note', 'CN-'), (${companyId}, 'je_ar_credit_note', 'ARC-')
    ON CONFLICT DO NOTHING`.execute(trx);
}

export interface PostedInvoice {
  invoiceId: string;
  invoiceNo: string;
  entryId: string;
  /** Invoice line ids by line number (1 = Professional services, 2 = Subscription). */
  lineIds: string[];
}

/** GP-001's invoice (1,000.00 services + 250.00 subscription ex GST), auto-approved and posted. */
export async function postGp001Invoice(
  trx: Trx,
  w: InvoiceWorld,
  opts: { companyId: string; partyId: string; invoiceDate?: string; dueDate?: string },
): Promise<PostedInvoice> {
  const { id } = await createSalesInvoice(trx, {
    input: {
      companyId: opts.companyId,
      partyId: opts.partyId,
      invoiceDate: opts.invoiceDate ?? '2026-11-05',
      dueDate: opts.dueDate ?? '2026-11-19',
      amountsAre: 'exclusive',
      lines: [
        {
          productId: w.products.PROFESSIONAL_SERVICES,
          description: 'Professional services',
          amount: '1000.00',
        },
        { productId: w.products.SUBSCRIPTION, description: 'Subscription', amount: '250.00' },
      ],
    },
    createdBy: null,
    idempotencyKey: `cn-world:${randomUUID()}`,
  });
  const r = await autoApproveSalesInvoice(trx, {
    id,
    settings: { autoApprove: true, threshold: '2000.0000' },
  });
  if (r.outcome !== 'posted') throw new Error(`invoice stayed a draft (${r.reason})`);
  const doc = await getSalesInvoice(trx, id);
  const lines = await sql<{ id: string }>`
    SELECT id::text FROM app.sales_invoice_line WHERE invoice_id = ${id} ORDER BY line_no`.execute(
    trx,
  );
  return {
    invoiceId: id,
    invoiceNo: doc.invoiceNo ?? '',
    entryId: r.entryId,
    lineIds: lines.rows.map((l) => l.id),
  };
}
