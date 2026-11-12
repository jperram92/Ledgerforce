/**
 * Customer statement HTML template, layout `statement-v1` (T-0049, design §8.1). Pure and escaped
 * like the invoice template (ADR-0045 rule 1): opening balance, each movement with its running
 * balance, closing balance. Rendered to PDF with PdfRenderer; emailed to the Statements contact.
 */
import { escapeHtml, formatDate, formatMoney } from './invoice-html.ts';

export interface StatementDocument {
  readonly supplier: { readonly legalName: string; readonly abn: string | null };
  readonly customer: string;
  readonly from: string;
  readonly to: string;
  readonly openingBalance: string;
  readonly lines: readonly {
    readonly date: string;
    readonly kind: string;
    readonly reference: string | null;
    readonly debit: string;
    readonly credit: string;
    readonly balance: string;
  }[];
  readonly closingBalance: string;
}

const LABEL: Record<string, string> = {
  invoice: 'Invoice',
  credit_note: 'Credit note',
  receipt: 'Payment',
  prepayment: 'Prepayment applied',
  write_off: 'Written off',
  reversal: 'Reversal',
  adjustment: 'Adjustment',
};

export function renderStatementHtml(d: StatementDocument): string {
  const e = escapeHtml;
  const amount = (v: string) => (/^-?0(\.0+)?$/.test(v) ? '' : formatMoney(v));
  const rows = d.lines
    .map(
      (l) =>
        `<tr><td>${e(formatDate(l.date))}</td><td>${e(LABEL[l.kind] ?? l.kind)}</td><td>${e(l.reference ?? '')}</td>` +
        `<td class="amount">${amount(l.debit)}</td><td class="amount">${amount(l.credit)}</td>` +
        `<td class="amount">${formatMoney(l.balance)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Statement ${e(d.customer)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;font-size:10.5pt}table{width:100%;border-collapse:collapse}
th,td{padding:2mm 1.5mm;text-align:left}td.amount,th.amount{text-align:right;white-space:nowrap}
thead th{border-bottom:1px solid #333}tr.total td{font-weight:bold;border-top:1px solid #333}</style></head>
<body>
<h1>Statement</h1>
<p><strong>${e(d.supplier.legalName)}</strong>${d.supplier.abn ? ` — ABN ${e(d.supplier.abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4'))}` : ''}</p>
<p>Customer: <strong>${e(d.customer)}</strong> · Period ${e(formatDate(d.from))} to ${e(formatDate(d.to))}</p>
<table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th class="amount">Charges</th><th class="amount">Credits</th><th class="amount">Balance</th></tr></thead>
<tbody>
<tr><td>${e(formatDate(d.from))}</td><td>Opening balance</td><td></td><td></td><td></td><td class="amount">${formatMoney(d.openingBalance)}</td></tr>
${rows}
<tr class="total"><td>${e(formatDate(d.to))}</td><td>Balance due</td><td></td><td></td><td></td><td class="amount">${formatMoney(d.closingBalance)}</td></tr>
</tbody></table>
</body></html>`;
}
