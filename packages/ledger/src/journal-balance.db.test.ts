/**
 * SS-PLAT-01 — the deferred balance constraint trigger rejects unbalanced entries (T-0020,
 * design §3.3 invariant 1, ADR-0004 rule 3). Plus the line-shape checks (exactly one side > 0)
 * and an entry must have lines. Everything runs as lf_app in a tenant transaction; amounts are
 * decimal strings built from integers (no floating point on money, AGENTS.md §4).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { sql, type Kysely, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dimensionSetId } from './dimension-set.ts';

const T = '01900000-0000-7000-8000-0000000005aa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId: string;
let otherCompanyAccount: string;
let emptySet: string;
const acct: Record<string, string> = {};

const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

/** 4-decimal string from an integer number of ten-thousandths (exact; no float). */
const money = (units: bigint): string => {
  const s = units.toString().padStart(5, '0');
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

interface Line {
  code: string;
  debit?: string;
  credit?: string;
}

async function insertEntry(trx: Transaction<Database>, lines: Line[], company = companyId) {
  const entry = await trx
    .insertInto('app.journal_entry')
    .values({
      company_id: company,
      entry_date: '2026-10-24',
      source_type: 'manual_journal',
      status: 'posted',
      idempotency_key: randomUUID(),
      posted_at: new Date('2026-10-24T09:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (lines.length > 0) {
    await trx
      .insertInto('app.journal_line')
      .values(
        lines.map((l, i) => {
          const id = acct[l.code] ?? l.code;
          const amount = l.debit ?? l.credit ?? '0';
          return {
            company_id: company,
            entry_id: entry.id,
            line_no: i + 1,
            account_id: id,
            debit: l.debit ?? '0',
            credit: l.credit ?? '0',
            txn_currency: 'AUD',
            txn_amount: amount,
            fx_rate: '1',
            dimension_set_id: emptySet,
          };
        }),
      )
      .execute();
  }
  return entry.id;
}

const countEntries = () =>
  inTenant((trx) =>
    trx
      .selectFrom('app.journal_entry')
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirstOrThrow(),
  ).then((r) => r.n);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 4);
  await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const [c1, c2] = await trx
      .insertInto('app.company')
      .values([
        { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
        { name: 'Harbour Holdings Pty Ltd', base_currency: 'AUD' },
      ])
      .returning('id')
      .execute();
    if (!c1 || !c2) throw new Error('seed failed');
    companyId = c1.id;
    const chart = await loadChartTemplate(trx, companyId, auServicesSmb);
    for (const [code, id] of chart.accounts) acct[code] = id;
    const other = await loadChartTemplate(trx, c2.id, auServicesSmb);
    otherCompanyAccount = other.accounts.get('1010') ?? '';
    emptySet = await dimensionSetId(trx, companyId, []);
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-01: Balance trigger rejects unbalanced entries', () => {
  it('Σdebit 100.00 vs Σcredit 99.99: commit fails with the balance error and nothing is stored', async () => {
    const before = await countEntries();
    await expect(
      inTenant((trx) =>
        insertEntry(trx, [
          { code: '1200', debit: '100.0000' },
          { code: '4110', credit: '99.9900' },
        ]),
      ),
    ).rejects.toThrow(/journal entry .* does not balance: debit 100\.0000, credit 99\.9900/);
    expect(await countEntries()).toBe(before);
  });

  it('a balanced entry commits', async () => {
    const before = await countEntries();
    await inTenant((trx) =>
      insertEntry(trx, [
        { code: '1200', debit: '110.0000' },
        { code: '4110', credit: '100.0000' },
        { code: '2310', credit: '10.0000' },
      ]),
    );
    expect(await countEntries()).toBe(before + 1);
  });

  it('the check is deferred to commit: a one-sided line may exist mid-transaction', async () => {
    await inTenant(async (trx) => {
      const id = await insertEntry(trx, [{ code: '6200', debit: '50.0000' }]);
      await trx
        .insertInto('app.journal_line')
        .values({
          company_id: companyId,
          entry_id: id,
          line_no: 2,
          account_id: acct['1010'] ?? '',
          debit: '0',
          credit: '50.0000',
          txn_currency: 'AUD',
          txn_amount: '50.0000',
          fx_rate: '1',
          dimension_set_id: emptySet,
        })
        .execute();
    });
  });

  it('a difference of 0.0001 is still refused (exact NUMERIC, no tolerance)', async () => {
    await expect(
      inTenant((trx) =>
        insertEntry(trx, [
          { code: '1200', debit: '0.0001' },
          { code: '4110', credit: '0.0002' },
        ]),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('an entry without lines is refused at commit', async () => {
    await expect(inTenant((trx) => insertEntry(trx, []))).rejects.toThrow(/at least two lines/);
  });

  it('every line has exactly one side > 0', async () => {
    const both = inTenant((trx) =>
      insertEntry(trx, [
        { code: '1200', debit: '5.0000', credit: '5.0000' },
        { code: '4110', credit: '0.0000' },
      ]),
    );
    await expect(both).rejects.toMatchObject({ code: '23514' });
    const neither = inTenant((trx) =>
      insertEntry(trx, [
        { code: '1200', debit: '0' },
        { code: '4110', credit: '0' },
      ]),
    );
    await expect(neither).rejects.toMatchObject({ code: '23514' });
    const negative = inTenant((trx) =>
      insertEntry(trx, [
        { code: '1200', debit: '-5.0000' },
        { code: '4110', credit: '-5.0000' },
      ]),
    );
    await expect(negative).rejects.toMatchObject({ code: '23514' });
  });

  it("a line cannot use another company's account", async () => {
    await expect(
      inTenant((trx) =>
        insertEntry(trx, [
          { code: otherCompanyAccount, debit: '1.0000' },
          { code: '4110', credit: '1.0000' },
        ]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('amounts are numeric(19,4) and rates numeric(18,8), never float (ADR-0005 catalog check)', async () => {
    // PostgreSQL rounds a 5th decimal on input (typmod coercion runs before any CHECK or trigger),
    // so refusing it is the posting engine's job at its boundary (T-0025, DL-0074).
    const cols = await sql<{ column_name: string; data_type: string; p: number; s: number }>`
      SELECT column_name, data_type, numeric_precision AS p, numeric_scale AS s
        FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name IN ('journal_line', 'journal_entry')
         AND column_name IN ('debit', 'credit', 'txn_amount', 'tax_amount', 'fx_rate')
       ORDER BY column_name`.execute(db);
    expect(cols.rows).toEqual([
      { column_name: 'credit', data_type: 'numeric', p: 19, s: 4 },
      { column_name: 'debit', data_type: 'numeric', p: 19, s: 4 },
      { column_name: 'fx_rate', data_type: 'numeric', p: 18, s: 8 },
      { column_name: 'tax_amount', data_type: 'numeric', p: 19, s: 4 },
      { column_name: 'txn_amount', data_type: 'numeric', p: 19, s: 4 },
    ]);
  });

  it('property: any balanced entry commits; moving 0.0001 off either side makes it fail', async () => {
    // Amounts as Money (exact decimal); the credit side is the same total split by
    // Money.allocate (largest remainder), so the entry balances exactly by construction.
    const amounts = fc.array(fc.bigInt({ min: 1n, max: 10_000_000_000n }), {
      minLength: 1,
      maxLength: 6,
    });
    const weights = fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 6 });
    const tick = Money.of('0.0001', 'AUD');
    await fc.assert(
      fc.asyncProperty(amounts, weights, fc.boolean(), async (debitUnits, ratios, skewDebit) => {
        const debits = debitUnits.map((u) => Money.fromNumeric(money(u), 'AUD'));
        const total = debits.reduce((a, b) => a.add(b), Money.zero('AUD'));
        const credits = total.allocate(ratios, { scale: 4 });
        if (credits.some((c) => c.isZero())) return; // a line must be > 0; skip degenerate splits
        const lines: Line[] = [
          ...debits.map((d) => ({ code: '1200', debit: d.toNumericString() })),
          ...credits.map((c) => ({ code: '4110', credit: c.toNumericString() })),
        ];
        await inTenant((trx) => insertEntry(trx, lines));
        const first = debits[0] ?? Money.zero('AUD');
        const last = credits[credits.length - 1] ?? Money.zero('AUD');
        const skewed = lines.map((l, i) => {
          if (skewDebit && i === 0) return { ...l, debit: first.add(tick).toNumericString() };
          if (!skewDebit && i === lines.length - 1) {
            return { ...l, credit: last.add(tick).toNumericString() };
          }
          return l;
        });
        await expect(inTenant((trx) => insertEntry(trx, skewed))).rejects.toThrow(
          /does not balance/,
        );
      }),
      { numRuns: 30 },
    );
  });
});
