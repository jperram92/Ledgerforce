import { describe, expect, it } from 'vitest';
import {
  reportEntries,
  scenarioIdsIn,
  scenarioResults,
  type VitestJsonReport,
} from './test-report.ts';

const report: VitestJsonReport = {
  success: false,
  testResults: [
    {
      name: '/repo/packages/db/src/tenant-context.db.test.ts',
      assertionResults: [
        {
          ancestorTitles: ['SS-PLAT-04: RLS isolates tenants'],
          title: 'clears on COMMIT',
          status: 'passed',
        },
        {
          ancestorTitles: ['SS-PLAT-04: RLS isolates tenants'],
          title: 'clears on ROLLBACK',
          status: 'passed',
        },
        { ancestorTitles: [], title: 'SS-UC01-03 draft invoice created', status: 'failed' },
        { ancestorTitles: [], title: 'SS-UC01-03 lines map to products', status: 'passed' },
        { ancestorTitles: ['helpers'], title: 'formats things', status: 'passed' },
        { ancestorTitles: [], title: 'SS-PLAT-UI-01 skipped thing', status: 'skipped' },
      ],
    },
  ],
};

describe('scenarioIdsIn', () => {
  it('finds platform, use-case and multi-part scenario ids', () => {
    expect(scenarioIdsIn('SS-PLAT-04: RLS isolates')).toEqual(['SS-PLAT-04']);
    expect(scenarioIdsIn('SS-UC01-03 draft')).toEqual(['SS-UC01-03']);
    expect(scenarioIdsIn('SS-PLAT-UI-01 gallery and SS-PLAT-04')).toEqual([
      'SS-PLAT-UI-01',
      'SS-PLAT-04',
    ]);
    expect(scenarioIdsIn('no scenario here, SSN-12')).toEqual([]);
  });
});

describe('scenarioResults', () => {
  it('a scenario passes only when every one of its tests passed', () => {
    const r = scenarioResults(report);
    expect(r.get('SS-PLAT-04')).toEqual({
      result: 'passed',
      tests: [
        'packages/db/src/tenant-context.db.test.ts › SS-PLAT-04: RLS isolates tenants › clears on COMMIT',
        'packages/db/src/tenant-context.db.test.ts › SS-PLAT-04: RLS isolates tenants › clears on ROLLBACK',
      ],
    });
  });

  it('any failing test fails the scenario (honest evidence)', () => {
    expect(scenarioResults(report).get('SS-UC01-03')?.result).toBe('failed');
  });

  it('a scenario whose tests were all skipped is recorded as skipped, never passed', () => {
    expect(scenarioResults(report).get('SS-PLAT-UI-01')?.result).toBe('skipped');
  });

  it('tests without a scenario id are not evidence for anything', () => {
    expect([...scenarioResults(report).keys()].sort()).toEqual([
      'SS-PLAT-04',
      'SS-PLAT-UI-01',
      'SS-UC01-03',
    ]);
  });
});

describe('reportEntries', () => {
  it('builds one manifest entry per scenario pointing at the saved report file', () => {
    const entries = reportEntries(scenarioResults(report), {
      file: '.agent/evidence/T-0010/20261024-090000-tests-db.json',
      commit: 'abc123',
      provider: 'claude',
      timestamp: '2026-10-24T09:00:00.000Z',
    });
    const plat = entries.find((e) => e.scenario === 'SS-PLAT-04');
    expect(plat).toMatchObject({
      file: '.agent/evidence/T-0010/20261024-090000-tests-db.json',
      result: 'passed',
      commit: 'abc123',
      provider: 'claude',
    });
    expect(plat?.test).toContain('2 test(s)');
    expect(entries.find((e) => e.scenario === 'SS-UC01-03')?.result).toBe('failed');
  });
});
