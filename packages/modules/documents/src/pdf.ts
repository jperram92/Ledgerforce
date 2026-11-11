/**
 * HTML → PDF with headless Chromium through playwright-core (ADR-0045, T-0041).
 *
 * Rules (ADR-0045): the page receives a complete HTML string (setContent; no URL is navigated
 * to); JavaScript is disabled and every network request is aborted, so a template can neither
 * run code nor fetch anything; one browser per renderer, one page per document, a timeout per
 * render. A4 with printed backgrounds.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

export interface RenderOptions {
  /** Upper bound for one document, default 30 s. */
  readonly timeoutMs?: number;
}

function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  timeout: number,
  onLateValue?: (value: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void operation.then(
      (value) => onLateValue?.(value),
      () => {},
    );
    return Promise.reject(new Error(`PDF render exceeded ${String(timeout)} ms`));
  }
  const guarded = operation.then((value) => {
    if (expired) onLateValue?.(value);
    return value;
  });
  return Promise.race([
    guarded,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`PDF render exceeded ${String(timeout)} ms`));
      }, remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function closeQuietly(context: BrowserContext): void {
  void context.close().catch(() => {});
}

export class PdfRenderer {
  #browser: Promise<Browser> | null = null;

  private browser(): Promise<Browser> {
    if (!this.#browser) {
      const pending = chromium.launch({ headless: true });
      this.#browser = pending;
      void pending.catch(() => {
        if (this.#browser === pending) this.#browser = null;
      });
    }
    return this.#browser;
  }

  async render(html: string, opts: RenderOptions = {}): Promise<Uint8Array> {
    const timeout = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    const browser = await withinDeadline(this.browser(), deadline, timeout);
    let context: BrowserContext | null = null;
    try {
      context = await withinDeadline(
        browser.newContext({ javaScriptEnabled: false, offline: true }),
        deadline,
        timeout,
        closeQuietly,
      );
      await withinDeadline(
        context.route('**/*', (route) => route.abort()),
        deadline,
        timeout,
      );
      const page = await withinDeadline(context.newPage(), deadline, timeout);
      page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
      await withinDeadline(
        page.setContent(html, { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) }),
        deadline,
        timeout,
      );
      const pdf = await withinDeadline(
        page.pdf({ format: 'A4', printBackground: true }),
        deadline,
        timeout,
      );
      return new Uint8Array(pdf);
    } finally {
      if (context) {
        const closing = context.close();
        if (Date.now() < deadline) await withinDeadline(closing, deadline, timeout);
        else void closing.catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = null;
    if (b) await (await b).close();
  }
}
