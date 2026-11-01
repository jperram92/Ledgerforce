/**
 * T-0041 AC-1 contract (ADR-0045): the PDF of a GP-001 invoice, rendered by headless Chromium
 * from the HTML template, contains the invoice number, the supplier ABN, GST 125.00 and total
 * 1,375.00 as real, extractable text. Real PostgreSQL as lf_app, real Chromium, real PDF parser.
 */
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from '@ledgerforce/ar';
import { auServicesSmb } from '@ledgerforce/gl';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AU_BILLING_FORMATS, seedBillingFormats } from './billing-formats.ts';
import { renderInvoiceHtml } from './invoice-html.ts';
import { loadInvoiceDocument } from './invoice-document.ts';
import { PdfRenderer } from './pdf.ts';

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
  it('the GP-001 invoice PDF contains number, ABN, GST 125.00 and total 1,375.00', async () => {
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

  it('the renderer blocks network requests and scripts', async () => {
    const html =
      '<html><body><p id="x">static</p><img src="http://198.51.100.1/x.png">' +
      '<script>document.getElementById("x").textContent = "scripted"</script></body></html>';
    const text = await pdfText(await renderer.render(html, { timeoutMs: 15_000 }));
    expect(text).toContain('static');
    expect(text).not.toContain('scripted');
  }, 60_000);
});
