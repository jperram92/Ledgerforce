/**
 * Invoice HTML template, layout `invoice-v1` (T-0041, design §4.3/§7.1, ADR-0045 rule 1).
 *
 * A pure function of the document: the same HTML is the screen preview, the email body and the
 * PDF source. Every value is HTML-escaped; there is no script and no external resource. It shows
 * what an Australian tax invoice needs: the words "Tax invoice", the supplier's identity and ABN,
 * the date and number, each item with its GST, and the total GST and total payable.
 * Amounts are formatted from decimal strings (no floating point, AGENTS.md §4).
 *
 * Branding and how to pay (T-0165, design §4.1 step 8, RQ-0159): the company's brand colours
 * (re-checked as #RRGGBB before they reach the CSS), its optional logo (embedded only as a data URI
 * of a PNG/JPEG whose magic bytes are re-checked here), and one block per accepted payment method.
 * A Content-Security-Policy meta allows nothing but inline styles and data: images, so the page
 * can neither run script nor load anything, also outside the PDF renderer (ADR-0045).
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';

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
  /**
   * Online payment link for the amount due (T-0073: a Stripe Payment Link), when the invoice's
   * billing format offers one. `amountDue` is NUMERIC text; the URL must be https.
   */
  readonly paymentLink?: InvoicePaymentLinkView;
  /** The company's invoice branding (T-0165); absent or null when nothing is saved. */
  readonly branding?: InvoiceBranding | null;
  /**
   * The company's accepted payment methods (design §4.1 step 8). Absent or null when the company
   * has saved none: then only a supplied payment link is shown (the T-0073 behaviour).
   */
  readonly acceptedPaymentMethods?: readonly InvoicePaymentMethod[] | null;
  /**
   * Remittance details of the company's receiving account, printed in the bank-transfer block.
   * Nothing fills them yet: choosing the account and printing its number await ADR-0079 (T-0180).
   */
  readonly bankTransfer?: InvoiceRemittanceView | null;
}

export type InvoicePaymentMethod = 'bank_transfer' | 'stripe';

export interface InvoiceBranding {
  /** #RRGGBB. */
  readonly colour: string | null;
  readonly accentColour: string | null;
  readonly logo: {
    readonly contentType: 'image/png' | 'image/jpeg';
    readonly content: Uint8Array;
  } | null;
}

export interface InvoiceRemittanceView {
  readonly accountName: string;
  /** NNN-NNN. */
  readonly bsb: string;
  readonly accountNumber: string;
}

export interface InvoicePaymentLinkView {
  readonly url: string;
  readonly amountDue: string;
}

/**
 * Port for the payment link shown on an invoice (implemented by the Stripe connector, T-0073):
 * returns the link for the invoice's current amount due, creating it if needed, or null when the
 * invoice's billing format has no online payment method or nothing is due.
 */
