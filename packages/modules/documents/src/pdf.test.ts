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
    await expect(renderer.render('<html></html>', { timeoutMs: 15 })).rejects.toThrow(
      /PDF render exceeded 15 ms/,
    );
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

  it('uses the remaining deadline for PDF generation and closes the context', async () => {
    const context = {
      route: vi.fn(async () => {}),
      newPage: vi.fn(async () => ({
        setDefaultTimeout: vi.fn(),
        setContent: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }),
        pdf: vi.fn(() => new Promise<Uint8Array>(() => {})),
      })),
      close: vi.fn(async () => {}),
    };
    const browser = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
    const renderer = new PdfRenderer();

    await expect(renderer.render('<html></html>', { timeoutMs: 60 })).rejects.toThrow(
      /PDF render exceeded 60 ms/,
    );
    expect(context.close).toHaveBeenCalledOnce();
    await renderer.close();
  });

  it('retries browser startup after a launch failure', async () => {
    const browser = {
      newContext: vi.fn(async () => ({
        route: vi.fn(async () => {}),
        newPage: vi.fn(async () => ({
          setDefaultTimeout: vi.fn(),
          setContent: vi.fn(async () => {}),
          pdf: vi.fn(async () => new Uint8Array([1])),
        })),
        close: vi.fn(async () => {}),
      })),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const launch = vi
      .spyOn(chromium, 'launch')
      .mockRejectedValueOnce(new Error('temporary startup failure'))
      .mockResolvedValueOnce(browser);
    const renderer = new PdfRenderer();

    await expect(renderer.render('<html></html>')).rejects.toThrow('temporary startup failure');
    await expect(renderer.render('<html></html>')).resolves.toEqual(new Uint8Array([1]));
    expect(launch).toHaveBeenCalledTimes(2);
    await renderer.close();
  });
});
