/**
 * Invoice HTML template, layout `invoice-v1` (T-0041, design §4.3/§7.1, ADR-0045 rule 1).
 *
 * A pure function of the document: the same HTML is the screen preview, the email body and the
 * PDF source. Every value is HTML-escaped; there is no script and no external resource. It shows
 * what an Australian tax invoice needs: the words "Tax invoice", the supplier's identity and ABN,
 * the date and number, each item with its GST, and the total GST and total payable.
 * Amounts are formatted from decimal strings (no floating point, AGENTS.md §4).
 */

export interface InvoiceDocumentLine {
  readonly description: string;
  /** NUMERIC text, e.g. "1.0000". */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxCode: string | null;
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

export interface InvoiceDocument {
  readonly supplier: { readonly legalName: string; readonly abn: string | null };
  readonly customer: { readonly name: string; readonly abn: string | null };
  readonly invoiceNo: string;
  /** YYYY-MM-DD. */
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly pricing: 'exclusive' | 'inclusive';
  readonly lines: readonly InvoiceDocumentLine[];
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
}

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** "51824753556" → "51 824 753 556" (ATO grouping). */
export function formatAbn(abn: string): string {
  return /^\d{11}$/.test(abn)
    ? `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`
    : abn;
}

/** "1375.0000" → "$1,375.00" (AUD; cents half-up from the stored 4 decimals). */
export function formatMoney(v: string): string {
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const four = (f + '0000').slice(0, 4);
  let units = BigInt(i) * 100n + BigInt(four.slice(0, 2));
  if (Number.parseInt(four.slice(2), 10) >= 50) units += 1n;
  const dollars = (units / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (units % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars}.${cents}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-05" → "5 Nov 2026". */
export function formatDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${String(Number.parseInt(m[3] ?? '0', 10))} ${MONTHS[Number.parseInt(m[2] ?? '1', 10) - 1] ?? ''} ${m[1] ?? ''}`;
}

/** "3.0000" → "3"; "1.5000" → "1.5". */
const quantity = (q: string) => q.replace(/\.?0+$/, '') || '0';

const STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #111; }
  h1 { font-size: 20pt; margin: 0 0 4mm; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 8mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 2mm 1.5mm; text-align: left; vertical-align: top; }
  thead th { border-bottom: 1px solid #333; }
  td.amount, th.amount { text-align: right; white-space: nowrap; }
  .totals { width: 45%; margin-left: auto; margin-top: 6mm; }
  .totals th { text-align: left; font-weight: normal; }
  .totals tr.total th, .totals tr.total td { font-weight: bold; border-top: 1px solid #333; }
  .meta td { padding: 0.5mm 0; }
`;

export function renderInvoiceHtml(d: InvoiceDocument): string {
  const e = escapeHtml;
  const lines = d.lines
    .map(
      (l) =>
        `<tr><td>${e(l.description)}</td><td class="amount">${e(quantity(l.quantity))}</td>` +
        `<td class="amount">${formatMoney(l.unitPrice)}</td><td>${e(l.taxCode ?? '')}</td>` +
        `<td class="amount">${formatMoney(l.tax)}</td>` +
        `<td class="amount">${formatMoney(d.pricing === 'inclusive' ? l.gross : l.net)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(d.invoiceNo)}</title><style>${STYLE}</style></head>
<body>
<h1>Tax invoice</h1>
<div class="parties">
  <div><strong>${e(d.supplier.legalName)}</strong>${d.supplier.abn ? `<br>ABN ${e(formatAbn(d.supplier.abn))}` : ''}</div>
  <table class="meta" style="width:auto"><tbody>
    <tr><td>Invoice number</td><td><strong>${e(d.invoiceNo)}</strong></td></tr>
    <tr><td>Issue date</td><td>${e(formatDate(d.issueDate))}</td></tr>
    <tr><td>Due date</td><td>${e(formatDate(d.dueDate))}</td></tr>
  </tbody></table>
</div>
<p>Bill to: <strong>${e(d.customer.name)}</strong>${d.customer.abn ? ` (ABN ${e(formatAbn(d.customer.abn))})` : ''}</p>
<table class="lines"><thead><tr><th>Description</th><th class="amount">Qty</th><th class="amount">Unit price</th><th>Tax code</th><th class="amount">GST</th><th class="amount">Amount${d.pricing === 'inclusive' ? ' (incl. GST)' : ''}</th></tr></thead>
<tbody>
${lines}
</tbody></table>
<table class="totals"><tbody>
  <tr><th>Subtotal (excl. GST)</th><td class="amount">${formatMoney(d.net)}</td></tr>
  <tr><th>GST</th><td class="amount">${formatMoney(d.tax)}</td></tr>
  <tr class="total"><th>Total</th><td class="amount">${formatMoney(d.gross)}</td></tr>
</tbody></table>
<p>Amounts in ${e(d.currency)}.</p>
</body></html>`;
}
