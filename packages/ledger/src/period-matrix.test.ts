/**
 * SS-PLAT-06 — the §3.5 period status matrix is data, and allow/deny/override equals the design
 * table for every source type × period status, with and without an override (T-0023, RQ-0026).
 * SS-PLAT-57 (unit part) — fiscal years are generated from a convention held as data.
 *
 * The expected table below is written out again from design §3.5 on purpose: it must not be
 * derived from PERIOD_MATRIX, otherwise the test would agree with any mistake in it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERIOD_SETTINGS,
  FISCAL_YEAR_CONVENTIONS,
  PERIOD_STATUSES,
  SOURCE_TYPES,
  fiscalYearPlan,
  mayPost,
  periodDecision,
  sourceClassOf,
  storedSourceType,
  type PayoutUnderArLock,
  type PeriodStatus,
} from './period-matrix.ts';

type Expected = 'allow' | 'override' | 'deny';

/** Design §3.5, column "Who can post", one row per status (RQ-0026 classification). */
const DESIGN_3_5: Record<PeriodStatus, Record<string, Expected | 'setting'>> = {
  // "Everyone with the permission"
  open: { ar: 'allow', ap: 'allow', journal: 'allow', payout: 'allow', reversal: 'allow' },
  // "AP and journals only; AR needs override"; payout = tenant setting (open question, RQ-0026)
  ar_locked: {
    ar: 'override',
    ap: 'allow',
    journal: 'allow',
    payout: 'setting',
    reversal: 'override',
  },
  // "Journals only; AR/AP need override"
  ap_locked: {
    ar: 'override',
    ap: 'override',
    journal: 'allow',
    payout: 'override',
    reversal: 'override',
  },
  // "Finance Admin with override only"
  soft_closed: {
    ar: 'override',
    ap: 'override',
    journal: 'override',
    payout: 'override',
    reversal: 'override',
  },
  // "Nobody"
  hard_locked: { ar: 'deny', ap: 'deny', journal: 'deny', payout: 'deny', reversal: 'deny' },
};

/** RQ-0026 finding 3: golden-posting source type → class. */
const EXPECTED_CLASS: Record<string, string> = {
  'ar.invoice': 'ar',
  'ar.credit_note': 'ar',
  'ar.receipt': 'ar',
  'ar.refund': 'ar',
  'ar.write_off': 'ar',
  'ar.prepayment': 'ar',
  'ar.prepayment_application': 'ar',
  'payments.stripe.charge': 'ar',
  'payments.stripe.payout': 'payout',
  'ap.bill': 'ap',
  'ap.payment': 'ap',
  'payroll.pay_run': 'ap',
  'payroll.net_pay_batch': 'ap',
  manual_journal: 'journal',
  'ledger.reversal': 'reversal',
};

const SETTINGS: readonly PayoutUnderArLock[] = ['override', 'allow'];

describe('SS-PLAT-06: Period status matrix is enforced as data', () => {
  it('the source-type catalogue is exactly the RQ-0026 classification', () => {
    const actual = Object.fromEntries(
      Object.entries(SOURCE_TYPES).map(([, v]) => [v.golden, v.class]),
    );
    expect(actual).toEqual(EXPECTED_CLASS);
    for (const [code, v] of Object.entries(SOURCE_TYPES)) {
      expect(code).toBe(storedSourceType(v.golden));
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/); // storable under the 0007 CHECK
    }
  });

  it('every status × source type × override × payout setting equals the §3.5 table', () => {
    let cells = 0;
    for (const status of PERIOD_STATUSES) {
      for (const [code, { golden }] of Object.entries(SOURCE_TYPES)) {
        for (const payoutUnderArLock of SETTINGS) {
          const settings = { ...DEFAULT_PERIOD_SETTINGS, payoutUnderArLock };
          const cls = EXPECTED_CLASS[golden] ?? 'missing';
          const cell = DESIGN_3_5[status][cls];
          const expected: Expected = cell === 'setting' ? payoutUnderArLock : (cell ?? 'deny');
          expect(periodDecision(status, code, settings), `${status} × ${code}`).toBe(expected);
          expect(mayPost(status, code, { override: false }, settings)).toBe(expected === 'allow');
          expect(mayPost(status, code, { override: true }, settings)).toBe(expected !== 'deny');
          cells++;
        }
      }
    }
    expect(cells).toBe(PERIOD_STATUSES.length * Object.keys(EXPECTED_CLASS).length * 2);
  });

  it('the payout cell under AR lock defaults to "override" (safe) until the product owner decides', () => {
    expect(DEFAULT_PERIOD_SETTINGS.payoutUnderArLock).toBe('override');
    expect(DEFAULT_PERIOD_SETTINGS.lockDatePolicy).toBe('reject');
    expect(periodDecision('ar_locked', 'payments_stripe_payout', DEFAULT_PERIOD_SETTINGS)).toBe(
      'override',
    );
  });

  it('unknown source types are refused in every status, even with an override (fail closed)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PERIOD_STATUSES),
        fc.string().filter((s) => !Object.hasOwn(SOURCE_TYPES, s)),
        fc.boolean(),
        (status, st, override) => {
          expect(sourceClassOf(st)).toBeUndefined();
          expect(periodDecision(status, st, DEFAULT_PERIOD_SETTINGS)).toBe('deny');
          expect(mayPost(status, st, { override }, DEFAULT_PERIOD_SETTINGS)).toBe(false);
        },
      ),
    );
  });

  it('the matrix is frozen data', () => {
    expect(Object.isFrozen(SOURCE_TYPES)).toBe(true);
  });
});

