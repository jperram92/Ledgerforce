/**
 * Invoice HTML template (T-0041, design §4.3/§7.1, ADR-0045 rule 1): a tax invoice with the
 * supplier's name and ABN, the number, dates, lines, GST and total; every value escaped; no
 * scripts. Billing formats: the AU catalogue covers design §4.3 and is internally valid.
 */
import { describe, expect, it } from 'vitest';
import { AU_BILLING_FORMATS, validateBillingFormat } from './billing-formats.ts';
import { formatAbn, renderInvoiceHtml, type InvoiceDocument } from './invoice-html.ts';

const doc: InvoiceDocument = {
  supplier: { legalName: 'Harbour Co Pty Ltd', abn: '51824753556' },
  customer: { name: 'Acme <Pty> Ltd', abn: null },
  invoiceNo: 'INV-000123',
  issueDate: '2026-11-05',
  dueDate: '2026-11-19',
  currency: 'AUD',
  pricing: 'exclusive',
  lines: [
    {
      description: 'Professional services',
      quantity: '1.0000',
      unitPrice: '1000.0000',
      taxCode: 'GST',
      net: '1000.0000',
      tax: '100.0000',
      gross: '1100.0000',
    },
    {
      description: 'Subscription <script>alert(1)</script>',
      quantity: '1.0000',
      unitPrice: '250.0000',
      taxCode: 'GST',
      net: '250.0000',
      tax: '25.0000',
      gross: '275.0000',
    },
  ],
  net: '1250.0000',
  tax: '125.0000',
  gross: '1375.0000',
};

describe('Invoice HTML (T-0041)', () => {
  it('SS-PLAT-104 preserves significant integer quantity zeros [T-0041]', () => {
    const html = renderInvoiceHtml({
      ...doc,
      lines: doc.lines.map((line, index) => ({
        ...line,
        quantity: index === 0 ? '10' : '100',
      })),
    });
    expect(html).toContain('<td class="amount">10</td>');
    expect(html).toContain('<td class="amount">100</td>');
  });

  it('SS-PLAT-104 shows a tax invoice with supplier ABN, number, dates, GST and total', () => {
    const html = renderInvoiceHtml(doc);
    expect(html).toContain('Tax invoice');
    expect(html).toContain('ABN 51 824 753 556');
    expect(html).toContain('INV-000123');
    expect(html).toContain('5 Nov 2026');
    expect(html).toContain('19 Nov 2026');
    expect(html).toMatch(/GST[^<]*<\/[a-z]+>\s*<[a-z]+[^>]*>\$125\.00/);
    expect(html).toContain('$1,375.00');
    expect(html).toContain('$1,000.00');
  });

  it('SS-PLAT-104 escapes every value and contains no script', () => {
    const html = renderInvoiceHtml(doc);
    expect(html).toContain('Acme &lt;Pty&gt; Ltd');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
  });

  it('formats an ABN in the ATO 2-3-3-3 grouping', () => {
    expect(formatAbn('51824753556')).toBe('51 824 753 556');
  });
});

describe('Billing formats (design §4.3)', () => {
  it('the AU catalogue has every standard format, each valid; only pro-forma does not post', () => {
    expect(AU_BILLING_FORMATS.map((f) => f.code)).toEqual([
      'STANDARD',
      'BATCH',
      'RECURRING',
      'MILESTONE',
      'DEPOSIT',
      'USAGE',
      'CREDIT_NOTE',
      'PROFORMA',
    ]);
    for (const f of AU_BILLING_FORMATS) expect(validateBillingFormat(f), f.code).toEqual([]);
    expect(AU_BILLING_FORMATS.filter((f) => !f.posted).map((f) => f.code)).toEqual(['PROFORMA']);
  });

  it('refuses an unknown layout, a posted format without a number series, and a bad grouping', () => {
    const standard = AU_BILLING_FORMATS[0];
    if (!standard) throw new Error('catalogue is empty');
    const bad = {
      ...standard,
      pdfLayout: 'nope',
      numberSeries: null,
      grouping: 'per_planet' as 'per_account',
    };
    expect(validateBillingFormat(bad).join('\n')).toMatch(
      /layout nope[\s\S]*number series[\s\S]*grouping per_planet/,
    );
  });
});

describe('Invoice HTML payment link (T-0073)', () => {
  it('SS-UC03-01 shows the Stripe payment link with the amount due, escaped, and nothing without one', () => {
    const html = renderInvoiceHtml({
      ...doc,
      paymentLink: { url: 'https://buy.stripe.com/test_a"b<c', amountDue: '375.0000' },
    });
    expect(html).toContain('Pay online');
    expect(html).toContain('href="https://buy.stripe.com/test_a&quot;b&lt;c"');
    expect(html).toContain('Amount due $375.00');
    expect(renderInvoiceHtml(doc)).not.toContain('Pay online');
    expect(() =>
      renderInvoiceHtml({ ...doc, paymentLink: { url: 'javascript:alert(1)', amountDue: '1' } }),
    ).toThrow(/https/);
  });
});
