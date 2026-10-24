/**
 * Playwright `test` extended with an `evidence(scenarioId, slug)` helper.
 *
 *   import { test, expect } from '@ledgerforce/testing/evidence';
 *   test.use({ evidenceTaskId: 'T-0009' });            // optional; default env LF_TASK_ID or 'adhoc'
 *   test('invoice list', async ({ page, evidence }) => {
 *     await page.goto(url);
 *     await evidence('SS-AR-01', 'invoice-list');       // full-page PNG + manifest entry
 *   });
 *
 * Screenshots are written immediately; manifest entries are appended when the test finishes so
 * that `result` records the real outcome (passed/failed/...). Each screenshot is also attached to
 * the Playwright HTML report.
 */
import { test as base, expect } from '@playwright/test';
import { relative, sep } from 'node:path';
import {
  appendManifestEntries,
  evidenceFilePath,
  resolveEvidenceContext,
  type EvidenceEntry,
} from './manifest.ts';

export type EvidenceFn = (scenarioId: string, slug: string) => Promise<string>;

export interface EvidenceFixtures {
  /** Task id evidence is filed under. Defaults to env LF_TASK_ID, else 'adhoc'. */
  evidenceTaskId: string;
  evidence: EvidenceFn;
}

export const test = base.extend<EvidenceFixtures>({
  evidenceTaskId: [process.env['LF_TASK_ID'] || 'adhoc', { option: true }],

  evidence: async ({ page, evidenceTaskId }, use, testInfo) => {
    const ctx = resolveEvidenceContext({ ...process.env, LF_TASK_ID: evidenceTaskId }, process.cwd());
    const pending: Omit<EvidenceEntry, 'result'>[] = [];

    await use(async (scenarioId: string, slug: string) => {
      const date = new Date();
      const path = evidenceFilePath({
        evidenceRoot: ctx.evidenceRoot,
        taskId: ctx.taskId,
        scenarioId,
        slug,
        date,
      });
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(`${scenarioId}-${slug}`, { path, contentType: 'image/png' });
      pending.push({
        scenario: scenarioId,
        file: relative(ctx.repoRoot, path).split(sep).join('/'),
        test: testInfo.titlePath.join(' › '),
        commit: ctx.commit,
        provider: ctx.provider,
        timestamp: date.toISOString(),
      });
      return path;
    });

    if (pending.length > 0) {
      const result = testInfo.status ?? 'unknown';
      await appendManifestEntries(
        `${ctx.evidenceRoot}/${ctx.taskId}/manifest.json`,
        ctx.taskId,
        pending.map((p) => ({ ...p, result })),
      );
    }
  },
});

export { expect };
