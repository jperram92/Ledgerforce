/**
 * SS-UC03-01 — Invoice carries a Stripe payment link (T-0073, RQ-0100, ADR-0048).
 *
 * A posted invoice issued under a billing format with payment link "stripe" is emailed by the
 * `ar.invoice.posted` handler (T-0042); the handler asks Stripe (a local stub replaying the
 * documented Payment Links fixture — never the network) for a test-mode Payment Link for the
 * invoice's amount due and puts it in the PDF and the email. Runs against a real PostgreSQL as
 * lf_app, a real SMTP conversation and real PDF rendering.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  approveInvoice,
  createDraftInvoice,
  recordReceipt,
  type DocumentEvent,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import {
  PdfRenderer,
  renderInvoiceHtml,
  loadInvoiceDocument,
  seedBillingFormats,
} from '@ledgerforce/documents';
import { invoiceEmailHandler, SmtpSender } from '@ledgerforce/email';
import { SmtpSink } from '@ledgerforce/email/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import {
  appendManifestEntries,
  evidenceFilePath,
  resolveEvidenceContext,
} from '@ledgerforce/testing/evidence/manifest';
import { chromium } from 'playwright-core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PostalMime from 'postal-mime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeClient } from './client.ts';
import { ensureInvoicePaymentLink, stripeInvoicePaymentLinks } from './payment-link.ts';
import {
  loadCassette,
  PAYMENT_LINKS_FIXTURE,
  startRecordedStripe,
  type RecordedStripe,
} from './testing/index.ts';

const FULL_URL = 'https://buy.stripe.com/test_8x2bJ1aB3cD4eF5gH6';
const PART_URL = 'https://buy.stripe.com/test_3cI5kZ7mN8oP9qR0sT';

let f: LedgerFixture;
let profiles: SeededProfiles;
let customer = '';
let stub: RecordedStripe;
let client: StripeClient;
const sink = new SmtpSink();
const renderer = new PdfRenderer();
let sender: SmtpSender;
const published: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_t, e) => {
    published.push(e);
  },
};
let stripeInvoice = { id: '', no: '' };
let plainInvoice = { id: '', no: '' };

async function postInvoice(billingFormatCode: string | null) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: customer,
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
    if (billingFormatCode) {
      const fmt = await trx
        .selectFrom('app.billing_format')
        .select('id')
        .where('company_id', '=', f.companyId)
        .where('code', '=', billingFormatCode)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('app.sales_invoice')
        .set({ billing_format_id: fmt.id })
        .where('id', '=', d.invoiceId)
        .execute();
    }
    await approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
    const ev = published.find(
      (e) => e.topic === 'ar.invoice.posted' && e.aggregateId === d.invoiceId,
    );
    return { id: d.invoiceId, no: String(ev?.payload['invoiceNo']) };
  });
}

const eventFor = (invoiceId: string) => {
  const e = published.find((x) => x.topic === 'ar.invoice.posted' && x.aggregateId === invoiceId);
  if (!e) throw new Error(`no posted event for ${invoiceId}`);
  return {
    id: randomUUID(),
    tenantId: f.tenantId,
    companyId: e.companyId,
    topic: e.topic,
    aggregateType: e.aggregateType,
    aggregateId: e.aggregateId,
    payload: e.payload,
    createdAt: new Date(),
  };
};

async function pdfText(pdf: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: pdf, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items) if ('str' in item) parts.push(item.str);
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

/**
 * Evidence (skill `evidence`): when run with LF_TASK_ID=T-0073, screenshot the emailed HTML body
 * — the same HTML the PDF attachment is printed from — after the assertions above it passed.
 * JavaScript off and every request aborted, as the PDF renderer does (ADR-0045).
 */
