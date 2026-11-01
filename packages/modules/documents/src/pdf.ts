/**
 * HTML → PDF with headless Chromium through playwright-core (ADR-0045, T-0041).
 *
 * Rules (ADR-0045): the page receives a complete HTML string (setContent; no URL is navigated
 * to); JavaScript is disabled and every network request is aborted, so a template can neither
 * run code nor fetch anything; one browser per renderer, one page per document, a timeout per
 * render. A4 with printed backgrounds.
 */
import { chromium, type Browser } from 'playwright-core';

export interface RenderOptions {
  /** Upper bound for one document, default 30 s. */
  readonly timeoutMs?: number;
}

export class PdfRenderer {
  #browser: Promise<Browser> | null = null;

  private browser(): Promise<Browser> {
    this.#browser ??= chromium.launch({ headless: true });
    return this.#browser;
  }

  async render(html: string, opts: RenderOptions = {}): Promise<Uint8Array> {
    const timeout = opts.timeoutMs ?? 30_000;
    const browser = await this.browser();
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      await page.setContent(html, { waitUntil: 'load', timeout });
      // page.pdf() takes no timeout of its own: bound it here (ADR-0045 rule 4).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pdf = await Promise.race([
        page.pdf({ format: 'A4', printBackground: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`PDF render exceeded ${String(timeout)} ms`));
          }, timeout);
        }),
      ]).finally(() => {
        clearTimeout(timer);
      });
      return new Uint8Array(pdf);
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = null;
    if (b) await (await b).close();
  }
}
