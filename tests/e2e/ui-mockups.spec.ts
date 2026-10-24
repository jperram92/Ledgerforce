/**
 * SS-PLAT-UI-01 — every static UI mockup in Docs/ui/mockups/*.html loads cleanly at desktop
 * (1440) and mobile (390) widths, has a <title> and an <h1>, logs no console errors, and leaves a
 * full-page screenshot as evidence for T-0009.
 *
 * If no mockups exist yet, the same checks run against tests/e2e/fixtures/mockup-fixture.html so
 * the harness itself is still proven (nothing is skipped) and a notice is logged.
 */
import { readdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@ledgerforce/testing/evidence';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const MOCKUP_DIR = join(REPO_ROOT, 'Docs', 'ui', 'mockups');
const FIXTURE = join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'mockup-fixture.html');

const mockups = existsSync(MOCKUP_DIR)
  ? readdirSync(MOCKUP_DIR)
      .filter((f) => f.endsWith('.html'))
      .sort()
      .map((f) => join(MOCKUP_DIR, f))
  : [];

const pages = mockups.length > 0 ? mockups : [FIXTURE];
if (mockups.length === 0) {
  console.log(
    `[ui-mockups] No mockups found in ${MOCKUP_DIR} — asserting on harness fixture ${FIXTURE} instead.`,
  );
}

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

test.use({ evidenceTaskId: 'T-0009' });

test.describe('SS-PLAT-UI-01 static UI mockups', () => {
  for (const file of pages) {
    const name = basename(file, '.html');
    for (const vp of WIDTHS) {
      test(`${name} @ ${String(vp.width)}px`, async ({ page, evidence }) => {
        const errors: string[] = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
        });
        page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });

        expect((await page.title()).trim(), 'page has a non-empty <title>').not.toBe('');
        await expect(page.locator('h1').first(), 'page has an <h1>').toBeVisible();
        expect(page.viewportSize()?.width).toBe(vp.width);

        await evidence('SS-PLAT-UI-01', `${name}-${vp.name}-${String(vp.width)}`);
        expect(errors, 'no console errors or uncaught page errors').toEqual([]);
      });
    }
  }
});
