/**
 * Statement shaping, pure (T-0076, design §8.1, §3.5, RQ-0037).
 *
 * SS-PLAT-76 — trial balance (net balance on its side, totals, netsToZero), profit and loss
 *   (sections by type, groups by subtype in chart-code order, net profit) and balance sheet
 *   (retained earnings = posted + prior-year P&L, current-year earnings = P&L for the year to
 *   date, both always shown; balanced).
 * SS-PLAT-77 — for random balanced ledgers the trial balance nets to zero, the balance sheet
 *   balances and current-year earnings equal the year's profit (fast-check, default numRuns;
 *   amounts are bigint ten-thousandths formatted as text, never floats).
 */
import type { AccountMovementRow } from '@ledgerforce/ledger';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  shapeBalanceSheet,
  shapeProfitAndLoss,
  shapeTrialBalance,
  type EarningsAccount,
  type StatementSection,
} from './statements.ts';

type Acc = Omit<AccountMovementRow, 'debit' | 'credit'>;
const acc = (code: string, type: Acc['type'], subtype: string, name = `Account ${code}`): Acc => ({
  accountId: `id-${code}`,
  code,
  name,
  type,
  subtype,
});

const CHART: Record<string, Acc> = Object.fromEntries(
  [
    acc('1010', 'asset', 'bank'),
    acc('1200', 'asset', 'receivable'),
    acc('1500', 'asset', 'fixed_asset'),
    acc('1510', 'asset', 'fixed_asset'),
    acc('2000', 'liability', 'payable'),
    acc('2310', 'liability', 'current_liability'),
    acc('2500', 'liability', 'credit_card'),
    acc('3000', 'equity', 'equity'),
    acc('3200', 'equity', 'retained_earnings', 'Retained earnings'),
    acc('3300', 'equity', 'current_year_earnings', 'Current year earnings'),
    acc('4110', 'revenue', 'operating_revenue'),
    acc('4900', 'revenue', 'other_revenue'),
    acc('5000', 'expense', 'direct_cost'),
    acc('6200', 'expense', 'operating_expense'),
    acc('6400', 'expense', 'employment_expense'),
  ].map((a) => [a.code, a]),
);

const row = (code: string, debit: string, credit: string): AccountMovementRow => {
  const a = CHART[code];
  if (!a) throw new Error(`test chart has no ${code}`);
  return { ...a, debit, credit };
};

const earnings = (code: string): EarningsAccount => {
  const a = CHART[code];
  if (!a) throw new Error(`test chart has no ${code}`);
  return { accountId: a.accountId, code: a.code, name: a.name, subtype: a.subtype };
};
const RE = earnings('3200');
const CYE = earnings('3300');

/** A section as plain text: subtype → [code, amount][] and totals. */
const plain = (s: StatementSection) => ({
  type: s.type,
  total: s.total.toNumericString(),
  groups: s.groups.map((g) => ({
    subtype: g.subtype,
    total: g.total.toNumericString(),
    lines: g.lines.map((l) => [l.code, l.amount.toNumericString(), l.computed === true]),
  })),
});

