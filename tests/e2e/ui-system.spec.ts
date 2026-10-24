/**
 * SS-PLAT-29 — the Timeline components (@ledgerforce/ui) honour P3, P13, P15 and the genericness
 * probes (T-0106). A static fixture page (packages/ui/harness, no Storybook) renders every component
 * with the Harbour & Co data. It is served by an in-process Vite dev server (Vite comes with Vitest;
 * `createViteServer` from `vitest/node`), so nothing is built to disk and workers never race.
 *
 * Checks per viewport (1440, 390) and theme (light, dark):
 *  - page basics: one <h1>, a <title>, <main>, lang en-AU, no console errors, no external requests;
 *  - P3: every [data-amount] is right-aligned with tabular figures and matches the money pattern;
 *    negatives are in parentheses and carry "minus" in their accessible text;
 *  - P13: every [data-open-item] has a non-empty data-turn and data-due;
 *  - P15: every [data-series="expected"] is dashed and labelled "expected"; the actual cash series
 *    ends at [data-last-statement];
 *  - no horizontal scroll; axe-core WCAG 2.0/2.1/2.2 A+AA: 0 violations;
 *  - genericness probes (RQ-0084, DL-0065): no box-shadow, no radius > 8px on containers, no tracked
 *    all-caps labels, no purple/indigo, no middle-dot meta strings, no arrows.
 * Screenshots go to .agent/evidence/T-0106/ through the evidence fixture.
 */
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { createViteServer } from 'vitest/node';
import { test, expect } from '@ledgerforce/testing/evidence';

const HARNESS = resolve(import.meta.dirname, '..', '..', 'packages', 'ui', 'harness');

let server: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.use({ evidenceTaskId: 'T-0106' });

test.beforeAll(async () => {
  server = await createViteServer({
    root: HARNESS,
    configFile: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const addr = server.httpServer?.address();
  if (!addr || typeof addr === 'string') throw new Error('harness server has no port');
  origin = `http://127.0.0.1:${String(addr.port)}`;
});

test.afterAll(async () => {
  await server?.close();
});

interface Probe {
  shadows: string[];
  bigRadius: string[];
  caps: string[];
  purple: string[];
  dots: number;
  arrows: number;
}

/** The genericness probes of Docs/ui/research/tools/shot.mjs, as one page function. */
function genericnessProbe(): Probe {
  const parse = (c: string) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m?.[1]) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map((x) => Number.parseFloat(x));
    return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p.length > 3 ? (p[3] ?? 1) : 1 };
  };
  const name = (el: Element) =>
    `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`;
  const out: Probe = { shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (cs.boxShadow !== 'none') out.shadows.push(name(el));
    const r = el.getBoundingClientRect();
    if (r.width > 120 && r.height > 60 && Number.parseFloat(cs.borderTopLeftRadius) > 8) {
      out.bigRadius.push(name(el));
    }
    if (cs.textTransform === 'uppercase' && Number.parseFloat(cs.letterSpacing) > 0.5) {
      out.caps.push(name(el));
    }
    for (const prop of [cs.color, cs.backgroundColor, cs.borderTopColor, cs.fill, cs.stroke]) {
      const c = parse(prop);
      if (!c || c.a === 0) continue;
      const mx = Math.max(c.r, c.g, c.b);
      const mn = Math.min(c.r, c.g, c.b);
      if (mx - mn < 40) continue;
      const d = mx - mn;
      let h: number;
      if (mx === c.r) h = ((c.g - c.b) / d) % 6;
      else if (mx === c.g) h = (c.b - c.r) / d + 2;
      else h = (c.r - c.g) / d + 4;
      h = (h * 60 + 360) % 360;
      if (h >= 240 && h <= 300) out.purple.push(name(el));
    }
  }
  const text = document.body.innerText;
  out.dots = (text.match(/ · /g) ?? []).length;
  out.arrows = (text.match(/[→➔⟶]/g) ?? []).length;
  return out;
}

