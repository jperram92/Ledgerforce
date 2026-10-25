/**
 * SS-PLAT-19 — the evidence harness itself (T-0009, AGENTS.md §0.8, evidence skill).
 * Proves evidence() writes a real PNG under .agent/evidence/<task>/ with the standard name. The
 * manifest entry is appended when the test finishes and is checked by verify gate 9.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '@ledgerforce/testing/evidence';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'mockup-fixture.html');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test.use({ evidenceTaskId: 'T-0009' });

test('SS-PLAT-19: Evidence harness captures screenshots', async ({ page, evidence }) => {
  await page.goto(pathToFileURL(FIXTURE).href, { waitUntil: 'load' });
  const file = await evidence('SS-PLAT-19', 'harness-fixture');
  const only = process.env['LF_EVIDENCE_ONLY_TASK'];
  // Normally (and when T-0009 itself is verified) evidence lands in the repository. When verify.sh
  // runs for another task, this spec's evidence must go to the temp dir instead (T-0109, DL-0098).
  const root =
    only && only !== 'T-0009' ? `lf-evidence-gate\\/${only}\\/other-tasks` : '\\.agent\\/evidence';
  expect(file.replaceAll('\\', '/')).toMatch(
    new RegExp(`${root}\\/T-0009\\/\\d{8}-\\d{6}-SS-PLAT-19-harness-fixture\\.png$`),
  );
  const abs = file.startsWith('/') || /^[A-Za-z]:/.test(file) ? file : join(REPO_ROOT, file);
  expect(statSync(abs).size).toBeGreaterThan(1000);
  expect(readFileSync(abs).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
});
