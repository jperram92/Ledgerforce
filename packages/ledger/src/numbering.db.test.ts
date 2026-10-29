/**
 * Gapless document numbering (T-0024, design §3.4, RQ-0007 (d)).
 * SS-PLAT-05 — 50 concurrent postings in one series, 5 rolling back → 45 consecutive numbers.
 * SS-UC02-06 (numbering layer; the invoice batch itself is T-0044) — a batch of 40 documents,
 * each in its own transaction, one failing at commit → the 39 posted have consecutive numbers.
 * Numbers are written to journal_entry.entry_no, so "committed" means a real committed entry.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextNumber } from './numbering.ts';
import { createLedgerFixture, type LedgerFixture, type Line } from './testing/journal-fixture.ts';

let f: LedgerFixture;
/** A wider pool than the fixture's, so up to 12 transactions really run at once. */
let wide: Kysely<Database>;

const balanced: Line[] = [
  { code: '1200', debit: '110.0000' },
  { code: '4110', credit: '100.0000' },
  { code: '2310', credit: '10.0000' },
];
const unbalanced: Line[] = [
  { code: '1200', debit: '110.0000' },
  { code: '4110', credit: '100.0000' },
];

async function addSeries(
  company: string,
  code: string,
  opts: { prefix?: string; width?: number; next?: number } = {},
) {
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({
        company_id: company,
        code,
        prefix: opts.prefix ?? 'INV-',
        pad_width: opts.width ?? 6,
        next_value: String(opts.next ?? 1),
      })
      .execute(),
  );
}

const entryNos = (company: string) =>
  f
    .inTenant((trx) =>
      trx
        .selectFrom('app.journal_entry')
        .select('entry_no')
        .where('company_id', '=', company)
        .where('entry_no', 'is not', null)
        .execute(),
    )
    .then((rows) => rows.map((r) => r.entry_no ?? '').sort());

