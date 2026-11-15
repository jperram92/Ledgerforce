/**
 * Invoice HTML template (T-0041, design §4.3/§7.1, ADR-0045 rule 1): a tax invoice with the
 * supplier's name and ABN, the number, dates, lines, GST and total; every value escaped; no
 * scripts. Billing formats: the AU catalogue covers design §4.3 and is internally valid.
 */
import { describe, expect, it } from 'vitest';
import { AU_BILLING_FORMATS, validateBillingFormat } from './billing-formats.ts';
import {
  formatAbn,
  renderInvoiceHtml,
  type InvoiceBranding,
  type InvoiceDocument,
} from './invoice-html.ts';
import { solidPng } from './testing/solid-png.ts';

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

// ---------------- T-0165: branding and accepted payment methods ----------------

const png = solidPng(4, 2, [11, 110, 79]);
const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const brand: InvoiceBranding = {
  colour: '#0B6E4F',
  accentColour: '#F2A541',
  logo: { contentType: 'image/png', content: png },
};
const branded: InvoiceDocument = { ...doc, branding: brand };
const stripeLink = { url: 'https://buy.stripe.com/test_abc', amountDue: '1375.0000' };
const remittance = {
  accountName: 'Harbour Co <Trading>',
  bsb: '062-000',
  accountNumber: '12345678',
};

describe('Invoice branding and payment methods (T-0165)', () => {
  it('SS-UC01-15 AC-1 uses the brand colour and embeds the PNG logo as a data URI [T-0165]', () => {
    const html = renderInvoiceHtml(branded);
    expect(html).toMatch(/h1 \{[^}]*color: #0B6E4F/);
    expect(html).toMatch(/\.brand-band \{[^}]*background: #0B6E4F/);
    expect(html).toContain('<div class="brand-band"></div>');
    expect(html).toMatch(/\.pay \{[^}]*border-color: #F2A541/);
    const img = /<img class="logo" src="([^"]+)" alt="([^"]*)">/.exec(html);
    expect(img?.[1]).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(img?.[2]).toBe('Harbour Co Pty Ltd logo');
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it('SS-UC01-15 AC-1 without a logo no image element is rendered; without branding no brand styles [T-0165]', () => {
    const html = renderInvoiceHtml({ ...doc, branding: { ...brand, logo: null } });
    expect(html).not.toMatch(/<img/i);
    expect(html).toMatch(/h1 \{[^}]*color: #0B6E4F/);
    const plain = renderInvoiceHtml(doc);
    expect(plain).not.toMatch(/<img/i);
    expect(plain).not.toContain('brand-band');
  });

  it('SS-UC01-15 AC-1 embeds a JPEG logo; refuses a logo whose bytes are not its type and a colour that is not #RRGGBB [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...doc,
      branding: { ...brand, logo: { contentType: 'image/jpeg', content: jpegHead } },
    });
    expect(html).toContain(`src="data:image/jpeg;base64,${jpegHead.toString('base64')}"`);
    expect(() =>
      renderInvoiceHtml({
        ...doc,
        branding: { ...brand, logo: { contentType: 'image/png', content: jpegHead } },
      }),
    ).toThrow(/logo/);
    expect(() =>
      renderInvoiceHtml({
        ...doc,
        branding: {
          ...brand,
          logo: { contentType: 'image/svg+xml' as 'image/png', content: png },
        },
      }),
    ).toThrow(/logo/);
    expect(() =>
      renderInvoiceHtml({
        ...doc,
        branding: { ...brand, colour: 'red; } body { display: none' },
      }),
    ).toThrow(/colour/);
    expect(() =>
      renderInvoiceHtml({ ...doc, branding: { ...brand, accentColour: '#12' } }),
    ).toThrow(/colour/);
  });

  it('SS-UC01-15 AC-2 [bank_transfer] shows the bank-transfer block and no Stripe link, even when one is supplied [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['bank_transfer'],
      paymentLink: stripeLink,
    });
    expect(html).toContain('How to pay');
    expect(html).toContain('Pay by bank transfer');
    expect(html).toContain('Reference: <strong>INV-000123</strong>');
    expect(html).not.toContain('Pay online');
    expect(html).not.toContain('buy.stripe.com');
  });

  it('SS-UC01-15 AC-2 [stripe] shows the Stripe block with the link and no bank-transfer block [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['stripe'],
      paymentLink: stripeLink,
    });
    expect(html).toContain('Pay online by card (Stripe)');
    expect(html).toContain('href="https://buy.stripe.com/test_abc"');
    expect(html).toContain('Amount due $1,375.00');
    expect(html).not.toContain('Pay by bank transfer');
    // Stripe accepted but no link for this invoice (format without a link, or nothing due).
    const noLink = renderInvoiceHtml({ ...branded, acceptedPaymentMethods: ['stripe'] });
    expect(noLink).toContain('Pay online by card (Stripe)');
    expect(noLink).not.toContain('<a ');
  });

  it('SS-UC01-15 AC-2 with both methods shows both blocks, bank transfer first [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['bank_transfer', 'stripe'],
      paymentLink: stripeLink,
    });
    const bank = html.indexOf('Pay by bank transfer');
    const card = html.indexOf('Pay online by card (Stripe)');
    expect(bank).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(bank);
    expect(html).toContain('href="https://buy.stripe.com/test_abc"');
  });

  it('SS-UC01-15 AC-2 prints remittance details escaped when the document carries them, and no number otherwise (RQ-0159) [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['bank_transfer'],
      bankTransfer: remittance,
    });
    expect(html).toContain('Harbour Co &lt;Trading&gt;');
    expect(html).toContain('062-000');
    expect(html).toContain('12345678');
    const without = renderInvoiceHtml({ ...branded, acceptedPaymentMethods: ['bank_transfer'] });
    expect(without).toContain('Our bank account details are available from us on request.');
    expect(without).not.toContain('BSB');
    // Details are never printed when the company does not accept bank transfer.
    const stripeOnly = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['stripe'],
      bankTransfer: remittance,
    });
    expect(stripeOnly).not.toContain('12345678');
    expect(() =>
      renderInvoiceHtml({
        ...branded,
        acceptedPaymentMethods: ['bank_transfer'],
        bankTransfer: { ...remittance, bsb: '06200' },
      }),
    ).toThrow(/BSB/);
  });

  it('SS-UC01-15 AC-2 with no saved methods keeps the T-0073 behaviour: the link if supplied, no bank block [T-0165]', () => {
    const html = renderInvoiceHtml({ ...branded, paymentLink: stripeLink });
    expect(html).toContain('Pay online');
    expect(html).toContain('href="https://buy.stripe.com/test_abc"');
    expect(html).not.toContain('Pay by bank transfer');
    expect(renderInvoiceHtml({ ...branded, acceptedPaymentMethods: null })).not.toContain(
      'How to pay',
    );
  });

  it('SS-UC01-15 the branded template keeps the no-script, no-external-resource rules behind a CSP [T-0165]', () => {
    const html = renderInvoiceHtml({
      ...branded,
      acceptedPaymentMethods: ['bank_transfer', 'stripe'],
      paymentLink: stripeLink,
    });
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/url\(/i);
    // The only URL outside data: is the https payment link itself.
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(urls.filter((u) => !u.startsWith('data:image/'))).toEqual([stripeLink.url]);
  });
});
