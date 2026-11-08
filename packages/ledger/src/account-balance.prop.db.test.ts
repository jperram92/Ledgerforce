/**
 * account_balance invariants over random postings through the engine (T-0027, SS-PLAT-66),
 * against a real PostgreSQL as lf_app. Default fast-check numRuns; amounts are bigint
 * ten-thousandths formatted as decimal strings (never floats).
 *
 * INV-balance-table  after any posting, every account_balance row equals the sum of the posted
 *                    lines of its (company, account, period, dimension set, currency) and no
 *                    posted line is missing a row (accountBalanceDrift is empty);
 * INV-tb-zero        the trial balance read from account_balance nets to zero and matches a
 *                    model of the postings kept in the test;
 * INV-reversal       posting the mirror of an entry restores every account's net balance.
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountBalanceDrift, trialBalance } from './account-balance.ts';
import type { PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const dims: string[] = [];
/** Postable, non-control, unrestricted accounts of the AU services chart. */
const CODES = ['1010', '1020', '1100', '4110', '4120', '5000', '6110', '6200', '6310', '2900'];

const fmt = (u: bigint): string => {
  const s = u < 0n ? '-' : '';
  const a = u < 0n ? -u : u;
  return `${s}${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
const units = (s: string): bigint => {
  const [i = '0', d = ''] = s.split('.');
  return BigInt(i) * 10_000n + BigInt(d.padEnd(4, '0').slice(0, 4));
};

interface Gen {
  side: 'debit' | 'credit';
  u: bigint;
  code: string;
  dim: number;
  usd: boolean;
}

const balancedEntry = fc
  .record({
    debits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 4 }),
    credits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 4 }),
    codes: fc.array(fc.constantFrom(...CODES), { minLength: 9, maxLength: 9 }),
    dims: fc.array(fc.integer({ min: -1, max: 2 }), { minLength: 9, maxLength: 9 }),
    usd: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
    day: fc.integer({ min: 1, max: 28 }),
    month: fc.constantFrom('2026-07', '2026-10', '2027-01', '2027-06'),
  })
  .map(({ debits, credits, codes, dims: ds, usd, day, month }) => {
    const d = debits.reduce((a, b) => a + b, 0n);
    const c = credits.reduce((a, b) => a + b, 0n);
    const sides: [Gen['side'], bigint][] = [
      ...debits.map((u): [Gen['side'], bigint] => ['debit', u]),
      ...credits.map((u): [Gen['side'], bigint] => ['credit', u]),
      ...(d > c
        ? [['credit', d - c] as [Gen['side'], bigint]]
        : c > d
          ? [['debit', c - d] as [Gen['side'], bigint]]
          : []),
    ];
    return {
      entryDate: `${month}-${String(day).padStart(2, '0')}`,
      lines: sides.map(([side, u], i): Gen => ({
        side,
        u,
        code: codes[i] ?? '1010',
        dim: ds[i] ?? -1,
        usd: usd[i] ?? false,
      })),
    };
  });

const toInput = (g: Gen, flip = false): PostingLineInput => {
  const side = flip ? (g.side === 'debit' ? 'credit' : 'debit') : g.side;
  const dim = dims[g.dim];
  return {
    account: { id: f.acct[g.code] ?? '' },
    [side]: fmt(g.u),
    ...(dim === undefined ? {} : { dimensions: [dim] }),
    // A USD line: the base amount is given; txnAmount/rate are carried as stated (DL-0138).
    ...(g.usd ? { txnCurrency: 'USD', txnAmount: fmt(g.u * 2n), fxRate: '0.5' } : {}),
  };
};

const postLines = (entryDate: string, lines: PostingLineInput[]) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate,
      sourceType: 'manual_journal',
      lines,
    }),
  );

/** Net (debit − credit, in units) per account code, from the trial balance in account_balance. */
async function netByCode(): Promise<Map<string, bigint>> {
  const tb = await f.inTenant((trx) => trialBalance(trx, f.companyId));
  return new Map(tb.map((r) => [r.code, units(r.debit) - units(r.credit)]));
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002702');
  await f.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute();
    for (const [code, values] of [
      ['department', ['SALES', 'OPS']],
      ['region', ['NSW']],
    ] as const) {
      const d = await trx
        .insertInto('app.dimension')
        .values({ company_id: f.companyId, code, name: code })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const v of values) {
        const r = await trx
          .insertInto('app.dimension_value')
          .values({ company_id: f.companyId, dimension_id: d.id, code: v, name: v })
          .returning('id')
          .executeTakeFirstOrThrow();
        dims.push(r.id);
      }
    }
  });
});

afterAll(async () => {
  await f.close();
});

describe('account_balance invariants through the posting engine [T-0027]', () => {
  it('SS-PLAT-66 INV-balance-table and INV-tb-zero: balances equal the posted lines and the trial balance nets to zero [T-0027]', async () => {
    const model = new Map<string, bigint>();
    await fc.assert(
      fc.asyncProperty(balancedEntry, async ({ entryDate, lines }) => {
        await postLines(
          entryDate,
          lines.map((g) => toInput(g)),
        );
        for (const g of lines) {
          model.set(g.code, (model.get(g.code) ?? 0n) + (g.side === 'debit' ? g.u : -g.u));
        }
        await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual(
          [],
        );
        const tb = await f.inTenant((trx) => trialBalance(trx, f.companyId));
        const dr = tb.reduce((a, r) => a + units(r.debit), 0n);
        const cr = tb.reduce((a, r) => a + units(r.credit), 0n);
        expect(fmt(dr)).toBe(fmt(cr));
        const net = await netByCode();
        for (const [c, v] of model) expect(fmt(net.get(c) ?? 0n), c).toBe(fmt(v));
      }),
    );
  });

  it('SS-PLAT-66 INV-reversal: posting the mirror of any entry restores every net balance [T-0027]', async () => {
    await fc.assert(
      fc.asyncProperty(balancedEntry, async ({ entryDate, lines }) => {
        const before = await netByCode();
        await postLines(
          entryDate,
          lines.map((g) => toInput(g)),
        );
        await postLines(
          entryDate,
          lines.map((g) => toInput(g, true)),
        );
        const after = await netByCode();
        for (const c of new Set([...before.keys(), ...after.keys()])) {
          expect(fmt(after.get(c) ?? 0n), c).toBe(fmt(before.get(c) ?? 0n));
        }
        await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual(
          [],
        );
      }),
    );
  });
});
