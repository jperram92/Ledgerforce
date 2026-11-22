/**
 * T-0041 AC-1 contract (ADR-0045): the PDF of a GP-001 invoice, rendered by headless Chromium
 * from the HTML template, contains the invoice number, the supplier ABN, GST 125.00 and total
 * 1,375.00 as real, extractable text. Real PostgreSQL as lf_app, real Chromium, real PDF parser.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  approveInvoice,
  approveRemittanceAccountChange,
  createDraftInvoice,
  requestRemittanceAccountChange,
  setInvoiceSettings,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { auServicesSmb } from '@ledgerforce/gl';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { seedPostingProfiles, setPartyProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AU_BILLING_FORMATS, seedBillingFormats } from './billing-formats.ts';
import { REMITTANCE_PHONE_CHECK, renderInvoiceHtml } from './invoice-html.ts';
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
    // No remittance account is designated here (and no KMS is given), so none prints (T-0180).
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

// ---------------- T-0195 security review r11 F5: logos saved before the cleaner ----------------

describe('SS-PLAT-171: a logo saved before T-0195 is cleaned, or left out, before it reaches an invoice', () => {
  const storeRaw = (contentType: string, bytes: Buffer) =>
    f.admin.query(
      'UPDATE app.ar_settings SET logo = $1, logo_content_type = $2 WHERE tenant_id = $3 AND company_id = $4',
      [bytes, contentType, f.tenantId, f.companyId],
    );

  it('SS-PLAT-171 F5 a legacy JPEG with Exif reaches the document without its metadata [T-0195]', async () => {
    const exif = readFileSync(
      join(import.meta.dirname, '..', '..', 'ar', 'src', 'testing', 'logos', 'logo-exif.jpg'),
    );
    expect(exif.includes('Jane Secret')).toBe(true);
    await storeRaw('image/jpeg', exif);
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    const bytes = Buffer.from(doc.branding?.logo?.content ?? new Uint8Array());
    expect(doc.branding?.logo?.contentType).toBe('image/jpeg');
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(bytes.includes('Jane')).toBe(false);
    expect(bytes.includes('Exif')).toBe(false);
  });

  it('SS-PLAT-171 F5 a legacy logo that fails the checks is left out and the invoice still renders [T-0195]', async () => {
    await storeRaw(
      'image/png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('<html>legacy</html>'),
      ]),
    );
    const doc = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(doc.branding?.logo ?? null).toBeNull();
    expect(doc.branding?.colour).toBe('#0B6E4F');
    const pdf = await renderer.render(renderInvoiceHtml(doc));
    expect(await pdfImages(pdf)).toEqual({ pages: 1, images: 0 });
  }, 60_000);
});

// ---------------- T-0180: the designated remittance account on the real PDF ----------------

describe('SS-UC01-16: the invoice prints the designated remittance account (ADR-0079)', () => {
  const kms = LocalKeyringKms.fromJson(
    JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
  );
  let aud = '';
  let usd = '';

  async function designate(bankAccountId: string): Promise<void> {
    const maker = await f.addUser('finance_admin');
    const checker = await f.addUser('owner');
    const changeId = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId,
        bankAccountId,
        requestedBy: maker,
      }),
    );
    await f.inTenant((trx) =>
      approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId,
        approvedBy: checker,
      }),
    );
  }

  beforeAll(async () => {
    await f.inTenant(async (trx) => {
      aud = await createCompanyBankAccount(trx, kms, f.companyId, {
        glAccountId: f.acct['1010'] ?? '',
        name: 'Operating',
        bsb: '062000',
        accountNumber: '10203040',
        accountName: 'Harbour Co Pty Ltd',
        currency: 'AUD',
      });
      usd = await createCompanyBankAccount(trx, kms, f.companyId, {
        glAccountId: f.acct['1020'] ?? '',
        name: 'USD receipts',
        bsb: '083004',
        accountNumber: '55667788',
        accountName: 'Harbour Co USD',
        currency: 'USD',
      });
      await setInvoiceSettings(trx, f.companyId, { acceptedPaymentMethods: ['bank_transfer'] });
    });
    await designate(aud);
  }, 60_000);

  it('SS-UC01-16 AC-2 with a KMS the document carries the decrypted remittance account and the PDF prints it with the phone line [T-0180]', async () => {
    const doc = await f.inTenant((trx) =>
      loadInvoiceDocument(trx, f.companyId, invoiceId, { kms }),
    );
    expect(doc.bankTransfer).toEqual({
      accountName: 'Harbour Co Pty Ltd',
      bsb: '062-000',
      accountNumber: '10203040',
    });
    const text = await pdfText(await renderer.render(renderInvoiceHtml(doc)));
    expect(text).toContain('Pay by bank transfer');
    expect(text).toContain('Harbour Co Pty Ltd');
    expect(text).toContain('062-000');
    expect(text).toContain('10203040');
    expect(text).toContain(`Reference: ${invoiceNo}`);
    expect(text).toContain(REMITTANCE_PHONE_CHECK);
  }, 60_000);

  it('SS-UC01-16 AC-2 without a KMS, or without bank transfer accepted, nothing is decrypted and no number prints [T-0180]', async () => {
    const noKms = await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId));
    expect(noKms.bankTransfer ?? null).toBeNull();
    expect(renderInvoiceHtml(noKms)).toContain(
      'Our bank account details are available from us on request.',
    );
    await f.inTenant((trx) =>
      setInvoiceSettings(trx, f.companyId, { acceptedPaymentMethods: ['stripe'] }),
    );
    const stripeOnly = await f.inTenant((trx) =>
      loadInvoiceDocument(trx, f.companyId, invoiceId, { kms }),
    );
    expect(stripeOnly.bankTransfer ?? null).toBeNull();
    await f.inTenant((trx) =>
      setInvoiceSettings(trx, f.companyId, { acceptedPaymentMethods: ['bank_transfer'] }),
    );
  });

  it('SS-UC01-16 AC-2 an account in another currency than the invoice is not printed [T-0180]', async () => {
    await designate(usd);
    const doc = await f.inTenant((trx) =>
      loadInvoiceDocument(trx, f.companyId, invoiceId, { kms }),
    );
    expect(doc.currency).toBe('AUD');
    expect(doc.bankTransfer ?? null).toBeNull();
    await designate(aud);
  });

  it('SS-UC01-16 AC-2 the clear number is stored nowhere: not in the outbox, the change records or the settings [T-0180]', async () => {
    await f.inTenant((trx) => loadInvoiceDocument(trx, f.companyId, invoiceId, { kms }));
    for (const table of [
      'app.outbox_event',
      'app.remittance_account_change',
      'app.ar_settings',
      'audit.audit_log',
    ]) {
      const r = await f.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} t WHERE to_jsonb(t)::text LIKE '%10203040%'`,
      );
      expect(r.rows[0]?.n, table).toBe('0');
    }
  });
});
