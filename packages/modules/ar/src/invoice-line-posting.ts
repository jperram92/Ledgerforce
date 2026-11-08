/**
 * How each sales-invoice line posted (T-0045; RQ-0114 finding 2; ADR-0044 R5/W6; migration
 * 0040). Written by the invoice post inside its savepoint, after the engine wrote the journal and
 * while the invoice is still approved: per line the revenue account, the tax-code version valid
 * on the invoice date, and the line's net and tax from the same GST calculation the journal used.
 * Credit notes inherit these rows and never re-resolve. Not a ledger table.
 */
import type { Database, TaxRounding } from '@ledgerforce/db';
import { calculateTax, type AmountsAre } from '@ledgerforce/tax';
import { sql, type Transaction } from 'kysely';
import type { InvoiceJournalLine } from './invoice-journal.ts';

type Trx = Transaction<Database>;

export interface InvoiceLinePosting {
  invoiceLineId: string;
  lineNo: number;
  accountId: string;
  taxCodeId: string;
  /** NUMERIC(19,4) text. */
  netAmount: string;
  taxAmount: string;
}

export async function recordInvoiceLinePostings(
  trx: Trx,
  p: {
    companyId: string;
    invoiceId: string;
    currency: string;
    amountsAre: AmountsAre;
    rounding: TaxRounding;
    /** The journal lines in invoice line order, with their line numbers. */
    lines: readonly (InvoiceJournalLine & { lineNo: number })[];
  },
): Promise<void> {
  const calc = calculateTax({
    currency: p.currency,
    amountsAre: p.amountsAre,
    rounding: p.rounding,
    lines: p.lines.map((l) => ({
      amount: l.amount,
      taxCode: l.taxCode.code,
      rate: l.taxCode.rate,
    })),
  });
  const ids = await sql<{ id: string; line_no: number }>`
    SELECT id::text, line_no FROM app.sales_invoice_line WHERE invoice_id = ${p.invoiceId}`.execute(
    trx,
  );
  const byNo = new Map(ids.rows.map((r) => [r.line_no, r.id]));
  const rows = p.lines.map((l, i) => {
    const r = calc.lines[i];
    const id = byNo.get(l.lineNo);
    if (!r || r.tax === null || id === undefined) {
      throw new Error(`invoice ${p.invoiceId} line ${String(l.lineNo)}: no posting result`);
    }
    return {
      company_id: p.companyId,
      invoice_id: p.invoiceId,
      invoice_line_id: id,
      account_id: l.accountId,
      tax_code_id: l.taxCode.id,
      net_amount: r.net.toNumericString(),
      tax_amount: r.tax.toNumericString(),
    };
  });
  for (const r of rows) {
    await sql`
      INSERT INTO app.sales_invoice_line_posting
        (company_id, invoice_id, invoice_line_id, account_id, tax_code_id, net_amount, tax_amount)
      VALUES (${r.company_id}, ${r.invoice_id}, ${r.invoice_line_id}, ${r.account_id},
              ${r.tax_code_id}, ${r.net_amount}, ${r.tax_amount})`.execute(trx);
  }
}

/** The recorded line postings of an invoice, in line order (empty before it posts). */
export async function invoiceLinePostings(
  trx: Trx,
  invoiceId: string,
): Promise<InvoiceLinePosting[]> {
  const r = await sql<InvoiceLinePosting>`
    SELECT p.invoice_line_id::text AS "invoiceLineId", l.line_no AS "lineNo",
           p.account_id::text AS "accountId", p.tax_code_id::text AS "taxCodeId",
           p.net_amount::text AS "netAmount", p.tax_amount::text AS "taxAmount"
      FROM app.sales_invoice_line_posting p
      JOIN app.sales_invoice_line l ON l.tenant_id = p.tenant_id AND l.id = p.invoice_line_id
     WHERE p.invoice_id = ${invoiceId}
     ORDER BY l.line_no`.execute(trx);
  return r.rows;
}
