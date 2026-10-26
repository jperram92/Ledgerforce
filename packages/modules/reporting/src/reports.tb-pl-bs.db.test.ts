/**
 * Trial balance, profit and loss and balance sheet against a real PostgreSQL as lf_app
 * (T-0076, design §8.1, §3.5, UC-10, RQ-0037).
 *
 * SS-UC10-08 — the TB review step for October: total debits = total credits, and the AR/AP
 *   control balances are listed (the subledger side waits for T-0028, DL-0175).
 * SS-PLAT-76 — reports for a period, a date range (cut periods included), a dimension filter and
 *   a balance-sheet date: base currency, sections by type/subtype, retained earnings computed
 *   from prior years, current-year earnings on the CURRENT_YEAR_EARNINGS line,
 *   assets = liabilities + equity, other companies left out, bad input refused.
 *
 * Postings are raw journals through the posting engine (no event posting rule: golden postings
 * are Draft). AR/AP lines use ar_invoice / ap_bill source types only so that the control
 * accounts accept them (design §3.2).
 */
import { findPeriod, generateFiscalYear, post, type PostingLineInput } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balanceSheetReport,
  profitAndLossReport,
  ReportError,
  trialBalanceReport,
  trialBalanceReview,
} from './reports.ts';
import type { StatementSection } from './statements.ts';

let f: LedgerFixture;
let october = '';
const dim: Record<string, string> = {};

const SERIES = [
  ['je_manual_journal', 'MJ-'],
  ['je_ar_invoice', 'AR-'],
  ['je_ap_bill', 'AP-'],
] as const;

async function prepareCompany(company: string) {
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of SERIES)
      await trx
        .insertInto('app.number_series')
        .values({ company_id: company, code, prefix })
        .execute();
    // FY2026 (2025-07-01 … 2026-06-30) in front of the fixture's FY2027.
    await generateFiscalYear(trx, { companyId: company, convention: 'AU', startYear: 2025 });
  });
}

const postIn =
  (company: string) =>
  (entryDate: string, lines: [string, string, string?][], sourceType = 'manual_journal') =>
    f.inTenant((trx) =>
      post(trx, {
        companyId: company,
        idempotencyKey: randomUUID(),
        entryDate,
        sourceType,
        lines: lines.map(([code, amount, d]): PostingLineInput => {
          const id = f.chart(company).acct[code.slice(1)] ?? `missing ${code}`;
          const side = code.startsWith('D') ? 'debit' : 'credit';
          return { account: { id }, [side]: amount, ...(d ? { dimensions: [d] } : {}) };
        }),
      }),
    );

const plain = (s: StatementSection) =>
  s.groups.map((g) => [
    g.subtype,
    g.total.toNumericString(),
    g.lines.map((l) => [l.code, l.amount.toNumericString()]),
  ]);

const tbRows = (
  rows: {
    code: string;
    debit: { toNumericString(): string };
    credit: { toNumericString(): string };
  }[],
) => rows.map((r) => [r.code, r.debit.toNumericString(), r.credit.toNumericString()]);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007602');
  await prepareCompany(f.companyId);
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of SERIES.slice(0, 1))
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.otherCompanyId, code, prefix })
        .execute();
    const p = await findPeriod(trx, f.companyId, '2026-10-15');
    october = p?.id ?? '';
  });
  const P = postIn(f.companyId);
  // Prior year (FY2026): capital 10,000; revenue 2,000; rent 500 → profit 1,500.
  await P('2026-03-15', [
    ['D1010', '10000.0000'],
    ['C3000', '10000.0000'],
  ]);
  await P('2026-04-10', [
    ['D1010', '2000.0000'],
    ['C4110', '2000.0000'],
  ]);
  await P('2026-05-01', [
    ['D6200', '500.0000'],
    ['C1010', '500.0000'],
  ]);
  // This year before October: subscriptions 400.
  await P('2026-08-10', [
    ['D1010', '400.0000'],
    ['C4120', '400.0000'],
  ]);
  // October postings.
  await P('2026-10-05', [
    ['D5000', '150.0000'],
    ['C1010', '150.0000'],
  ]);
  await P(
    '2026-10-20',
    [
      ['D1200', '1100.0000'],
      ['C4110', '1000.0000'],
      ['C2310', '100.0000'],
    ],
    'ar_invoice',
  );
  await P(
    '2026-10-21',
    [
      ['D6310', '200.0000'],
      ['D1820', '20.0000'],
      ['C2000', '220.0000'],
    ],
    'ap_bill',
  );
  await P('2026-10-24', [
    ['D6200', '300.0000'],
    ['C1010', '300.0000'],
  ]);
  // A USD receipt into the saver account: the reports use the base (AUD) amounts.
  await f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-10-24',
      sourceType: 'manual_journal',
      lines: [
        {
          account: { id: f.acct['1020'] ?? '' },
          debit: '152.3500',
          txnCurrency: 'USD',
          txnAmount: '100.0000',
          fxRate: '1.5235',
        },
        { account: { id: f.acct['1010'] ?? '' }, credit: '152.3500' },
      ],
    }),
  );
  // November, a draft in October, and the other company: none of them in the October figures.
  await P('2026-11-02', [
    ['D6200', '75.0000'],
    ['C1010', '75.0000'],
  ]);
  await f.inTenant((trx) =>
    f.insertEntry(
      trx,
      [
        { code: '6200', debit: '999.0000' },
        { code: '1010', credit: '999.0000' },
      ],
      {
        status: 'draft',
        entryDate: '2026-10-25',
      },
    ),
  );
  await postIn(f.otherCompanyId)('2026-10-05', [
    ['D6200', '7.0000'],
    ['C1010', '7.0000'],
  ]);
});

