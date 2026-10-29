/**
 * Ledger invariants over random postings through the engine (T-0025), against a real PostgreSQL
 * as lf_app. Default fast-check numRuns; amounts are bigint ten-thousandths formatted as decimal
 * strings (never floats).
 *
 * INV-balance  every entry the engine posts balances in base currency, line by line as built;
 * INV-tb-zero  after any sequence of postings the trial balance (Σdebit − Σcredit over all
 *              lines of the company) nets to zero and the hash chain verifies;
 * INV-idempotent posting a command again with its key adds nothing.
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from './hash-chain.ts';
import type { PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
/** Postable, non-control, unrestricted accounts of the AU services chart. */
const CODES = [
  '1010',
  '1020',
  '1100',
  '1300',
  '4110',
  '4120',
  '5000',
  '6110',
  '6200',
  '6310',
  '2900',
];

const fmt = (u: bigint): string =>
  `${(u / 10_000n).toString()}.${(u % 10_000n).toString().padStart(4, '0')}`;

const balanced = fc
  .record({
    debits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 11n }), { minLength: 1, maxLength: 4 }),
    credits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 11n }), { minLength: 1, maxLength: 4 }),
    codes: fc.array(fc.constantFrom(...CODES), { minLength: 9, maxLength: 9 }),
    day: fc.integer({ min: 1, max: 28 }),
    month: fc.constantFrom('2026-07', '2026-10', '2027-01', '2027-06'),
  })
  .map(({ debits, credits, codes, day, month }) => {
    const d = debits.reduce((a, b) => a + b, 0n);
    const c = credits.reduce((a, b) => a + b, 0n);
    const sides = [
      ...debits.map((u) => ['debit', u] as const),
      ...credits.map((u) => ['credit', u] as const),
      ...(d > c ? [['credit', d - c] as const] : c > d ? [['debit', c - d] as const] : []),
    ];
    return {
      entryDate: `${month}-${String(day).padStart(2, '0')}`,
      lines: sides.map(([side, u], i): PostingLineInput => ({
        account: { id: f.acct[codes[i] ?? '1010'] ?? '' },
        [side]: fmt(u),
      })),
    };
  });

const trialBalance = () =>
  f.inTenant((trx) =>
    sql<{ dr: string; cr: string; unbalanced: number }>`
      SELECT coalesce(sum(debit), 0)::text AS dr, coalesce(sum(credit), 0)::text AS cr,
             (SELECT count(*)::int FROM (
                SELECT entry_id FROM app.journal_line WHERE company_id = ${f.companyId}
                 GROUP BY entry_id HAVING sum(debit) <> sum(credit)) u) AS unbalanced
        FROM app.journal_line WHERE company_id = ${f.companyId}`
      .execute(trx)
      .then((r) => r.rows[0]),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002565');
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute(),
  );
});

afterAll(async () => {
  await f.close();
});

describe('Ledger invariants through the posting engine [T-0025]', () => {
  it('INV-balance and INV-tb-zero any sequence of random balanced commands posts balanced entries and the trial balance nets to zero [T-0025]', async () => {
    await fc.assert(
      fc.asyncProperty(balanced, async ({ entryDate, lines }) => {
        const r = await f.inTenant((trx) =>
          post(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            entryDate,
            sourceType: 'manual_journal',
            lines,
          }),
        );
        expect(r.entryDate).toBe(entryDate);
        const tb = await trialBalance();
        expect(tb?.unbalanced).toBe(0);
        expect(tb?.dr).toBe(tb?.cr);
      }),
    );
    await expect(f.inTenant((trx) => verifyChain(trx, f.companyId))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('INV-idempotent posting any command twice with its key adds exactly one entry [T-0025]', async () => {
    await fc.assert(
      fc.asyncProperty(balanced, async ({ entryDate, lines }) => {
        const command = {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          entryDate,
          sourceType: 'manual_journal',
          lines,
        };
        const before = await f.countEntries();
        const a = await f.inTenant((trx) => post(trx, command));
        const b = await f.inTenant((trx) => post(trx, command));
        expect(b).toEqual({ ...a, replayed: true });
        expect(await f.countEntries()).toBe(before + 1);
      }),
    );
  });
});