describe('SS-PLAT-76 trial balance shaping [T-0076]', () => {
  it('SS-PLAT-76 puts each net balance on its side and totals both columns [T-0076]', () => {
    const tb = shapeTrialBalance('AUD', [
      row('1010', '1000.0000', '250.5000'),
      row('2000', '10.0000', '30.0000'),
      row('4110', '0.0000', '719.5000'),
      row('6200', '5.0000', '5.0000'),
    ]);
    expect(tb.currency).toBe('AUD');
    expect(
      tb.rows.map((r) => [r.code, r.name, r.debit.toNumericString(), r.credit.toNumericString()]),
    ).toEqual([
      ['1010', 'Account 1010', '749.5000', '0.0000'],
      ['2000', 'Account 2000', '0.0000', '20.0000'],
      ['4110', 'Account 4110', '0.0000', '719.5000'],
      ['6200', 'Account 6200', '0.0000', '0.0000'],
    ]);
    expect(tb.rows[0]?.debit.currency).toBe('AUD');
    expect(tb.totalDebit.toNumericString()).toBe('749.5000');
    expect(tb.totalCredit.toNumericString()).toBe('739.5000');
    expect(tb.netsToZero).toBe(false);
  });

  it('SS-PLAT-76 a balanced ledger nets to zero; an empty one too [T-0076]', () => {
    const tb = shapeTrialBalance('AUD', [
      row('1010', '100.0001', '0.0000'),
      row('4110', '0.0000', '100.0001'),
    ]);
    expect(tb.netsToZero).toBe(true);
    expect(tb.totalDebit.toNumericString()).toBe('100.0001');
    const empty = shapeTrialBalance('NZD', []);
    expect(empty.rows).toEqual([]);
    expect(empty.totalDebit.toString()).toBe('0.0000 NZD');
    expect(empty.netsToZero).toBe(true);
  });
});

describe('SS-PLAT-76 profit and loss shaping [T-0076]', () => {
  it('SS-PLAT-76 revenue then expenses, grouped by subtype in chart-code order [T-0076]', () => {
    const pl = shapeProfitAndLoss('AUD', [
      row('1010', '900.0000', '0.0000'), // balance-sheet accounts are not in the P&L
      row('4110', '10.0000', '1010.0000'),
      row('4900', '0.0000', '25.0000'),
      row('5000', '300.0000', '0.0000'),
      row('6400', '200.0000', '0.0000'),
      row('6200', '150.0000', '20.0000'),
    ]);
    expect(plain(pl.revenue)).toEqual({
      type: 'revenue',
      total: '1025.0000',
      groups: [
        { subtype: 'operating_revenue', total: '1000.0000', lines: [['4110', '1000.0000', false]] },
        { subtype: 'other_revenue', total: '25.0000', lines: [['4900', '25.0000', false]] },
      ],
    });
    expect(plain(pl.expenses)).toEqual({
      type: 'expense',
      total: '630.0000',
      groups: [
        { subtype: 'direct_cost', total: '300.0000', lines: [['5000', '300.0000', false]] },
        { subtype: 'operating_expense', total: '130.0000', lines: [['6200', '130.0000', false]] },
        { subtype: 'employment_expense', total: '200.0000', lines: [['6400', '200.0000', false]] },
      ],
    });
    expect(pl.netProfit.toString()).toBe('395.0000 AUD');
  });

  it('SS-PLAT-76 a loss is negative; contra amounts keep their sign [T-0076]', () => {
    const pl = shapeProfitAndLoss('AUD', [
      row('4110', '40.0000', '0.0000'),
      row('6200', '0.0000', '10.0000'),
      row('6400', '100.0000', '0.0000'),
    ]);
    expect(pl.revenue.total.toNumericString()).toBe('-40.0000');
    expect(pl.expenses.total.toNumericString()).toBe('90.0000');
    expect(pl.netProfit.toNumericString()).toBe('-130.0000');
    const none = shapeProfitAndLoss('AUD', []);
    expect([none.revenue.groups, none.expenses.groups]).toEqual([[], []]);
    expect(none.netProfit.toNumericString()).toBe('0.0000');
  });
});