afterAll(async () => {
  await f.close();
});

describe('SS-UC10-08 TB review step shows TB nets to zero [T-0076]', () => {
  it('SS-UC10-08: TB review step shows TB nets to zero [T-0076]', async () => {
    const review = await f.inTenant((trx) =>
      trialBalanceReview(trx, { companyId: f.companyId, periodId: october }),
    );
    expect(review.period).toEqual({
      id: october,
      name: '2026-10',
      start: '2026-10-01',
      end: '2026-10-31',
    });
    expect(review.netsToZero).toBe(true);
    const tb = review.trialBalance;
    expect([tb.from, tb.to, tb.currency]).toEqual([null, '2026-10-31', 'AUD']);
    expect(tbRows(tb.rows)).toEqual([
      ['1010', '11297.6500', '0.0000'],
      ['1020', '152.3500', '0.0000'],
      ['1200', '1100.0000', '0.0000'],
      ['1820', '20.0000', '0.0000'],
      ['2000', '0.0000', '220.0000'],
      ['2310', '0.0000', '100.0000'],
      ['3000', '0.0000', '10000.0000'],
      ['4110', '0.0000', '3000.0000'],
      ['4120', '0.0000', '400.0000'],
      ['5000', '150.0000', '0.0000'],
      ['6200', '800.0000', '0.0000'],
      ['6310', '200.0000', '0.0000'],
    ]);
    expect(tb.totalDebit.toString()).toBe('13720.0000 AUD');
    expect(tb.totalCredit.toString()).toBe('13720.0000 AUD');
    expect(
      review.controls.map((c) => [
        c.role,
        c.code,
        c.controlBalance.toNumericString(),
        c.subledgerBalance,
        c.status,
      ]),
    ).toEqual([
      ['AR_CONTROL', '1200', '1100.0000', null, 'subledger_not_available'],
      ['AP_CONTROL', '2000', '220.0000', null, 'subledger_not_available'],
    ]);
  });

  it('SS-UC10-08 an unknown period is refused [T-0076]', async () => {
    await expect(
      f.inTenant((trx) =>
        trialBalanceReview(trx, { companyId: f.companyId, periodId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PERIOD' });
  });
});

describe('SS-PLAT-76 trial balance, profit and loss, balance sheet [T-0076]', () => {
  it('SS-PLAT-76 trial balance for one period or a cut range still nets to zero [T-0076]', async () => {
    const oct = await f.inTenant((trx) =>
      trialBalanceReport(trx, { companyId: f.companyId, from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(oct.netsToZero).toBe(true);
    expect(oct.totalDebit.toNumericString()).toBe('1922.3500');
    const cut = await f.inTenant((trx) =>
      trialBalanceReport(trx, { companyId: f.companyId, from: '2026-10-06', to: '2026-10-21' }),
    );
    expect(tbRows(cut.rows)).toEqual([
      ['1200', '1100.0000', '0.0000'],
      ['1820', '20.0000', '0.0000'],
      ['2000', '0.0000', '220.0000'],
      ['2310', '0.0000', '100.0000'],
      ['4110', '0.0000', '1000.0000'],
      ['6310', '200.0000', '0.0000'],
    ]);
    expect(cut.netsToZero).toBe(true);
    expect([cut.from, cut.to, cut.dimensionValueIds]).toEqual(['2026-10-06', '2026-10-21', []]);
  });

  it('SS-PLAT-76 profit and loss for a range, by type and subtype [T-0076]', async () => {
    const ytd = await f.inTenant((trx) =>
      profitAndLossReport(trx, { companyId: f.companyId, from: '2026-07-01', to: '2026-10-31' }),
    );
    expect(ytd.currency).toBe('AUD');
    expect(plain(ytd.revenue)).toEqual([
      [
        'operating_revenue',
        '1400.0000',
        [
          ['4110', '1000.0000'],
          ['4120', '400.0000'],
        ],
      ],
    ]);
    expect(plain(ytd.expenses)).toEqual([
      ['direct_cost', '150.0000', [['5000', '150.0000']]],
      [
        'operating_expense',
        '500.0000',
        [
          ['6200', '300.0000'],
          ['6310', '200.0000'],
        ],
      ],
    ]);
    expect(ytd.netProfit.toNumericString()).toBe('750.0000');
    const firstTen = await f.inTenant((trx) =>
      profitAndLossReport(trx, { companyId: f.companyId, from: '2026-10-01', to: '2026-10-10' }),
    );
    expect(firstTen.revenue.groups).toEqual([]);
    expect(firstTen.netProfit.toNumericString()).toBe('-150.0000');
  });

  it('SS-PLAT-76 balance sheet: prior years in retained earnings, this year on the current-year line [T-0076]', async () => {
    const bs = await f.inTenant((trx) =>
      balanceSheetReport(trx, { companyId: f.companyId, asAt: '2026-10-31' }),
    );
    expect(bs.fiscalYear).toEqual({ label: 'FY2027', start: '2026-07-01', end: '2027-06-30' });
    expect(plain(bs.assets)).toEqual([
      [
        'bank',
        '11450.0000',
        [
          ['1010', '11297.6500'],
          ['1020', '152.3500'],
        ],
      ],
      ['receivable', '1100.0000', [['1200', '1100.0000']]],
      ['current_asset', '20.0000', [['1820', '20.0000']]],
    ]);
    expect(plain(bs.liabilities)).toEqual([
      ['payable', '220.0000', [['2000', '220.0000']]],
      ['current_liability', '100.0000', [['2310', '100.0000']]],
    ]);
    expect(plain(bs.equity)).toEqual([
      ['equity', '10000.0000', [['3000', '10000.0000']]],
      ['retained_earnings', '1500.0000', [['3200', '1500.0000']]],
      ['current_year_earnings', '750.0000', [['3300', '750.0000']]],
    ]);
    expect(bs.equity.groups.slice(1).map((g) => g.lines[0]?.computed)).toEqual([true, true]);
    expect(bs.assets.total.toNumericString()).toBe('12570.0000');
    expect(bs.totalLiabilitiesAndEquity.toNumericString()).toBe('12570.0000');
    expect(bs.balanced).toBe(true);
  });

  it('SS-PLAT-76 balance sheet mid-month and at the prior year end [T-0076]', async () => {
    const mid = await f.inTenant((trx) =>
      balanceSheetReport(trx, { companyId: f.companyId, asAt: '2026-10-06' }),
    );
    expect(mid.assets.total.toNumericString()).toBe('11750.0000');
    expect(mid.currentYearEarnings.toNumericString()).toBe('250.0000');
    expect(mid.priorYearsEarnings.toNumericString()).toBe('1500.0000');
    expect(mid.balanced).toBe(true);
    const yearEnd = await f.inTenant((trx) =>
      balanceSheetReport(trx, { companyId: f.companyId, asAt: '2026-06-30' }),
    );
    expect(yearEnd.fiscalYear.label).toBe('FY2026');
    expect(plain(yearEnd.equity)).toEqual([
      ['equity', '10000.0000', [['3000', '10000.0000']]],
      ['retained_earnings', '0.0000', [['3200', '0.0000']]],
      ['current_year_earnings', '1500.0000', [['3300', '1500.0000']]],
    ]);
    expect(yearEnd.assets.total.toNumericString()).toBe('11500.0000');
    expect(yearEnd.balanced).toBe(true);
  });

  it('SS-PLAT-76 a year-end closing entry leaves equity unchanged [T-0076]', async () => {
    const company = await f.addCompany(`Closing ${randomUUID().slice(0, 8)} Pty Ltd`);
    await prepareCompany(company);
    const P = postIn(company);
    await P('2026-03-15', [
      ['D1010', '2000.0000'],
      ['C4110', '2000.0000'],
    ]);
    await P('2026-05-01', [
      ['D6200', '500.0000'],
      ['C1010', '500.0000'],
    ]);
    await P('2026-10-05', [
      ['D1010', '300.0000'],
      ['C4110', '300.0000'],
    ]);
    const equity = async () =>
      plain(
        (
          await f.inTenant((trx) =>
            balanceSheetReport(trx, { companyId: company, asAt: '2026-10-31' }),
          )
        ).equity,
      );
    const before = await equity();
    expect(before).toEqual([
      ['retained_earnings', '1500.0000', [['3200', '1500.0000']]],
      ['current_year_earnings', '300.0000', [['3300', '300.0000']]],
    ]);
    // Optional closing journal (design §3.5): profit of FY2026 moved into retained earnings.
    await P('2026-06-30', [
      ['D4110', '2000.0000'],
      ['C6200', '500.0000'],
      ['C3200', '1500.0000'],
    ]);
    expect(await equity()).toEqual(before);
  });

  it('SS-PLAT-76 a dimension filter narrows the TB and the P&L [T-0076]', async () => {
    const company = await f.addCompany(`Departments ${randomUUID().slice(0, 8)} Pty Ltd`);
    await prepareCompany(company);
    await f.inTenant(async (trx) => {
      const d = await trx
        .insertInto('app.dimension')
        .values({ company_id: company, code: 'department', name: 'Department' })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const c of ['SALES', 'OPS']) {
        const v = await trx
          .insertInto('app.dimension_value')
          .values({ company_id: company, dimension_id: d.id, code: c, name: c })
          .returning('id')
          .executeTakeFirstOrThrow();
        dim[c] = v.id;
      }
    });
    const P = postIn(company);
    await P('2026-10-05', [
      ['D6200', '100.0000', dim.SALES ?? ''],
      ['C1010', '100.0000'],
    ]);
    await P('2026-10-06', [
      ['D6200', '40.0000', dim.OPS ?? ''],
      ['C1010', '40.0000'],
    ]);
    const sales = [dim.SALES ?? ''];
    const pl = await f.inTenant((trx) =>
      profitAndLossReport(trx, {
        companyId: company,
        from: '2026-10-01',
        to: '2026-10-31',
        dimensionValueIds: sales,
      }),
    );
    expect(plain(pl.expenses)).toEqual([['operating_expense', '100.0000', [['6200', '100.0000']]]]);
    expect(pl.dimensionValueIds).toEqual(sales);
    const tb = await f.inTenant((trx) =>
      trialBalanceReport(trx, { companyId: company, to: '2026-10-31', dimensionValueIds: sales }),
    );
    expect(tbRows(tb.rows)).toEqual([['6200', '100.0000', '0.0000']]);
    expect(tb.netsToZero).toBe(false);
  });

  it('SS-PLAT-76 bad input is refused with a report error [T-0076]', async () => {
    const run = <R>(fn: Parameters<typeof f.inTenant<R>>[0]) => f.inTenant(fn);
    const c = f.companyId;
    await expect(
      run((trx) => trialBalanceReport(trx, { companyId: c, from: '2026-11-01', to: '2026-10-31' })),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      run((trx) =>
        profitAndLossReport(trx, { companyId: c, from: '2026-10-01', to: '31/10/2026' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      run((trx) => trialBalanceReport(trx, { companyId: c, to: '2026-02-30' })),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      run((trx) => balanceSheetReport(trx, { companyId: c, asAt: '2030-01-01' })),
    ).rejects.toMatchObject({ code: 'NO_FISCAL_YEAR' });
    await expect(
      run((trx) => balanceSheetReport(trx, { companyId: randomUUID(), asAt: '2026-10-31' })),
    ).rejects.toMatchObject({ code: 'UNKNOWN_COMPANY' });
    const err = await run((trx) =>
      trialBalanceReport(trx, { companyId: c, from: '2026-11-01', to: '2026-10-31' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportError);
  });
});
