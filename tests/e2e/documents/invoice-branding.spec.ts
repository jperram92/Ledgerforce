/**
 * SS-UC01-15 visual evidence (T-0165): a GP-001 tax invoice with the company's branding (brand
 * colour, accent colour, PNG logo) and both accepted payment methods (bank transfer, Stripe with a
 * test-mode link), rendered to PDF by the product's own PdfRenderer (headless Chromium via
 * playwright-core) and rasterised with pdfjs-dist in the test browser. It asserts the PDF's text
 * layer, the page count and that the logo is painted, then saves a screenshot of the PDF page.
 *
 * No remittance account details are printed: choosing the account awaits ADR-0079 (RQ-0159,
 * T-0180), so the bank-transfer block says the details are available on request. The database
 * path (settings → loadInvoiceDocument → PDF) is covered by
 * packages/modules/documents/src/invoice-pdf.db.test.ts.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test, expect } from '@ledgerforce/testing/evidence';
import {
  PdfRenderer,
  renderInvoiceHtml,
  type InvoiceDocument,
} from '../../../packages/modules/documents/src/index.ts';
import { solidPng } from '../../../packages/modules/documents/src/testing/solid-png.ts';

test.use({ evidenceTaskId: 'T-0165' });

const DOCUMENTS = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'modules',
  'documents',
);
const PDFJS_BUILD = join(
  dirname(createRequire(join(DOCUMENTS, 'package.json')).resolve('pdfjs-dist/package.json')),
  'build',
);
const ORIGIN = 'http://lf-evidence.invalid';

const BRANDED: InvoiceDocument = {
  supplier: { legalName: 'Northwind Consulting Pty Ltd', abn: '51824753556' },
  customer: { name: 'Acme Pty Ltd', abn: null },
  invoiceNo: 'INV-000123',
  issueDate: '2026-11-03',
  dueDate: '2026-12-03',
  currency: 'AUD',
  pricing: 'exclusive',
  lines: [
    {
      description: 'Consulting services, October',
      quantity: '10.0000',
      unitPrice: '125.0000',
      taxCode: 'GST',
      net: '1250.0000',
      tax: '125.0000',
      gross: '1375.0000',
    },
  ],
  net: '1250.0000',
  tax: '125.0000',
  gross: '1375.0000',
  branding: {
    colour: '#0B6E4F',
    accentColour: '#F2A541',
    logo: { contentType: 'image/png', content: solidPng(240, 80, [11, 110, 79]) },
  },
  acceptedPaymentMethods: ['bank_transfer', 'stripe'],
  paymentLink: { url: 'https://buy.stripe.com/test_t0165evidence', amountDue: '1375.0000' },
};

test('SS-UC01-15 the branded invoice PDF shows the logo, brand colour and both payment methods on one A4 page [T-0165]', async ({
  page,
  evidence,
}) => {
  test.setTimeout(60_000);
  const renderer = new PdfRenderer();
  let pdf: Uint8Array;
  try {
    pdf = await renderer.render(renderInvoiceHtml(BRANDED), { timeoutMs: 30_000 });
  } finally {
    await renderer.close();
  }
  expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');

  // Serve pdfjs and the PDF bytes from one http origin (module scripts do not load from file://).
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/invoice.pdf') {
      return route.fulfill({ body: Buffer.from(pdf), contentType: 'application/pdf' });
    }
    if (path === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><title>Branded invoice PDF</title><body style="margin:0;background:#888"><div id="pages"></div></body>',
      });
    }
    const file = path.slice(1);
    if (!/^pdf(\.worker)?\.mjs$/.test(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: readFileSync(join(PDFJS_BUILD, file)),
      contentType: 'text/javascript',
    });
  });
  await page.setViewportSize({ width: 900, height: 1300 });
  await page.goto(`${ORIGIN}/`);

  const result = await page.evaluate(async (origin) => {
    const pdfjs = await import(`${origin}/pdf.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${origin}/pdf.worker.mjs`;
    const doc = await pdfjs.getDocument({ url: `${origin}/invoice.pdf` }).promise;
    const texts: string[] = [];
    const boxes: Record<string, { x: number; w: number }> = {};
    const sizes: number[][] = [];
    let images = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const base = p.getViewport({ scale: 1 });
      sizes.push([base.width, base.height]);
      const ops = await p.getOperatorList();
      images += ops.fnArray.filter(
        (fn: number) =>
          fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject,
      ).length;
      const content = await p.getTextContent();
      for (const item of content.items) {
        if (!('str' in item)) continue;
        texts.push(item.str);
        boxes[item.str.trim()] ??= { x: item.transform[4], w: item.width };
      }
      const viewport = p.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText =
        'display:block;margin:16px auto;box-shadow:0 2px 8px #0006;background:#fff';
      const host = document.getElementById('pages');
      const ctx = canvas.getContext('2d');
      if (!host || !ctx) throw new Error('evidence page has no #pages host or 2D canvas');
      host.appendChild(canvas);
      await p.render({ canvasContext: ctx, viewport }).promise;
    }
    return {
      pages: doc.numPages,
      sizes,
      boxes,
      images,
      text: texts.join(' ').replace(/\s+/g, ' '),
    };
  }, ORIGIN);

  expect(result.pages).toBe(1);
  // A4 is 595.28 × 841.89 pt; Chromium writes 8.27 × 11.7 in (595.44 × 842.4 pt, rounded up in the
  // MediaBox), so the page is A4 within one point.
  const [w = 0, h = 0] = result.sizes[0] ?? [];
  expect(Math.abs(w - 595.28)).toBeLessThan(1);
  expect(Math.abs(h - 841.89)).toBeLessThan(1.5);
  expect(result.images).toBe(1);
  expect(result.text).toContain('Tax invoice');
  expect(result.text).toContain('INV-000123');
  expect(result.text).toMatch(/Total\s*\$1,375\.00/);
  expect(result.text).toContain('How to pay');
  expect(result.text).toContain('Pay by bank transfer');
  expect(result.text).toContain('Reference: INV-000123');
  expect(result.text).toContain('Pay online by card (Stripe)');
  expect(result.text).toContain('https://buy.stripe.com/test_t0165evidence');
  await expect(page.locator('canvas')).toHaveCount(1);

  await evidence('SS-UC01-15', 'branded-invoice-pdf-page-1');
});
