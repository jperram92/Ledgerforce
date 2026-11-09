/**
 * Golden runner: mode selection, Draft refusal and outcome reporting (T-0031, SS-PLAT-12).
 *
 * Approved-only is the default everywhere and the only mode CI accepts. Draft entries are never
 * run in that mode and are reported PENDING, never PASS. Running Draft entries is an explicit,
 * local opt-in (LF_GOLDEN_DRAFTS=1) whose outcomes are labelled DRAFT.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GoldenPosting } from './parse.ts';
import {
  DRAFT_ENV,
  GoldenModeError,
  goldenModeFrom,
  planGoldenRun,
  runGolden,
  summarizeGolden,
  type LineView,
} from './runner.ts';

const gp = (id: string, status: 'Draft' | 'Approved'): GoldenPosting => ({
  id,
  title: `title ${id}`,
  status,
  approval: status === 'Approved' ? 'JP, 2026-11-10' : null,
  phase: 'MVP',
  sourceTypes: ['ar.receipt'],
  entryDate: '2026-11-15',
  journals: [
    {
      label: null,
      date: null,
      lines: [
        {
          no: 1,
          account: 'bank:OPERATING',
          binding: { kind: 'bank', name: 'OPERATING' },
          ref: '1100',
          debit: '10.00',
          credit: null,
          tax: { codes: [], amount: null, note: null },
          party: null,
        },
        {
          no: 2,
          account: 'system:AR_CONTROL',
          binding: { kind: 'system', role: 'AR_CONTROL' },
          ref: '1200',
          debit: null,
          credit: '10.00',
          tax: { codes: [], amount: null, note: null },
          party: 'Acme',
        },
      ],
      total: { debit: '10.00', credit: '10.00' },
    },
  ],
});

const view = (over: Partial<LineView> = {}): LineView => ({
  lineNo: 1,
  accountId: 'a-bank',
  accountLabel: 'bank:OPERATING',
  debit: '10.0000',
  credit: '0.0000',
  taxCodeId: null,
  taxLabel: null,
  taxAmount: null,
  partyId: null,
  partyLabel: null,
  ...over,
});

const planOne = (g: GoldenPosting, mode: 'approved-only' | 'include-drafts') => {
  const [p] = planGoldenRun([g], mode);
  if (!p) throw new Error('nothing planned');
  return p;
};

describe('SS-PLAT-12 runner mode', () => {
  it('is approved-only by default, locally and in CI', () => {
    expect(goldenModeFrom({})).toBe('approved-only');
    expect(goldenModeFrom({ CI: 'true' })).toBe('approved-only');
    expect(goldenModeFrom({ [DRAFT_ENV]: '0' })).toBe('approved-only');
    expect(goldenModeFrom({ [DRAFT_ENV]: '' })).toBe('approved-only');
  });

  it('runs Draft entries only on the explicit local opt-in', () => {
    expect(DRAFT_ENV).toBe('LF_GOLDEN_DRAFTS');
    expect(goldenModeFrom({ [DRAFT_ENV]: '1' })).toBe('include-drafts');
    expect(goldenModeFrom({ [DRAFT_ENV]: '1', CI: 'false' })).toBe('include-drafts');
  });

  it('refuses the Draft opt-in under CI and refuses unknown values', () => {
    expect(() => goldenModeFrom({ [DRAFT_ENV]: '1', CI: 'true' })).toThrow(GoldenModeError);
    expect(() => goldenModeFrom({ [DRAFT_ENV]: '1', CI: '1' })).toThrow(/CI/);
    expect(() => goldenModeFrom({ [DRAFT_ENV]: 'yes' })).toThrow(GoldenModeError);
  });
});

describe('SS-PLAT-12 runner plan and outcomes', () => {
  it('plans Approved entries to run and Draft entries as PENDING in approved-only mode', () => {
    const plan = planGoldenRun([gp('GP-001', 'Approved'), gp('GP-002', 'Draft')], 'approved-only');
    expect(plan.map((p) => [p.gp.id, p.run, p.label])).toEqual([
      ['GP-001', true, 'APPROVED'],
      ['GP-002', false, 'DRAFT'],
    ]);
    expect(plan[1]?.pendingReason).toMatch(/Draft.*not run.*approved-only/);
  });

  it('plans a gated Approved entry as PENDING with the gate reason, in both modes (DL-0256)', async () => {
    const gate = (g: { id: string }) =>
      g.id === 'GP-019' ? { kind: 'requires' as const, reason: 'requires T-0032 (x)' } : null;
    for (const mode of ['approved-only', 'include-drafts'] as const) {
      const plan = planGoldenRun(
        [gp('GP-001', 'Approved'), gp('GP-019', 'Approved'), gp('GP-002', 'Draft')],
        mode,
        gate,
      );
      expect(plan.map((p) => [p.gp.id, p.run, p.label])).toEqual([
        ['GP-001', true, 'APPROVED'],
        ['GP-019', false, 'APPROVED'],
        ['GP-002', mode === 'include-drafts', 'DRAFT'],
      ]);
      expect(plan[1]?.pendingReason).toBe('requires T-0032 (x)');
      const produce = vi.fn();
      const held = plan[1];
      if (!held) throw new Error('nothing planned');
      const outcome = await runGolden(held, produce);
      expect(produce).not.toHaveBeenCalled();
      expect(outcome.status).toBe('PENDING');
      expect(outcome.report).toMatch(/GP-019 \[APPROVED\] PENDING — requires T-0032/);
    }
  });

  it('plans Draft entries to run, labelled DRAFT, in include-drafts mode', () => {
    const plan = planGoldenRun([gp('GP-002', 'Draft')], 'include-drafts');
    expect(plan.map((p) => [p.run, p.label])).toEqual([[true, 'DRAFT']]);
  });

  it('never calls the producer for a PENDING entry and never counts it as passed', async () => {
    const produce = vi.fn();
    const planned = planOne(gp('GP-002', 'Draft'), 'approved-only');
    const outcome = await runGolden(planned, produce);
    expect(produce).not.toHaveBeenCalled();
    expect(outcome.status).toBe('PENDING');
    const s = summarizeGolden([outcome]);
    expect(s).toMatchObject({ passed: [], failed: [], pending: ['GP-002'] });
    expect(s.text).toMatch(/0 passed, 0 failed, 1 PENDING/);
  });

  it('passes when every journal matches line for line', async () => {
    const planned = planOne(gp('GP-001', 'Approved'), 'approved-only');
    const produce = vi.fn(async () => ({ expected: [view()], actual: [view()] }));
    const outcome = await runGolden(planned, produce);
    expect(produce).toHaveBeenCalledWith(planned.gp, 0);
    expect(outcome.status).toBe('PASS');
    expect(outcome.report).toMatch(/GP-001 \[APPROVED\] PASS/);
  });

  it('fails with a readable diff when a line differs', async () => {
    const planned = planOne(gp('GP-001', 'Approved'), 'approved-only');
    const outcome = await runGolden(planned, async () => ({
      expected: [view()],
      actual: [view({ debit: '10.0100' })],
    }));
    expect(outcome.status).toBe('FAIL');
    expect(outcome.report).toMatch(/GP-001 \[APPROVED\] FAIL/);
    expect(outcome.report).toMatch(/line 1 debit: expected 10\.0000, engine 10\.0100/);
  });

  it('fails, with the error, when the engine or the mapping refuses the journal', async () => {
    const planned = planOne(gp('GP-002', 'Draft'), 'include-drafts');
    const outcome = await runGolden(planned, async () => {
      throw new Error('INVALID_AMOUNT: taxAmount "-300.0000"');
    });
    expect(outcome.status).toBe('FAIL');
    expect(outcome.report).toMatch(/GP-002 \[DRAFT\] FAIL/);
    expect(outcome.report).toMatch(/INVALID_AMOUNT/);
    expect(summarizeGolden([outcome]).failed).toEqual(['GP-002']);
  });
});