describe('SS-PLAT-76 balance sheet shaping [T-0076]', () => {
  // Prior year: capital 10,000; revenue 2,000; expense 500 (profit 1,500).
  // This year to date: revenue 1,400; expense 650 (profit 750); AR 1,100; AP 220.
  const beforeYear = [
    row('1010', '12000.0000', '500.0000'),
    row('3000', '0.0000', '10000.0000'),
    row('4110', '0.0000', '2000.0000'),
    row('6200', '500.0000', '0.0000'),
  ];
  const toDate = [
    row('1010', '12400.0000', '950.0000'),
    row('1200', '1100.0000', '0.0000'),
    row('1500', '20.0000', '0.0000'),
    row('2000', '0.0000', '220.0000'),
    row('2310', '0.0000', '100.0000'),
    row('3000', '0.0000', '10000.0000'),
    row('4110', '0.0000', '3400.0000'),
    row('5000', '150.0000', '0.0000'),
    row('6200', '1000.0000', '0.0000'),
  ];

  it('SS-PLAT-76 retained earnings take prior-year profit; current-year earnings the year to date [T-0076]', () => {
    const bs = shapeBalanceSheet({
      currency: 'AUD',
      toDate,
      beforeYear,
      retainedEarnings: RE,
      currentYearEarnings: CYE,
    });
    expect(plain(bs.assets)).toEqual({
      type: 'asset',
      total: '12570.0000',
      groups: [
        { subtype: 'bank', total: '11450.0000', lines: [['1010', '11450.0000', false]] },
        { subtype: 'receivable', total: '1100.0000', lines: [['1200', '1100.0000', false]] },
        { subtype: 'fixed_asset', total: '20.0000', lines: [['1500', '20.0000', false]] },
      ],
    });
    expect(plain(bs.liabilities)).toEqual({
      type: 'liability',
      total: '320.0000',
      groups: [
        { subtype: 'payable', total: '220.0000', lines: [['2000', '220.0000', false]] },
        { subtype: 'current_liability', total: '100.0000', lines: [['2310', '100.0000', false]] },
      ],
    });
    expect(plain(bs.equity)).toEqual({
      type: 'equity',
      total: '12250.0000',
      groups: [
        { subtype: 'equity', total: '10000.0000', lines: [['3000', '10000.0000', false]] },
        {
          subtype: 'retained_earnings',
          total: '1500.0000',
          lines: [['3200', '1500.0000', true]],
        },
        {
          subtype: 'current_year_earnings',
          total: '750.0000',
          lines: [['3300', '750.0000', true]],
        },
      ],
    });
    expect(bs.priorYearsEarnings.toNumericString()).toBe('1500.0000');
    expect(bs.currentYearEarnings.toNumericString()).toBe('750.0000');
    expect(bs.totalLiabilitiesAndEquity.toNumericString()).toBe('12570.0000');
    expect(bs.balanced).toBe(true);
    expect(bs.equity.groups[1]?.lines[0]?.name).toBe('Retained earnings');
  });

  it('SS-PLAT-76 a year-end closing entry moves profit into posted retained earnings, same totals [T-0076]', () => {
    // Closing entry in the prior year: Dr revenue 2,000, Cr expense 500, Cr RE 1,500.
    const close = (rows: AccountMovementRow[]) =>
      rows.map((r) =>
        r.code === '4110'
          ? { ...r, debit: '2000.0000' }
          : r.code === '6200'
            ? { ...r, credit: '500.0000' }
            : r,
      );
    const closed = [...close(beforeYear), row('3200', '0.0000', '1500.0000')];
    const closedToDate = [...close(toDate), row('3200', '0.0000', '1500.0000')];
    const bs = shapeBalanceSheet({
      currency: 'AUD',
      toDate: closedToDate,
      beforeYear: closed,
      retainedEarnings: RE,
      currentYearEarnings: CYE,
    });
    expect(plain(bs.equity).groups.map((g) => [g.subtype, g.total])).toEqual([
      ['equity', '10000.0000'],
      ['retained_earnings', '1500.0000'],
      ['current_year_earnings', '750.0000'],
    ]);
    expect(bs.priorYearsEarnings.toNumericString()).toBe('0.0000');
    expect(bs.balanced).toBe(true);
  });

  it('SS-PLAT-76 earnings lines are shown at zero; an unbalanced input says so [T-0076]', () => {
    const bs = shapeBalanceSheet({
      currency: 'AUD',
      toDate: [row('1010', '5.0000', '0.0000'), row('3000', '0.0000', '4.0000')],
      beforeYear: [],
      retainedEarnings: RE,
      currentYearEarnings: CYE,
    });
    expect(plain(bs.equity).groups).toEqual([
      { subtype: 'equity', total: '4.0000', lines: [['3000', '4.0000', false]] },
      { subtype: 'retained_earnings', total: '0.0000', lines: [['3200', '0.0000', true]] },
      { subtype: 'current_year_earnings', total: '0.0000', lines: [['3300', '0.0000', true]] },
    ]);
    expect(bs.balanced).toBe(false);
  });
});

