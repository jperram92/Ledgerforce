/**
 * Load a posted sales invoice as the document model the templates render (T-0041). Reads only.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { InvoiceDocument } from './invoice-html.ts';

export class DocumentError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_POSTED';
  constructor(code: 'NOT_FOUND' | 'NOT_POSTED', message: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

export async function loadInvoiceDocument(
  trx: Transaction<Database>,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceDocument> {
  const h = (
    await sql<{
      status: string;
      invoice_no: string | null;
      issue_date: string;
      due_date: string;
      currency: string;
      pricing: 'exclusive' | 'inclusive';
      net_total: string | null;
      tax_total: string | null;
      gross_total: string | null;
      supplier: string;
      supplier_abn: string | null;
      customer: string;
      customer_abn: string | null;
    }>`
      SELECT i.status, i.invoice_no, to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
             to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.currency, i.pricing,
             i.net_total::text, i.tax_total::text, i.gross_total::text,
             coalesce(c.legal_name, c.name) AS supplier, c.abn AS supplier_abn,
             p.legal_name AS customer, p.abn AS customer_abn
        FROM app.sales_invoice i
        JOIN app.company c ON c.tenant_id = i.tenant_id AND c.id = i.company_id
        JOIN app.party p ON p.tenant_id = i.tenant_id AND p.id = i.party_id
       WHERE i.company_id = ${companyId} AND i.id = ${invoiceId}::uuid`.execute(trx)
  ).rows[0];
  if (!h)
    throw new DocumentError('NOT_FOUND', `invoice ${invoiceId} is not in company ${companyId}`);
  if (h.status === 'draft' || !h.invoice_no || h.gross_total === null) {
    throw new DocumentError(
      'NOT_POSTED',
      `invoice ${invoiceId} is a draft; only posted invoices are tax invoices`,
    );
  }
  const lines = await trx
    .selectFrom('app.sales_invoice_line')
    .select(['description', 'quantity', 'unit_price', 'tax_code', 'net', 'tax', 'gross'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('line_no')
    .execute();
  return {
    supplier: { legalName: h.supplier, abn: h.supplier_abn },
    customer: { name: h.customer, abn: h.customer_abn },
    invoiceNo: h.invoice_no,
    issueDate: h.issue_date,
    dueDate: h.due_date,
    currency: h.currency,
    pricing: h.pricing,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      taxCode: l.tax_code,
      net: l.net ?? '0',
      tax: l.tax ?? '0',
      gross: l.gross ?? '0',
    })),
    net: h.net_total ?? '0',
    tax: h.tax_total ?? '0',
    gross: h.gross_total,
  };
}
