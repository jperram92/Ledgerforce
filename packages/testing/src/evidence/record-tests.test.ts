import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceManifest } from './manifest.ts';

const root = resolve(import.meta.dirname, '../../../..');
const recorder = join(import.meta.dirname, 'record-tests.ts');

function runRecorder(
  options: { failing?: boolean; missing?: boolean; invalidConfig?: boolean } = {},
) {
  const fixture = mkdtempSync(join(tmpdir(), 'lf recorder & literal-'));
  const config = join(fixture, 'vitest.config.mjs');
  writeFileSync(
    config,
    options.invalidConfig
      ? 'throw new Error("recorder config intentionally invalid");'
      : `export default {test:{projects:[{test:{name:'unit',globals:true,root:${JSON.stringify(fixture)},include:['case.test.ts']}}]}};`,
  );
  writeFileSync(
    join(fixture, 'case.test.ts'),
    `it('SS-PLAT-TEST-01 recorder fixture',()=>expect(1).toBe(${options.failing ? 2 : 1}));`,
  );
  const result = spawnSync(
    process.execPath,
    [
      recorder,
      '--project',
      'unit',
      '--require',
      options.missing ? 'SS-PLAT-TEST-02' : 'SS-PLAT-TEST-01',
      '--config',
      config,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LF_TASK_ID: 'T-0114',
        LF_PROVIDER: 'codex',
        LF_EVIDENCE_DIR: join(fixture, 'evidence'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const manifestPath = join(fixture, 'evidence/T-0114/manifest.json');
  return { result, manifestPath };
}

describe('real Vitest evidence recorder [T-0114]', () => {
  it('records a passing scenario with literal spaces and shell metacharacters in paths', () => {
    const { result, manifestPath } = runRecorder();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ scenario: 'SS-PLAT-TEST-01', result: 'passed' });
    const report = JSON.parse(
      readFileSync(resolve(root, manifest.entries[0]?.file ?? ''), 'utf8'),
    ) as { numPassedTests: number };
    expect(report.numPassedTests).toBe(1);
  }, 35_000);

  it('preserves real failed-test evidence and returns failure', () => {
    const { result, manifestPath } = runRecorder({ failing: true });
    expect(result.status).toBe(1);
    expect(existsSync(manifestPath), result.stdout + result.stderr).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({ scenario: 'SS-PLAT-TEST-01', result: 'failed' });
  }, 35_000);

  it('rejects a missing required scenario without inventing a pass', () => {
    const { result, manifestPath } = runRecorder({ missing: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required scenario SS-PLAT-TEST-02 is not found');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as EvidenceManifest;
    expect(manifest.entries.map((entry) => entry.scenario)).toEqual(['SS-PLAT-TEST-01']);
  }, 35_000);

  it('reports runner failure without a report and creates no manifest', () => {
    const { result, manifestPath } = runRecorder({ invalidConfig: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('record-tests: Vitest did not produce a JSON report');
    expect(result.stderr).not.toContain('ENOENT');
    expect(existsSync(manifestPath)).toBe(false);
  }, 35_000);
});
