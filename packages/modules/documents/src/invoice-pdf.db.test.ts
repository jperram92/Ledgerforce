/**
 * T-0041 AC-1 contract (ADR-0045): the PDF of a GP-001 invoice, rendered by headless Chromium
 * from the HTML template, contains the invoice number, the supplier ABN, GST 125.00 and total
 * 1,375.00 as real, extractable text. Real PostgreSQL as lf_app, real Chromium, real PDF parser.
 */
import {
  approveInvoice,
  createDraftInvoice,
  setInvoiceSettings,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { auServicesSmb } from '@ledgerforce/gl';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AU_BILLING_FORMATS, seedBillingFormats } from './billing-formats.ts';
import { renderInvoiceHtml } from './invoice-html.ts';
import { loadInvoiceDocument } from './invoice-document.ts';
import { PdfRenderer } from './pdf.ts';
import { solidPng } from './testing/solid-png.ts';

let f: LedgerFixture;
let invoiceId = '';
let invoiceNo = '';
const renderer = new PdfRenderer();
const outbox: DocumentOutbox = { publish: async () => {} };

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004101');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `P${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ar_invoice_document', prefix: 'INV-' })
      .execute();
    await trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd', abn: '51824753556' })
      .where('id', '=', f.companyId)
      .execute();
    await seedTaxCodes(trx, f.companyId);
    const profiles = await seedPostingProfiles(
      trx,
      f.companyId,
      auServicesSmb,
      new Map(Object.entries(f.acct)),
    );
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'customer' })
      .execute();
    await setPartyProfiles(trx, f.companyId, p.id, {
      customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
    });
    const c = await trx
      .insertInto('app.party_contact')
      .values({
        company_id: f.companyId,
        party_id: p.id,
        name: 'Acme Accounts',
        email: 'ap@acme.example',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_contact_role')
      .values({ company_id: f.companyId, party_id: p.id, contact_id: c.id, role: 'billing_to' })
      .execute();
    const draft = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: p.id,
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '250.00',
          },
        ],
      },
      { outbox },
    );
    const posted = await approveInvoice(
      trx,
      { companyId: f.companyId, invoiceId: draft.invoiceId },
      { outbox },
    );
    invoiceId = posted.invoiceId;
    invoiceNo = posted.invoiceNo ?? '';
  });
}, 120_000);

afterAll(async () => {
  await renderer.close();
  await (f as LedgerFixture | undefined)?.close();
});

async function pdfText(pdf: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: pdf, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    for (const item of content.items) if ('str' in item) parts.push(item.str);
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

describe('T-0041: billing formats', () => {
  it('seeds the AU billing formats once per company', async () => {
    expect(await f.inTenant((trx) => seedBillingFormats(trx, f.companyId))).toBe(
      AU_BILLING_FORMATS.length,
    );
    expect(await f.inTenant((trx) => seedBillingFormats(trx, f.companyId))).toBe(0);
    const proforma = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_format')
        .select(['posted', 'number_series'])
        .where('company_id', '=', f.companyId)
        .where('code', '=', 'PROFORMA')
        .executeTakeFirstOrThrow(),
    );
    expect(proforma).toEqual({ posted: false, number_series: null });
  });
});

describe('T-0041: invoice PDF', () => {
  it('SS-PLAT-104 the GP-001 invoice PDF contains number, ABN, GST 125.00 and total 1,375.00', async () => {
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(doc.invoiceNo).toBe(invoiceNo);
    const pdf = await renderer.render(renderInvoiceHtml(doc));
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await pdfText(pdf);
    expect(text).toContain('Tax invoice');
    expect(text).toContain(invoiceNo);
    expect(text).toContain('51 824 753 556');
    expect(text).toMatch(/GST\s*\$125\.00/);
    expect(text).toMatch(/Total\s*\$1,375\.00/);
  }, 60_000);

  it('SS-PLAT-104 the renderer blocks network requests and scripts', async () => {
    const html =
      '<html><body><p id="x">static</p><img src="http://198.51.100.1/x.png">' +
      '<script>document.getElementById("x").textContent = "scripted"</script></body></html>';
    const text = await pdfText(await renderer.render(html, { timeoutMs: 15_000 }));
    expect(text).toContain('static');
    expect(text).not.toContain('scripted');
  }, 60_000);
});