describe('SS-PLAT-57: Fiscal years are generated from a convention held as data', () => {
  it('AU convention: FY2027 runs 2026-07-01 to 2027-06-30 in 12 calendar months', () => {
    expect(FISCAL_YEAR_CONVENTIONS.AU.startMonth).toBe(7);
    const fy = fiscalYearPlan('AU', 2026);
    expect(fy.label).toBe('FY2027');
    expect(fy.start).toBe('2026-07-01');
    expect(fy.end).toBe('2027-06-30');
    expect(fy.periods.map((p) => [p.no, p.name, p.start, p.end])).toEqual([
      [1, '2026-07', '2026-07-01', '2026-07-31'],
      [2, '2026-08', '2026-08-01', '2026-08-31'],
      [3, '2026-09', '2026-09-01', '2026-09-30'],
      [4, '2026-10', '2026-10-01', '2026-10-31'],
      [5, '2026-11', '2026-11-01', '2026-11-30'],
      [6, '2026-12', '2026-12-01', '2026-12-31'],
      [7, '2027-01', '2027-01-01', '2027-01-31'],
      [8, '2027-02', '2027-02-01', '2027-02-28'],
      [9, '2027-03', '2027-03-01', '2027-03-31'],
      [10, '2027-04', '2027-04-01', '2027-04-30'],
      [11, '2027-05', '2027-05-01', '2027-05-31'],
      [12, '2027-06', '2027-06-01', '2027-06-30'],
    ]);
  });

  it('calendar convention and leap years: FY2028 is January to December 2028 with 29 February', () => {
    const fy = fiscalYearPlan('calendar', 2028);
    expect([fy.label, fy.start, fy.end]).toEqual(['FY2028', '2028-01-01', '2028-12-31']);
    expect(fy.periods[1]?.end).toBe('2028-02-29');
  });

  it('property: any start month and year gives 12 contiguous months covering exactly one year', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1990, max: 2200 }), (m, y) => {
        const fy = fiscalYearPlan({ startMonth: m }, y);
        expect(fy.periods).toHaveLength(12);
        expect(fy.periods[0]?.start).toBe(fy.start);
        expect(fy.periods[11]?.end).toBe(fy.end);
        for (let i = 1; i < 12; i++) {
          const prev = fy.periods[i - 1];
          const cur = fy.periods[i];
          if (!prev || !cur) throw new Error('missing period');
          const next = new Date(`${prev.end}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          expect(cur.start).toBe(next.toISOString().slice(0, 10));
        }
        const end = new Date(`${fy.start}T00:00:00Z`);
        end.setUTCFullYear(end.getUTCFullYear() + 1);
        end.setUTCDate(end.getUTCDate() - 1);
        expect(fy.end).toBe(end.toISOString().slice(0, 10));
        expect(fy.label).toBe(`FY${fy.end.slice(0, 4)}`);
      }),
    );
  });

  it('refuses an invalid convention', () => {
    expect(() => fiscalYearPlan({ startMonth: 13 }, 2026)).toThrow(/start month/);
    expect(() => fiscalYearPlan({ startMonth: 0 }, 2026)).toThrow(/start month/);
  });
});
