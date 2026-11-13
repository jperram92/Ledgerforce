/**
 * SS-PLAT-104 visual evidence (T-0041): the GP-001 tax invoice rendered to PDF by the product's own
 * PdfRenderer (headless Chromium via playwright-core), then rasterised page by page with pdfjs-dist in
 * the test browser. It asserts the PDF's text layer, page size and page count, and saves a screenshot
 * of the rendered PDF page, not an HTML preview.
 *
 * The invoice data are GP-001's (Docs/accounting/postings.md): 1,250.00 + GST 125.00 = 1,375.00.
 * The database path (loadInvoiceDocument → PDF text) is covered by
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

test.use({ evidenceTaskId: 'T-0041' });

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

const GP001: InvoiceDocument = {
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
};

test('SS-PLAT-104 the rendered GP-001 invoice PDF shows number, ABN, GST 125.00 and total 1,375.00 on one A4 page [T-0041]', async ({
  page,
  evidence,
}) => {
  test.setTimeout(60_000);
  const renderer = new PdfRenderer();
  let pdf: Uint8Array;
  try {
    pdf = await renderer.render(renderInvoiceHtml(GP001), { timeoutMs: 30_000 });
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
        body: '<!doctype html><meta charset="utf-8"><title>GP-001 invoice PDF</title><body style="margin:0;background:#888"><div id="pages"></div></body>',
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
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n);
      const base = p.getViewport({ scale: 1 });
      sizes.push([base.width, base.height]);
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
    return { pages: doc.numPages, sizes, boxes, text: texts.join(' ').replace(/\s+/g, ' ') };
  }, ORIGIN);

  expect(result.pages).toBe(1);
  // A4 is 595.28 × 841.89 pt; Chromium writes 8.27 × 11.7 in (595.44 × 842.4 pt, rounded up in the
  // MediaBox), so the page is A4 within one point.
  const [w = 0, h = 0] = result.sizes[0] ?? [];
  expect(Math.abs(w - 595.28)).toBeLessThan(1);
  expect(Math.abs(h - 841.89)).toBeLessThan(1.5);
  expect(result.text).toContain('Tax invoice');
  expect(result.text).toContain('INV-000123');
  expect(result.text).toContain('51 824 753 556');
  expect(result.text).toMatch(/GST\s*\$125\.00/);
  expect(result.text).toMatch(/Total\s*\$1,375\.00/);
  // The header labels and values are separate columns: the invoice number starts at least 3 pt
  // (about 1 mm) after its label ends, so they never read as one word.
  const label = result.boxes['Invoice number'];
  const value = result.boxes['INV-000123'];
  if (!label || !value) throw new Error('label and value must be separate PDF text items');
  expect(value.x - (label.x + label.w)).toBeGreaterThanOrEqual(3);
  await expect(page.locator('canvas')).toHaveCount(1);

  await evidence('SS-PLAT-104', 'gp-001-invoice-pdf-page-1');
});
