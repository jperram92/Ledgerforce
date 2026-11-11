import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { PdfRenderer } from './pdf.ts';

afterEach(() => vi.restoreAllMocks());

describe('PdfRenderer timeout [T-0041]', () => {
  it('applies the document deadline to browser startup', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      setContent: vi.fn(async () => {}),
      pdf: vi.fn(async () => new Uint8Array([1])),
    };
    const context = {
      route: vi.fn(async () => {}),
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    vi.spyOn(chromium, 'launch').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(browser), 80)),
    );
    const renderer = new PdfRenderer();
    const start = Date.now();
    await expect(renderer.render('<html></html>', { timeoutMs: 15 })).rejects.toThrow(
      /PDF render exceeded 15 ms/,
    );
    expect(Date.now() - start).toBeLessThan(65);
    await renderer.close();
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('closes a browser context that arrives after the render deadline', async () => {
    const context = {
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(context), 80))),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
    const renderer = new PdfRenderer();
    await expect(renderer.render('<html></html>', { timeoutMs: 15 })).rejects.toThrow(
      /PDF render exceeded 15 ms/,
    );
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(context.close).toHaveBeenCalledOnce();
    await renderer.close();
  });
});