export interface InvoicePaymentLinkProvider {
  ensure(
    trx: Transaction<Database>,
    companyId: string,
    invoiceId: string,
  ): Promise<InvoicePaymentLinkView | null>;
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
const quantity = (q: string) => {
  if (!q.includes('.')) return q || '0';
  return q.replace(/0+$/, '').replace(/\.$/, '') || '0';
};

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
  .meta td:first-child { padding-right: 4mm; }
  .pay { margin-top: 8mm; padding: 3mm 4mm; border: 1px solid #333; }
  .pay a { color: #0b3d91; word-break: break-all; }
  .pay + .pay { margin-top: 3mm; }
  h2.how { font-size: 12pt; margin: 8mm 0 0; }
  h2.how + .pay { margin-top: 3mm; }
  .remit { margin-top: 1.5mm; }
  .logo { display: block; max-height: 22mm; max-width: 70mm; margin-bottom: 4mm; }
`;

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const COLOUR = /^#[0-9a-f]{6}$/i;
const LOGO_MAGIC: Record<string, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

function colour(c: string | null, what: string): string | null {
  if (c === null) return null;
  if (!COLOUR.test(c)) throw new Error(`the ${what} colour must be #RRGGBB`);
  return c.toUpperCase();
}

/** Extra CSS for the brand colours (validated, so nothing else can reach the style sheet). */
function brandStyle(b: InvoiceBranding): string {
  const main = colour(b.colour, 'brand');
  const accent = colour(b.accentColour, 'accent');
  const rules: string[] = [];
  if (main) {
    rules.push(
      `h1 { color: ${main}; }`,
      `thead th { border-bottom-color: ${main}; }`,
      `.totals tr.total th, .totals tr.total td { border-top-color: ${main}; }`,
      `.brand-band { height: 3mm; background: ${main}; margin-bottom: 5mm; }`,
    );
  }
  if (accent ?? main) rules.push(`.pay { border-color: ${accent ?? main ?? ''}; }`);
  return rules.join('\n  ');
}

function logoHtml(b: InvoiceBranding, supplier: string): string {
  if (!b.logo) return '';
  const magic = Object.hasOwn(LOGO_MAGIC, b.logo.contentType)
    ? LOGO_MAGIC[b.logo.contentType]
    : undefined;
  const bytes = b.logo.content;
  if (!magic || bytes.length === 0 || !magic.every((x, i) => bytes[i] === x)) {
    throw new Error('the logo must be a PNG or JPEG image matching its content type');
  }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  return `<img class="logo" src="data:${b.logo.contentType};base64,${data}" alt="${escapeHtml(supplier)} logo">`;
}

function paymentLinkHtml(p: InvoicePaymentLinkView): string {
  if (!/^https:\/\/\S+$/.test(p.url)) throw new Error('payment link URL must be https');
  const url = escapeHtml(p.url);
  return `<div class="pay"><strong>Pay online</strong> — Amount due ${formatMoney(p.amountDue)}<br><a href="${url}">${url}</a></div>`;
}

function bankTransferHtml(d: InvoiceDocument): string {
  const e = escapeHtml;
  const r = d.bankTransfer;
  let details = '<br>Our bank account details are available from us on request.';
  if (r) {
    if (!/^\d{3}-\d{3}$/.test(r.bsb)) throw new Error('the BSB must be NNN-NNN');
    details =
      `<table class="meta remit"><tbody>` +
      `<tr><td>Account name</td><td>${e(r.accountName)}</td></tr>` +
      `<tr><td>BSB</td><td>${e(r.bsb)}</td></tr>` +
      `<tr><td>Account number</td><td>${e(r.accountNumber)}</td></tr>` +
      `</tbody></table>`;
  }
  return (
    `<div class="pay pay-bank"><strong>Pay by bank transfer</strong>${details}` +
    `<br>Reference: <strong>${e(d.invoiceNo)}</strong></div>`
  );
}

function stripeHtml(p: InvoicePaymentLinkView | undefined): string {
  if (!p) {
    return '<div class="pay pay-stripe"><strong>Pay online by card (Stripe)</strong><br>Ask us for a secure payment link.</div>';
  }
  if (!/^https:\/\/\S+$/.test(p.url)) throw new Error('payment link URL must be https');
  const url = escapeHtml(p.url);
  return `<div class="pay pay-stripe"><strong>Pay online by card (Stripe)</strong> — Amount due ${formatMoney(p.amountDue)}<br><a href="${url}">${url}</a></div>`;
}

/** The payment section: one block per accepted method, or the T-0073 link when none is saved. */
function paymentHtml(d: InvoiceDocument): string {
  const methods = d.acceptedPaymentMethods;
  if (!methods) return d.paymentLink ? paymentLinkHtml(d.paymentLink) : '';
  const blocks: string[] = [];
  if (methods.includes('bank_transfer')) blocks.push(bankTransferHtml(d));
  if (methods.includes('stripe')) blocks.push(stripeHtml(d.paymentLink));
  return blocks.length ? `<h2 class="how">How to pay</h2>\n${blocks.join('\n')}` : '';
}

export function renderInvoiceHtml(d: InvoiceDocument): string {
  const e = escapeHtml;
  const brand = d.branding ?? null;
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
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${e(d.invoiceNo)}</title><style>${STYLE}${brand ? `\n  ${brandStyle(brand)}\n` : ''}</style></head>
<body>
${brand?.colour ? '<div class="brand-band"></div>\n' : ''}${brand ? logoHtml(brand, d.supplier.legalName) : ''}<h1>Tax invoice</h1>
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
${paymentHtml(d)}
<p>Amounts in ${e(d.currency)}.</p>
</body></html>`;
}