async function captureEvidence(html: string, slug: string, testTitle: string) {
  if (process.env['LF_TASK_ID'] !== 'T-0073') return;
  const ctx = resolveEvidenceContext(process.env, import.meta.dirname);
  const date = new Date();
  const file = evidenceFilePath({
    evidenceRoot: ctx.evidenceRoot,
    taskId: ctx.taskId,
    scenarioId: 'SS-UC03-01',
    slug,
    date,
  });
  await mkdir(dirname(file), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      javaScriptEnabled: false,
      viewport: { width: 900, height: 1200 },
    });
    await page.route('**/*', (r) => r.abort());
    await page.setContent(html);
    await page.screenshot({ path: file, fullPage: true });
  } finally {
    await browser.close();
  }
  await appendManifestEntries(join(ctx.evidenceRoot, ctx.taskId, 'manifest.json'), ctx.taskId, [
    {
      scenario: 'SS-UC03-01',
      file: relative(ctx.repoRoot, file).split('\\').join('/'),
      test: `packages/connectors/stripe/src/stripe-link.contract.db.test.ts › ${testTitle}`,
      commit: ctx.commit,
      provider: ctx.provider,
      timestamp: date.toISOString(),
      result: 'passed',
    },
  ]);
}

const links = (invoiceId: string) =>
  f.inTenant((trx) =>
    trx
      .selectFrom('app.stripe_payment_link')
      .select(['stripe_id', 'url', 'amount_due', 'currency', 'livemode', 'status'])
      .where('invoice_id', '=', invoiceId)
      .orderBy('created_at')
      .execute(),
  );

beforeAll(async () => {
  await sink.start();
  sender = new SmtpSender({ url: sink.url, from: 'Harbour Co <billing@harbour.example>' });
  stub = await startRecordedStripe(loadCassette(PAYMENT_LINKS_FIXTURE));
  client = new StripeClient({ secretKey: 'sk_test_dummy', mode: 'test', baseUrl: stub.url });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007301');
  profiles = await seedBillingCompany(f);
  [customer = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Payer',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    await trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd', abn: '51824753556' })
      .where('id', '=', f.companyId)
      .execute();
    await seedBillingFormats(trx, f.companyId);
  });
  stripeInvoice = await postInvoice('STANDARD');
  plainInvoice = await postInvoice(null);
  Object.assign(stub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    invoiceId: stripeInvoice.id,
    invoiceNo: stripeInvoice.no,
  });
}, 180_000);

