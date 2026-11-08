/**
 * Golden approval status for verify.sh gate 4 (T-0031, SS-PLAT-12). Gate 4 may only PASS when
 * every golden posting is Approved and reproduced; while any entry is Draft it is PENDING, even
 * with every golden test green. golden-status.ts is run by plain `node` from verify.sh.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backlogTaskStatus, goldenGate } from './gating.ts';
import { goldenStatus } from './golden-status.ts';
import { parseGoldenPostings } from './parse.ts';

const CLI = fileURLToPath(new URL('./golden-status.ts', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

const section = (id: string, status: string) => `## ${id} — X

- **Status: ${status}** · Phase: MVP · Source type: \`ar.receipt\`
- **Scenario:** 2026-11-15.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | 1.00 | | — | — |
| 2 | system:AR_CONTROL | 1200 | | 1.00 | — | Acme |
| | **Total** | | **1.00** | **1.00** | | |
`;

const repoWith = (markdown: string | null): string => {
  const root = mkdtempSync(join(tmpdir(), 'lf-golden-status-'));
  if (markdown !== null) {
    mkdirSync(join(root, 'Docs/accounting'), { recursive: true });
    writeFileSync(join(root, 'Docs/accounting/postings.md'), markdown);
  }
  return root;
};

const cli = (root: string) => {
  const r = spawnSync(process.execPath, [CLI, root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('SS-PLAT-12 golden status (verify.sh gate 4)', () => {
  it('is PENDING while any entry is Draft, naming the Draft ids', () => {
    const s = goldenStatus(
      section('GP-001', 'Approved (JP, 2026-11-10)') + section('GP-002', 'Draft'),
    );
    expect(s.result).toBe('PENDING');
    expect(s.approved).toEqual(['GP-001']);
    expect(s.draft).toEqual(['GP-002']);
    expect(s.line).toMatch(/1 Approved, 1 Draft \(GP-002\)/);
  });

  it('is PENDING with no entries at all, and PASS only when every entry is Approved', () => {
    expect(goldenStatus('# nothing').result).toBe('PENDING');
    const s = goldenStatus(section('GP-001', 'Approved (JP, 2026-11-10)'));
    expect(s.result).toBe('PASS');
    expect(s.line).toMatch(/1 Approved, 0 Draft/);
  });

  it('accepts the owner-delegated approval note as an Approved status', () => {
    const s = goldenStatus(
      section('GP-001', 'Approved (owner-delegated to claude per DL-0253, 2026-11-08)'),
    );
    expect(s.result).toBe('PASS');
    expect(
      parseGoldenPostings(
        section('GP-001', 'Approved (owner-delegated to claude per DL-0253, 2026-11-08)'),
      )[0]?.approval,
    ).toBe('owner-delegated to claude per DL-0253, 2026-11-08');
  });

  it('stays PENDING while an in-phase Approved entry waits for a required task (DL-0256)', () => {
    const md =
      section('GP-001', 'Approved (JP, 2026-11-10)') +
      section('GP-019', 'Approved (JP, 2026-11-10)');
    const gate = (g: { id: string }) =>
      g.id === 'GP-019'
        ? {
            kind: 'requires' as const,
            reason: 'requires T-0032 (reversal path), which is not done',
          }
        : null;
    const s = goldenStatus(md, gate);
    expect(s.result).toBe('PENDING');
    expect(s.line).toMatch(/2 Approved, 0 Draft; 1 PENDING by gate \(GP-019: requires T-0032/);
  });

  it('lists out-of-phase Approved entries without holding the enforced phase (DL-0256)', () => {
    const md =
      section('GP-001', 'Approved (JP, 2026-11-10)').replace('Phase: MVP', 'Phase: MVP') +
      section('GP-010', 'Approved (JP, 2026-11-10)').replace('Phase: MVP', 'Phase: Phase 1');
    const gate = (g: { id: string }) =>
      g.id === 'GP-010'
        ? {
            kind: 'out_of_phase' as const,
            reason: 'out of phase: Phase 1 entry, enforced phase is MVP',
          }
        : null;
    const s = goldenStatus(md, gate);
    expect(s.result).toBe('PASS');
    expect(s.line).toMatch(/1 out of phase \(GP-010\)/);
  });

  it('runs under plain node: exit 10 PENDING, 0 PASS, 1 FAIL on an unreadable file', () => {
    const pending = cli(repoWith(section('GP-001', 'Draft')));
    expect(pending.code, pending.err).toBe(10);
    expect(pending.out).toMatch(/^PENDING: golden postings 0 Approved, 1 Draft \(GP-001\)/);

    const pass = cli(repoWith(section('GP-001', 'Approved (JP, 2026-11-10)')));
    expect(pass.code, pass.err).toBe(0);
    expect(pass.out).toMatch(/^PASS: golden postings 1 Approved, 0 Draft/);

    const broken = cli(repoWith(section('GP-001', 'Draft').replace(/\| \| \*\*Total.*\n/, '')));
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/^FAIL: .*GP-001.*Total/);

    const missing = cli(repoWith(null));
    expect(missing.code).toBe(10);
    expect(missing.out).toMatch(/^PENDING: no Docs\/accounting\/postings\.md/);
  });

  it('the CLI gates on the backlog: GP-019 PENDING until T-0032 is done (DL-0256)', () => {
    const root = repoWith(section('GP-019', 'Approved (JP, 2026-11-10)'));
    const pending = cli(root);
    expect(pending.code, pending.err).toBe(10);
    expect(pending.out).toMatch(/^PENDING: .*GP-019: requires T-0032/);
    mkdirSync(join(root, '.agent/backlog'), { recursive: true });
    writeFileSync(join(root, '.agent/backlog/T-0032.md'), '---\nid: T-0032\nstatus: done\n---\n');
    const pass = cli(root);
    expect(pass.code, pass.err).toBe(0);
  });

  it('reports the real repository as PENDING while any of its GPs is Draft or gated in phase (DL-0242, DL-0256)', () => {
    const md = readFileSync(join(REPO, 'Docs/accounting/postings.md'), 'utf8');
    const postings = parseGoldenPostings(md);
    const drafts = postings.filter((p) => p.status === 'Draft');
    const status = backlogTaskStatus(REPO);
    const held = postings.filter((p) => goldenGate(p, { taskStatus: status })?.kind === 'requires');
    const r = cli(REPO);
    expect(r.code, r.err).toBe(drafts.length > 0 || held.length > 0 ? 10 : 0);
    if (drafts.length > 0) {
      expect(r.out).toContain(
        `${String(drafts.length)} Draft (${drafts.map((d) => d.id).join(', ')})`,
      );
    }
  });
});
