/**
 * Report invariants over random ledgers posted through the posting engine (T-0076, design
 * §10.8 accounting invariants, RQ-0037), against a real PostgreSQL as lf_app. Default
 * fast-check numRuns; amounts are bigint ten-thousandths formatted as text (never floats).
 *
 * SS-PLAT-77 — after each random batch of balanced entries dated anywhere in FY2026–FY2027:
 *   INV-tb-zero    the trial balance to a random date nets to zero and equals a model of the
 *                  postings kept by the test;
 *   INV-bs-balance the balance sheet at a random date balances; its current-year earnings equal
 *                  the model's profit from the fiscal-year start to that date, and prior-year
 *                  earnings the model's profit before it;
 *   INV-pl-range   the P&L for a random range (cut periods included) equals the model's profit.
 */
import { generateFiscalYear, post, type PostingLineInput } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceSheetReport, profitAndLossReport, trialBalanceReport } from './reports.ts';

let f: LedgerFixture;

/** Postable, non-control, unrestricted accounts of the AU services chart, with their type. */
const TYPES: Record<string, 'bs' | 'pl'> = {
  '1010': 'bs',
  '1020': 'bs',
  '1300': 'bs',
  '1500': 'bs',
  '2310': 'bs',
  '2500': 'bs',
  '2900': 'bs',
  '3000': 'bs',
  '3100': 'bs',
  '3200': 'bs',
  '4110': 'pl',
  '4120': 'pl',
  '4900': 'pl',
  '5000': 'pl',
  '6110': 'pl',
  '6200': 'pl',
  '6310': 'pl',
  '6400': 'pl',
};
const CODES = Object.keys(TYPES);

const fmt = (u: bigint): string => {
  const s = u < 0n ? '-' : '';
  const a = u < 0n ? -u : u;
  return `${s}${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
const units = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i = '0', d = ''] = (neg ? s.slice(1) : s).split('.');
  const u = BigInt(i) * 10_000n + BigInt(d.padEnd(4, '0').slice(0, 4));
  return neg ? -u : u;
};

/** Day n of the two fiscal years (0 = 2025-07-01 … 729 = 2027-06-30). */
const day = (n: number): string => new Date(Date.UTC(2025, 6, 1 + n)).toISOString().slice(0, 10);
const yearStart = (d: string): string => (d >= '2026-07-01' ? '2026-07-01' : '2025-07-01');

interface Posted {
  date: string;
  code: string;
  /** debit − credit, units. */
  net: bigint;
}
const model: Posted[] = [];

const netByCode = (keep: (p: Posted) => boolean): Map<string, bigint> => {
  const m = new Map<string, bigint>();
  for (const p of model.filter(keep)) m.set(p.code, (m.get(p.code) ?? 0n) + p.net);
  return m;
};
/** Model profit (credit − debit of P&L accounts) for dates in [from, to]. */
const profit = (from: string, to: string): bigint =>
  model
    .filter((p) => TYPES[p.code] === 'pl' && p.date >= from && p.date <= to)
    .reduce((s, p) => s - p.net, 0n);

const entry = fc
  .record({
    amounts: fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 4 }),
    debitCodes: fc.array(fc.constantFrom(...CODES), { minLength: 4, maxLength: 4 }),
    creditCode: fc.constantFrom(...CODES),
    day: fc.integer({ min: 0, max: 729 }),
  })
  .map(({ amounts, debitCodes, creditCode, day: n }) => ({
    date: day(n),
    lines: [
      ...amounts.map((u, i) => ({ code: debitCodes[i] ?? '1010', net: u })),
      { code: creditCode, net: -amounts.reduce((a, b) => a + b, 0n) },
    ],
  }));

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007603');
  await f.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute();
    await generateFiscalYear(trx, { companyId: f.companyId, convention: 'AU', startYear: 2025 });
  });
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-77 reports hold for random posted ledgers [T-0076]', () => {
  it('SS-PLAT-77 TB nets to zero and matches the model, BS balances, P&L matches [T-0076]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entry, { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 0, max: 729 }),
        fc.integer({ min: 0, max: 729 }),
        fc.integer({ min: 0, max: 729 }),
        async (entries, asAtDay, aDay, bDay) => {
          for (const e of entries) {
            await f.inTenant((trx) =>
              post(trx, {
                companyId: f.companyId,
                idempotencyKey: randomUUID(),
                entryDate: e.date,
                sourceType: 'manual_journal',
                lines: e.lines.map((l): PostingLineInput => ({
                  account: { id: f.acct[l.code] ?? '' },
                  ...(l.net > 0n ? { debit: fmt(l.net) } : { credit: fmt(-l.net) }),
                })),
              }),
            );
            for (const l of e.lines) model.push({ date: e.date, code: l.code, net: l.net });
          }
          const asAt = day(asAtDay);

          // INV-tb-zero
          const tb = await f.inTenant((trx) =>
            trialBalanceReport(trx, { companyId: f.companyId, to: asAt }),
          );
          expect(tb.netsToZero).toBe(true);
          const got = new Map(
            tb.rows.map((r) => [
              r.code,
              units(r.debit.toNumericString()) - units(r.credit.toNumericString()),
            ]),
          );
          const want = netByCode((p) => p.date <= asAt);
          expect(new Set(got.keys())).toEqual(new Set(want.keys()));
          for (const [code, net] of want) expect(got.get(code)).toBe(net);

          // INV-bs-balance
          const bs = await f.inTenant((trx) =>
            balanceSheetReport(trx, { companyId: f.companyId, asAt }),
          );
          expect(bs.balanced).toBe(true);
          const start = yearStart(asAt);
          expect(units(bs.currentYearEarnings.toNumericString())).toBe(profit(start, asAt));
          expect(units(bs.priorYearsEarnings.toNumericString())).toBe(
            profit('0000-01-01', start === '2026-07-01' ? '2026-06-30' : '2025-06-30'),
          );
          expect(bs.assets.total.equals(bs.totalLiabilitiesAndEquity)).toBe(true);

          // INV-pl-range
          const [from, to] = aDay <= bDay ? [day(aDay), day(bDay)] : [day(bDay), day(aDay)];
          const pl = await f.inTenant((trx) =>
            profitAndLossReport(trx, { companyId: f.companyId, from, to }),
          );
          expect(units(pl.netProfit.toNumericString())).toBe(profit(from, to));
        },
      ),
    );
  });
});