// ---------------- T-0165: branding and payment methods on the real PDF ----------------

/**
 * Pages and number of painted raster images (the logo) in a PDF, read by pdfjs. pdfjs transfers
 * (detaches) the buffer it is given, so it reads a copy and the caller can still extract text.
 */
async function pdfImages(pdf: Uint8Array): Promise<{ pages: number; images: number }> {
  const d = await getDocument({ data: pdf.slice(), useSystemFonts: true }).promise;
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject]);
  let images = 0;
  for (let n = 1; n <= d.numPages; n++) {
    const ops = await (await d.getPage(n)).getOperatorList();
    images += ops.fnArray.filter((fn) => paint.has(fn)).length;
  }
  return { pages: d.numPages, images };
}

describe('T-0165: branded invoice PDF', () => {
  const logo = solidPng(240, 80, [11, 110, 79]);

  it('SS-UC01-15 AC-3 without saved settings the document has no branding or methods and the PDF no image [T-0165]', async () => {
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(doc.branding ?? null).toBeNull();
    expect(doc.acceptedPaymentMethods ?? null).toBeNull();
    const pdf = await renderer.render(renderInvoiceHtml(doc));
    expect(await pdfImages(pdf)).toEqual({ pages: 1, images: 0 });
    expect(await pdfText(pdf)).not.toContain('How to pay');
  }, 60_000);

  it('SS-UC01-15 AC-3 the saved brand colour, PNG logo and both methods reach the document, and the branded PDF renders on one page with the logo and both payment blocks [T-0165]', async () => {
    await f.inTenant((trx) =>
      setInvoiceSettings(trx, f.companyId, {
        brandColour: '#0b6e4f',
        brandAccentColour: '#F2A541',
        logo: { contentType: 'image/png', content: logo },
        acceptedPaymentMethods: ['stripe', 'bank_transfer'],
      }),
    );
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(doc.branding?.colour).toBe('#0B6E4F');
    expect(doc.branding?.accentColour).toBe('#F2A541');
    expect(doc.branding?.logo?.contentType).toBe('image/png');
    expect(Buffer.from(doc.branding?.logo?.content ?? new Uint8Array()).equals(logo)).toBe(true);
    expect(doc.acceptedPaymentMethods).toEqual(['bank_transfer', 'stripe']);
    // No remittance account can be chosen yet (RQ-0159, ADR-0079 Proposed, T-0180).
    expect(doc.bankTransfer ?? null).toBeNull();

    const html = renderInvoiceHtml(doc);
    expect(html).toContain(`data:image/png;base64,${logo.toString('base64')}`);
    const pdf = await renderer.render(html);
    expect(await pdfImages(pdf)).toEqual({ pages: 1, images: 1 });
    const text = await pdfText(pdf);
    expect(text).toContain('Tax invoice');
    expect(text).toContain(invoiceNo);
    expect(text).toMatch(/Total\s*\$1,375\.00/);
    expect(text).toContain('How to pay');
    expect(text).toContain('Pay by bank transfer');
    expect(text).toContain(`Reference: ${invoiceNo}`);
    expect(text).toContain('Pay online by card (Stripe)');
  }, 60_000);

  it('SS-UC01-15 AC-3 removing the logo leaves the colour and renders no image; [bank_transfer] alone shows no Stripe block [T-0165]', async () => {
    await f.inTenant((trx) =>
      setInvoiceSettings(trx, f.companyId, {
        logo: null,
        acceptedPaymentMethods: ['bank_transfer'],
      }),
    );
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(doc.branding).toEqual({ colour: '#0B6E4F', accentColour: '#F2A541', logo: null });
    const pdf = await renderer.render(renderInvoiceHtml(doc));
    expect(await pdfImages(pdf)).toEqual({ pages: 1, images: 0 });
    const text = await pdfText(pdf);
    expect(text).toContain('Pay by bank transfer');
    expect(text).not.toContain('Pay online');
  }, 60_000);
});