afterAll(async () => {
  await renderer.close();
  await sink.stop();
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC03-01: Invoice carries a Stripe payment link', () => {
  it('SS-UC03-01 a create rolled back after the Stripe call is retried with the same idempotency key and stores one link', async () => {
    const rolledBack = await f
      .inTenant(async (trx) => {
        await ensureInvoicePaymentLink(trx, client, f.companyId, stripeInvoice.id);
        throw new Error('simulated crash after the Stripe call');
      })
      .catch((e: unknown) => e);
    expect(String(rolledBack)).toContain('simulated crash');
    expect(await links(stripeInvoice.id)).toEqual([]);
    expect(stub.received).toHaveLength(1);
  });

  it('SS-UC03-01 the emailed posted invoice (payment method Stripe) has a test-mode Payment Link for the amount due in its PDF and email', async () => {
    const handler = invoiceEmailHandler({
      sender,
      renderer,
      paymentLinks: stripeInvoicePaymentLinks(client),
    });
    await f.inTenant((trx) => handler.handle(trx, eventFor(stripeInvoice.id)));

    // Stripe: the retried create carried the same idempotency key and matched the fixture exactly
    // (amount due 1,375.00 → 137500 cents, AUD, one completed payment, invoice metadata).
    expect(stub.mismatches).toEqual([]);
    expect(stub.received.map((r) => [r.idempotencyKey, r.matched])).toEqual([
      [`lf-plink-v1-${stripeInvoice.id}-137500`, 'create-link-amount-due-1375.00'],
      [`lf-plink-v1-${stripeInvoice.id}-137500`, 'create-link-amount-due-1375.00'],
    ]);
    expect(stub.received[1]?.form['metadata[lf_invoice_id]']).toBe(stripeInvoice.id);

    // Stored once, test mode, for the amount due.
    expect(await links(stripeInvoice.id)).toEqual([
      {
        stripe_id: 'plink_1SQbTestFullAmount0001',
        url: FULL_URL,
        amount_due: '1375.0000',
        currency: 'AUD',
        livemode: false,
        status: 'active',
      },
    ]);

    // Email: one message; the text and HTML bodies and the PDF attachment carry the link.
    expect(sink.messages).toHaveLength(1);
    const mail = await PostalMime.parse(sink.messages[0]?.raw ?? '');
    expect(mail.subject).toBe(`Tax invoice ${stripeInvoice.no} from Harbour Co Pty Ltd`);
    expect(mail.text).toContain(`Pay online: ${FULL_URL}`);
    expect(mail.text).toContain('Amount due: $1,375.00');
    expect(mail.html).toContain(`href="${FULL_URL}"`);
    const pdf = mail.attachments.find((a) => a.mimeType === 'application/pdf');
    expect(pdf?.filename).toBe(`${stripeInvoice.no}.pdf`);
    const text = await pdfText(new Uint8Array(pdf?.content as ArrayBuffer));
    expect(text).toContain('Pay online');
    expect(text).toContain(FULL_URL);
    expect(text).toMatch(/Amount due \$1,375\.00/);
    await captureEvidence(
      String(mail.html),
      'invoice email pay online link',
      'SS-UC03-01 the emailed posted invoice (payment method Stripe) has a test-mode Payment Link for the amount due in its PDF and email',
    );
  }, 60_000);

  it('SS-UC03-01 rendering again reuses the stored link without calling Stripe', async () => {
    const before = stub.received.length;
    const link = await f.inTenant((trx) =>
      ensureInvoicePaymentLink(trx, client, f.companyId, stripeInvoice.id),
    );
    expect(link).toEqual({
      stripeId: 'plink_1SQbTestFullAmount0001',
      url: FULL_URL,
      amountDue: '1375.0000',
      currency: 'AUD',
      livemode: false,
    });
    expect(stub.received).toHaveLength(before);
  });

  it('SS-UC03-01 an invoice whose billing format has no Stripe payment method gets no link and no Stripe call', async () => {
    const before = stub.received.length;
    const handler = invoiceEmailHandler({
      sender,
      renderer,
      paymentLinks: stripeInvoicePaymentLinks(client),
    });
    await f.inTenant((trx) => handler.handle(trx, eventFor(plainInvoice.id)));
    expect(stub.received).toHaveLength(before);
    expect(await links(plainInvoice.id)).toEqual([]);
    const mail = await PostalMime.parse(sink.messages.at(-1)?.raw ?? '');
    expect(mail.subject).toBe(`Tax invoice ${plainInvoice.no} from Harbour Co Pty Ltd`);
    expect(mail.text).not.toContain('Pay online');
    expect(mail.html).not.toContain('buy.stripe.com');
  }, 60_000);

  it('SS-UC03-01 after a part payment the old link is deactivated and a new one is created for the new amount due', async () => {
    await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: customer,
        receiptDate: '2026-11-10',
        amount: '1000.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'part-1',
        allocations: [{ invoiceId: stripeInvoice.id, amount: '1000.00' }],
      }),
    );
    const html = await f.inTenant(async (trx) => {
      const link = await ensureInvoicePaymentLink(trx, client, f.companyId, stripeInvoice.id);
      const doc = await loadInvoiceDocument(trx, f.companyId, stripeInvoice.id);
      return renderInvoiceHtml({
        ...doc,
        ...(link ? { paymentLink: { url: link.url, amountDue: link.amountDue } } : {}),
      });
    });
    expect(stub.mismatches).toEqual([]);
    expect(stub.received.slice(-2).map((r) => r.matched)).toEqual([
      'deactivate-link-after-amount-due-changed',
      'create-link-amount-due-375.00-after-part-payment',
    ]);
    expect(
      (await links(stripeInvoice.id)).map((l) => [l.stripe_id, l.amount_due, l.status]),
    ).toEqual([
      ['plink_1SQbTestFullAmount0001', '1375.0000', 'deactivated'],
      ['plink_1SQbTestPartAmount0002', '375.0000', 'active'],
    ]);
    expect(html).toContain(`href="${PART_URL}"`);
    expect(html).toContain('Amount due $375.00');
    expect(html).not.toContain(FULL_URL);
  });
});