const expected = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(6, '0')}`);

/** Post one numbered entry in its own transaction on `db`. */
const postNumbered = (
  db: Kysely<Database>,
  company: string,
  series: string,
  lines: Line[],
  fail?: 'throw' | 'commit',
) =>
  withTenant(db, f.tenantId, async (trx: Transaction<Database>) => {
    const no = await nextNumber(trx, company, series);
    await f.insertEntry(trx, fail === 'commit' ? unbalanced : lines, { company, entryNo: no });
    await sql`SELECT pg_sleep(0.005)`.execute(trx); // hold the series lock a little: real contention
    if (fail === 'throw') throw new Error(`deliberate rollback after taking ${no}`);
    return no;
  });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-0000000008aa');
  wide = createDb(f.tdb.url('lf_app'), 12);
});

afterAll(async () => {
  await wide.destroy();
  await f.close();
});

describe('SS-PLAT-05: Gapless numbering under concurrency and rollback', () => {
  it('50 concurrent postings, 5 rolling back, leave 45 consecutive numbers', async () => {
    const company = await f.addCompany('Concurrent numbering Pty Ltd');
    await addSeries(company, 'invoice');
    const failing = new Set([3, 11, 20, 33, 47]);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        postNumbered(wide, company, 'invoice', balanced, failing.has(i) ? 'throw' : undefined),
      ),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
    expect(await entryNos(company)).toEqual(expected('INV-', 45));
    const series = await f.inTenant((trx) =>
      trx
        .selectFrom('app.number_series')
        .select('next_value')
        .where('company_id', '=', company)
        .executeTakeFirstOrThrow(),
    );
    expect(series.next_value).toBe('46');
  });

  it('a number is returned when the transaction fails at commit (deferred balance check)', async () => {
    const company = await f.addCompany('Commit failure Pty Ltd');
    await addSeries(company, 'invoice');
    await postNumbered(f.db, company, 'invoice', balanced);
    await expect(postNumbered(f.db, company, 'invoice', balanced, 'commit')).rejects.toThrow(
      /does not balance/,
    );
    expect(await postNumbered(f.db, company, 'invoice', balanced)).toBe('INV-000002');
  });
});

describe('SS-UC02-06: Consecutive gapless numbers; failed invoice consumes none', () => {
  it('a batch of 40, each in its own transaction, the 13th failing: the 39 posted are consecutive', async () => {
    const company = await f.addCompany('Batch numbering Pty Ltd');
    await addSeries(company, 'invoice');
    const outcomes: string[] = [];
    for (let i = 1; i <= 40; i += 1) {
      try {
        outcomes.push(
          await postNumbered(f.db, company, 'invoice', balanced, i === 13 ? 'commit' : undefined),
        );
      } catch {
        outcomes.push('failed');
      }
    }
    expect(outcomes.filter((o) => o === 'failed')).toHaveLength(1);
    expect(outcomes[12]).toBe('failed');
    expect(outcomes[13]).toBe('INV-000013'); // the failed document's number went to the next one
    expect(await entryNos(company)).toEqual(expected('INV-', 39));
  });
});

describe('number series rules', () => {
  it('formats prefix + zero-padded value, and never truncates a value wider than the padding', async () => {
    const company = await f.addCompany('Format Pty Ltd');
    await addSeries(company, 'credit_note', { prefix: 'CN-', width: 2, next: 99 });
    const got = await f.inTenant(async (trx) => [
      await nextNumber(trx, company, 'credit_note'),
      await nextNumber(trx, company, 'credit_note'),
    ]);
    expect(got).toEqual(['CN-99', 'CN-100']);
  });

  it('series are independent per company and per code', async () => {
    const a = await f.addCompany('Independent A Pty Ltd');
    const b = await f.addCompany('Independent B Pty Ltd');
    await addSeries(a, 'invoice');
    await addSeries(a, 'bill', { prefix: 'BILL-' });
    await addSeries(b, 'invoice');
    const got = await f.inTenant(async (trx) => [
      await nextNumber(trx, a, 'invoice'),
      await nextNumber(trx, a, 'bill'),
      await nextNumber(trx, b, 'invoice'),
      await nextNumber(trx, a, 'invoice'),
    ]);
    expect(got).toEqual(['INV-000001', 'BILL-000001', 'INV-000001', 'INV-000002']);
  });

  it('an unknown or archived series is refused', async () => {
    const company = await f.addCompany('Unknown series Pty Ltd');
    await expect(f.inTenant((trx) => nextNumber(trx, company, 'invoice'))).rejects.toThrow(
      /no active number series/,
    );
    await addSeries(company, 'invoice');
    await f.inTenant((trx) =>
      trx
        .updateTable('app.number_series')
        .set({ status: 'archived' })
        .where('company_id', '=', company)
        .execute(),
    );
    await expect(f.inTenant((trx) => nextNumber(trx, company, 'invoice'))).rejects.toThrow(
      /no active number series/,
    );
  });

  it('the counter only moves forward by exactly one: no reset, no skip', async () => {
    const company = await f.addCompany('Counter guard Pty Ltd');
    await addSeries(company, 'invoice');
    await f.inTenant((trx) => nextNumber(trx, company, 'invoice'));
    for (const next of ['1', '7']) {
      await expect(
        f.inTenant((trx) =>
          trx
            .updateTable('app.number_series')
            .set({ next_value: next })
            .where('company_id', '=', company)
            .execute(),
        ),
        next,
      ).rejects.toThrow(/next_value/);
    }
  });

  it('prefix and width are fixed once a number has been issued', async () => {
    const company = await f.addCompany('Prefix guard Pty Ltd');
    await addSeries(company, 'invoice');
    await f.inTenant((trx) =>
      trx
        .updateTable('app.number_series')
        .set({ prefix: 'TAX-' })
        .where('company_id', '=', company)
        .execute(),
    ); // allowed before the first number
    await f.inTenant((trx) => nextNumber(trx, company, 'invoice'));
    await expect(
      f.inTenant((trx) =>
        trx
          .updateTable('app.number_series')
          .set({ prefix: 'X-' })
          .where('company_id', '=', company)
          .execute(),
      ),
    ).rejects.toThrow(/prefix/);
  });
});
