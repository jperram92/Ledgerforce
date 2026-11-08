/**
 * Golden gating (T-0007/T-0031, SS-PLAT-12, DL-0256): an Approved golden whose producer cannot
 * exist yet is reported PENDING with an explicit reason — never PASS, never FAIL.
 *  - out of phase: only entries of the enforced phase (MVP) are run; Phase 1/2 are PENDING.
 *  - requires: an explicit per-GP task marker keeps the entry PENDING until that task is done.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENFORCED_PHASE,
  GOLDEN_REQUIRES,
  GoldenGateError,
  backlogTaskStatus,
  goldenGate,
  phaseOf,
} from './gating.ts';

const gp = (id: string, phase: string) => ({ id, phase });

describe('SS-PLAT-12 golden gating — phase', () => {
  it('enforces the MVP phase', () => {
    expect(ENFORCED_PHASE).toBe('MVP');
  });

  it('reads the leading phase of the status line, including the GP-014 compound phase', () => {
    expect(phaseOf(gp('GP-001', 'MVP'))).toBe('MVP');
    expect(phaseOf(gp('GP-010', 'Phase 1'))).toBe('Phase 1');
    expect(phaseOf(gp('GP-016', 'Phase 2'))).toBe('Phase 2');
    expect(
      phaseOf(
        gp(
          'GP-014',
          'MVP (deposit billing format §4.3); Phase 1 when produced by Rules Studio (UC-09)',
        ),
      ),
    ).toBe('MVP');
  });

  it('refuses a phase it cannot read rather than guessing', () => {
    expect(() => phaseOf(gp('GP-099', 'Sprint 7'))).toThrow(GoldenGateError);
    expect(() => phaseOf(gp('GP-099', ''))).toThrow(/GP-099/);
  });

  it('runs in-phase entries and reports later phases PENDING "out of phase"', () => {
    const none = () => undefined;
    expect(goldenGate(gp('GP-001', 'MVP'), { taskStatus: none, requires: {} })).toBeNull();
    const g = goldenGate(gp('GP-010', 'Phase 1'), { taskStatus: none, requires: {} });
    expect(g?.kind).toBe('out_of_phase');
    expect(g?.reason).toMatch(/out of phase: Phase 1 entry, enforced phase is MVP/);
  });
});

describe('SS-PLAT-12 golden gating — requires: T-NNNN', () => {
  it('declares GP-019 as requiring the reversal path T-0032', () => {
    expect(GOLDEN_REQUIRES['GP-019']?.task).toBe('T-0032');
  });

  it('keeps an in-phase entry PENDING until the required task is done', () => {
    const requires = { 'GP-019': { task: 'T-0032', why: 'reversal path' } };
    for (const status of [undefined, 'todo', 'in_progress', 'verifying', 'review', 'blocked']) {
      const g = goldenGate(gp('GP-019', 'MVP'), { taskStatus: () => status, requires });
      expect(g?.kind, String(status)).toBe('requires');
      expect(g?.reason).toMatch(/requires T-0032 \(reversal path\), which is not done/);
    }
    expect(goldenGate(gp('GP-019', 'MVP'), { taskStatus: () => 'done', requires })).toBeNull();
  });

  it('reports out of phase before a requirement', () => {
    const requires = { 'GP-017': { task: 'T-9999', why: 'x' } };
    const g = goldenGate(gp('GP-017', 'Phase 2'), { taskStatus: () => undefined, requires });
    expect(g?.kind).toBe('out_of_phase');
  });

  it('reads task status from the backlog card frontmatter', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-golden-gating-'));
    mkdirSync(join(root, '.agent/backlog'), { recursive: true });
    writeFileSync(
      join(root, '.agent/backlog/T-0032.md'),
      '---\nid: T-0032\ntitle: "x"\nstatus: done\n---\n\n# T-0032\nstatus: todo\n',
    );
    const status = backlogTaskStatus(root);
    expect(status('T-0032')).toBe('done');
    expect(status('T-0404')).toBeUndefined();
    expect(() => status('../etc/passwd')).toThrow(GoldenGateError);
  });
});
