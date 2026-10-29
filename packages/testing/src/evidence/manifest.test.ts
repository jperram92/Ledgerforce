import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendManifestEntries,
  evidenceFilePath,
  findRepoRoot,
  formatTimestamp,
  resolveEvidenceContext,
  type EvidenceEntry,
} from './manifest.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lf-evidence-'));
});

const entry = (i: number): EvidenceEntry => ({
  scenario: 'SS-PLAT-UI-01',
  file: `.agent/evidence/T-0009/20261024-101500-SS-PLAT-UI-01-shot-${String(i)}.png`,
  test: `test ${String(i)}`,
  commit: 'abc1234',
  provider: 'claude',
  timestamp: '2026-10-24T10:15:00.000Z',
  result: 'passed',
});

describe('formatTimestamp', () => {
  it('formats UTC as YYYYMMDD-HHMMSS', () => {
    expect(formatTimestamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102-030405');
  });
});

describe('evidenceFilePath', () => {
  const date = new Date('2026-10-24T10:15:00Z');
  it('builds <root>/<taskId>/<ts>-<scenario>-<slug>.png', () => {
    expect(
      evidenceFilePath({
        evidenceRoot: '/repo/.agent/evidence',
        taskId: 'T-0009',
        scenarioId: 'SS-PLAT-UI-01',
        slug: 'invoice list',
        date,
      }),
    ).toBe('/repo/.agent/evidence/T-0009/20261024-101500-SS-PLAT-UI-01-invoice-list.png');
  });

  it('slugifies unsafe characters and collapses dashes', () => {
    expect(
      evidenceFilePath({
        evidenceRoot: '/r',
        taskId: 'adhoc',
        scenarioId: 'SS-GL-01',
        slug: 'Trial  Balance / 390px!',
        date,
      }),
    ).toBe('/r/adhoc/20261024-101500-SS-GL-01-trial-balance-390px.png');
  });

  it.each([
    ['taskId', { taskId: '../escape' }],
    ['taskId', { taskId: '' }],
    ['scenarioId', { scenarioId: 'SS/../../x' }],
    ['slug', { slug: '***' }],
  ])('rejects an unsafe %s', (_label, override) => {
    expect(() =>
      evidenceFilePath({
        evidenceRoot: '/r',
        taskId: 'T-1',
        scenarioId: 'SS-1',
        slug: 'ok',
        date,
        ...override,
      }),
    ).toThrow();
  });
});

describe('appendManifestEntries', () => {
  it('creates the manifest with schema version and task id', async () => {
    const path = join(dir, 'T-0009', 'manifest.json');
    await appendManifestEntries(path, 'T-0009', [entry(1)]);
    const m = JSON.parse(await readFile(path, 'utf8'));
    expect(m).toEqual({ schemaVersion: 1, taskId: 'T-0009', entries: [entry(1)] });
  });

  it('appends and never drops existing entries', async () => {
    const path = join(dir, 'manifest.json');
    await appendManifestEntries(path, 'T-0009', [entry(1)]);
    await appendManifestEntries(path, 'T-0009', [entry(2), entry(3)]);
    const m = JSON.parse(await readFile(path, 'utf8'));
    expect(m.entries.map((e: EvidenceEntry) => e.test)).toEqual(['test 1', 'test 2', 'test 3']);
  });

  it('is safe under concurrent appends (no lost updates)', async () => {
    const path = join(dir, 'manifest.json');
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => appendManifestEntries(path, 'T-0009', [entry(i)])),
    );
    const m = JSON.parse(await readFile(path, 'utf8'));
    expect(m.entries).toHaveLength(25);
    expect(new Set(m.entries.map((e: EvidenceEntry) => e.test)).size).toBe(25);
  });

  it('refuses to overwrite a corrupt manifest (evidence is never destroyed)', async () => {
    const path = join(dir, 'manifest.json');
    await writeFile(path, '{not json');
    await expect(appendManifestEntries(path, 'T-0009', [entry(1)])).rejects.toThrow(/manifest/i);
    expect(await readFile(path, 'utf8')).toBe('{not json');
  });

  it('refuses to mix task ids in one manifest', async () => {
    const path = join(dir, 'manifest.json');
    await appendManifestEntries(path, 'T-0009', [entry(1)]);
    await expect(appendManifestEntries(path, 'T-0010', [entry(2)])).rejects.toThrow(/T-0009/);
  });

  it('rejects entries missing required fields', async () => {
    const path = join(dir, 'manifest.json');
    const bad = { ...entry(1), scenario: '' };
    await expect(appendManifestEntries(path, 'T-0009', [bad])).rejects.toThrow(/scenario/);
  });
});

describe('resolveEvidenceContext', () => {
  it('defaults taskId to adhoc and provider to unknown', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    const ctx = resolveEvidenceContext({}, join(dir, 'sub'));
    expect(ctx.taskId).toBe('adhoc');
    expect(ctx.provider).toBe('unknown');
    expect(ctx.repoRoot).toBe(dir);
    expect(ctx.evidenceRoot).toBe(join(dir, '.agent', 'evidence'));
  });

  it('reads LF_TASK_ID, LF_PROVIDER, LF_EVIDENCE_DIR and GITHUB_SHA', async () => {
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    const ctx = resolveEvidenceContext(
      {
        LF_TASK_ID: 'T-0042',
        LF_PROVIDER: 'codex',
        LF_EVIDENCE_DIR: join(dir, 'ev'),
        GITHUB_SHA: 'deadbeef',
      },
      dir,
    );
    expect(ctx).toMatchObject({
      taskId: 'T-0042',
      provider: 'codex',
      evidenceRoot: join(dir, 'ev'),
      commit: 'deadbeef',
    });
  });

  it('finds the real repository root and its git commit', () => {
    const root = findRepoRoot(process.cwd());
    const ctx = resolveEvidenceContext({}, root);
    expect(ctx.commit).toMatch(/^([0-9a-f]{7,40}(-dirty)?|unknown)$/);
  });
});