async function open(page: Page, width: number, height: number, scheme: 'light' | 'dark') {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) external.push(r.url());
  });
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${origin}/index.html`);
  await expect(page.locator('h1')).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  return { errors, external };
}

async function assertPage(page: Page, width: number) {
  // page basics
  expect((await page.title()).trim()).not.toBe('');
  await expect(page.locator('main')).toHaveCount(1);
  expect(await page.locator('html').getAttribute('lang')).toBe('en-AU');

  // P3 money
  const money = await page.locator('[data-amount]').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => {
        const cs = getComputedStyle(e);
        const shown = e.querySelector('[aria-hidden="true"]')?.textContent ?? '';
        const spoken = e.querySelector('.sr-only')?.textContent ?? '';
        return {
          amount: e.getAttribute('data-amount') ?? '',
          style: e.getAttribute('data-sign-style') ?? '',
          align: cs.textAlign,
          numeric: cs.fontVariantNumeric,
          shown,
          spoken,
        };
      }),
  );
  expect(money.length).toBeGreaterThan(20);
  for (const m of money) {
    expect(m.align, `${m.amount} right-aligned`).toBe('right');
    expect(m.numeric, `${m.amount} tabular`).toContain('tabular-nums');
    if (m.style === 'words') expect(m.shown).toMatch(/^[\d,]+\.\d{2}( in| out)?$/);
    else expect(m.shown, `${m.amount} pattern`).toMatch(/^\(?[\d,]+\.\d{2}\)?$/);
    if (m.amount.startsWith('-')) {
      expect(m.spoken).toMatch(/^minus /);
      if (m.style !== 'words') expect(m.shown.startsWith('(')).toBe(true);
    }
  }

  // P13 whose turn
  const open = await page.locator('[data-open-item]').evaluateAll((els) =>
    els.map((e) => [e.getAttribute('data-turn') ?? '', e.getAttribute('data-due') ?? '']),
  );
  expect(open.length).toBeGreaterThanOrEqual(6);
  for (const [turn, due] of open) {
    expect(turn).not.toBe('');
    expect(due).not.toBe('');
  }

  // P15 expected is never shown as actual
  const expected = await page.locator('[data-series="expected"]').evaluateAll((els) =>
    els
      .filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => {
        if (e instanceof SVGElement) {
          const fig = e.closest('figure');
          return {
            dashed: getComputedStyle(e).strokeDasharray !== 'none',
            labelled: /expected/i.test((fig as HTMLElement | null)?.innerText ?? ''),
          };
        }
        const mark = e.querySelector('.mark') ?? e;
        const cs = getComputedStyle(mark);
        return {
          dashed: cs.borderTopStyle === 'dashed' || cs.borderLeftStyle === 'dashed',
          labelled: /expected/i.test((e as HTMLElement).innerText),
        };
      }),
  );
  expect(expected.length).toBeGreaterThan(5);
  for (const e of expected) expect(e).toEqual({ dashed: true, labelled: true });
  const last = await page.locator('[data-last-statement]').getAttribute('data-last-statement');
  expect(last).toBe('2026-10-23');
  expect(await page.locator('path[data-series="actual"]').getAttribute('data-end-date')).toBe(last);

  // no horizontal scroll
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(sw, 'no horizontal scroll').toBeLessThanOrEqual(width);

  // axe WCAG 2.2 AA
  const axe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  // genericness probes
  const probe = await page.evaluate(genericnessProbe);
  expect(probe).toEqual({ shadows: [], bigRadius: [], caps: [], purple: [], dots: 0, arrows: 0 });
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;

test.describe('SS-PLAT-29 Timeline components honour P3, P13, P15 and the genericness probes', () => {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`SS-PLAT-29: fixture page @ ${String(vp.width)} ${theme} [T-0106]`, async ({ page, evidence }) => {
        const { errors, external } = await open(page, vp.width, vp.height, theme);
        await assertPage(page, vp.width);
        expect(errors, 'no console errors').toEqual([]);
        expect(external, 'no third-party requests').toEqual([]);
        await evidence('SS-PLAT-29', `ui-system-${String(vp.width)}-${theme}`);
      });
    }
  }

  for (const scale of ['Quarter', 'Year'] as const) {
    test(`SS-PLAT-29: ${scale} scale aggregates and stays honest @ 1440 [T-0106]`, async ({ page, evidence }) => {
      const { errors } = await open(page, 1440, 900, 'light');
      await page.getByRole('button', { name: scale, exact: true }).click();
      await expect(page.getByRole('button', { name: scale, exact: true })).toHaveAttribute('aria-pressed', 'true');
      const buckets = await page.locator('[data-lane="customers"] [data-bucket]').count();
      expect(buckets).toBeGreaterThan(0);
      await assertPage(page, 1440);
      expect(errors).toEqual([]);
      await evidence('SS-PLAT-29', `ui-system-${scale.toLowerCase()}-1440`);
    });
  }

  test('SS-PLAT-29: turn queue works from the keyboard with a visible focus ring [T-0106]', async ({ page, evidence }) => {
    await open(page, 1440, 900, 'light');
    const queue = page.getByRole('list', { name: 'Decisions waiting on someone' });
    const buttons = queue.getByRole('button');
    await buttons.first().focus();
    await page.keyboard.press('j');
    await expect(buttons.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(buttons.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(buttons.last()).toBeFocused();
    const outline = await buttons.last().evaluate((b) => {
      const cs = getComputedStyle(b);
      return { style: cs.outlineStyle, width: Number.parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Opened INV-001061');
    await evidence('SS-PLAT-29', 'turn-queue-keyboard-1440');
  });
});