// ---- SS-PLAT-77: random balanced ledgers ----------------------------------------------------

const fmt = (u: bigint): string => {
  const s = u < 0n ? '-' : '';
  const a = u < 0n ? -u : u;
  return `${s}${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
/** Codes a posting may use (CURRENT_YEAR_EARNINGS is non-postable). */
const POSTABLE = Object.keys(CHART).filter((c) => c !== '3300');

const entry = fc
  .record({
    amounts: fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 5 }),
    debitCodes: fc.array(fc.constantFrom(...POSTABLE), { minLength: 5, maxLength: 5 }),
    creditCode: fc.constantFrom(...POSTABLE),
    priorYear: fc.boolean(),
  })
  .map(({ amounts, debitCodes, creditCode, priorYear }) => ({
    priorYear,
    lines: [
      ...amounts.map((u, i) => ({ code: debitCodes[i] ?? '1010', drUnits: u, crUnits: 0n })),
      { code: creditCode, drUnits: 0n, crUnits: amounts.reduce((a, b) => a + b, 0n) },
    ],
  }));

type Entry = { priorYear: boolean; lines: { code: string; drUnits: bigint; crUnits: bigint }[] };

const aggregate = (entries: Entry[]): AccountMovementRow[] => {
  const by = new Map<string, [bigint, bigint]>();
  for (const e of entries)
    for (const l of e.lines) {
      const [dr, cr] = by.get(l.code) ?? [0n, 0n];
      by.set(l.code, [dr + l.drUnits, cr + l.crUnits]);
    }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, [d, c]]) => row(code, fmt(d), fmt(c)));
};

describe('SS-PLAT-77 statements hold for random balanced ledgers [T-0076]', () => {
  it('SS-PLAT-77 TB nets to zero, BS balances, CYE = profit of the year, RE = posted + prior profit [T-0076]', () => {
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 12 }), (entries) => {
        const all = aggregate(entries);
        const prior = aggregate(entries.filter((e) => e.priorYear));
        const current = aggregate(entries.filter((e) => !e.priorYear));
        const tb = shapeTrialBalance('AUD', all);
        expect(tb.netsToZero).toBe(true);
        expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
        const bs = shapeBalanceSheet({
          currency: 'AUD',
          toDate: all,
          beforeYear: prior,
          retainedEarnings: RE,
          currentYearEarnings: CYE,
        });
        expect(bs.balanced).toBe(true);
        expect(bs.assets.total.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
        expect(bs.currentYearEarnings.equals(shapeProfitAndLoss('AUD', current).netProfit)).toBe(
          true,
        );
        expect(bs.priorYearsEarnings.equals(shapeProfitAndLoss('AUD', prior).netProfit)).toBe(true);
        const reLine = bs.equity.groups.flatMap((g) => g.lines).find((l) => l.code === '3200');
        const postedRe = all.find((r) => r.code === '3200');
        const posted = postedRe
          ? shapeTrialBalance('AUD', [postedRe]).totalCredit.sub(
              shapeTrialBalance('AUD', [postedRe]).totalDebit,
            )
          : tb.totalDebit.sub(tb.totalDebit);
        expect(reLine?.amount.equals(posted.add(bs.priorYearsEarnings))).toBe(true);
      }),
    );
  });
});
