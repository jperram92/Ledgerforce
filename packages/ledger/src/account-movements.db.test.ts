/**
 * accountMovements — the ledger's read API for the reports (T-0076, design §8.1, RQ-0037),
 * against a real PostgreSQL as lf_app.
 *
 * SS-PLAT-76 — posted base-currency movements per account for any date range: whole periods
 *   from account_balance, cut periods from the posted lines by entry_date, drafts and other
 *   companies left out, optional dimension filter (sets holding every requested value).
 *
 * Postings are raw journals through the engine (no event posting rule: golden postings Draft).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMovements, type AccountMovementQuery } from './account-balance.ts';
import { findPeriod } from './period.ts';
import type { PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const dim: Record<string, string> = {};

const A = (code: string, company?: string) => ({
  id: (company ? f.chart(company).acct : f.acct)[code] ?? `missing ${code}`,
});

const postLines = (entryDate: string, lines: PostingLineInput[], companyId = f.companyId) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId,
      idempotencyKey: randomUUID(),
      entryDate,
      sourceType: 'manual_journal',
      lines,
    }),
  );

/** code → [debit, credit] for a query on the main company. */
async function moves(q: Omit<AccountMovementQuery, 'companyId'>) {
  const rows = await f.inTenant((trx) => accountMovements(trx, { companyId: f.companyId, ...q }));
  return Object.fromEntries(rows.map((r) => [r.code, [r.debit, r.credit]]));
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007601');
  await f.inTenant(async (trx) => {
    for (const company of [f.companyId, f.otherCompanyId]) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: company, code: 'je_manual_journal', prefix: 'MJ-' })
        .execute();
    }
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: f.companyId, code: 'department', name: 'Department' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const c of ['SALES', 'OPS']) {
      const v = await trx
        .insertInto('app.dimension_value')
        .values({ company_id: f.companyId, dimension_id: d.id, code: c, name: c })
        .returning('id')
        .executeTakeFirstOrThrow();
      dim[c] = v.id;
    }
  });
  await postLines('2026-09-30', [
    { account: A('1010'), debit: '70.0000' },
    { account: A('4110'), credit: '70.0000' },
  ]);
  await postLines('2026-10-05', [
    { account: A('6200'), debit: '100.0000', dimensions: [dim.SALES ?? ''] },
    { account: A('1010'), credit: '100.0000' },
  ]);
  await postLines('2026-10-20', [
    { account: A('6200'), debit: '50.0000', dimensions: [dim.OPS ?? ''] },
    { account: A('1010'), credit: '50.0000' },
  ]);
  await postLines('2026-11-03', [
    { account: A('6310'), debit: '30.0000' },
    { account: A('1010'), credit: '30.0000' },
  ]);
  // A draft in October and a posting of the other company: neither may appear.
  await f.inTenant((trx) =>
    f.insertEntry(
      trx,
      [
        { code: '6200', debit: '999.0000' },
        { code: '1010', credit: '999.0000' },
      ],
      { status: 'draft', entryDate: '2026-10-06' },
    ),
  );
  // A draft may already carry its period: it still must not count.
  const october = await f.inTenant((trx) => findPeriod(trx, f.companyId, '2026-10-06'));
  await f.inTenant((trx) =>
    f.insertEntry(
      trx,
      [
        { code: '6200', debit: '888.0000' },
        { code: '1010', credit: '888.0000' },
      ],
      { status: 'draft', entryDate: '2026-10-07', periodId: october?.id ?? '' },
    ),
  );
  await postLines(
    '2026-10-05',
    [
      { account: A('6200', f.otherCompanyId), debit: '7.0000' },
      { account: A('1010', f.otherCompanyId), credit: '7.0000' },
    ],
    f.otherCompanyId,
  );
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-76 accountMovements reads posted movements for any date range [T-0076]', () => {
  it('SS-PLAT-76 a whole period comes from account_balance, without drafts or other companies [T-0076]', async () => {
    expect(await moves({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      '1010': ['0.0000', '150.0000'],
      '6200': ['150.0000', '0.0000'],
    });
    const rows = await f.inTenant((trx) =>
      accountMovements(trx, { companyId: f.companyId, from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(rows.map((r) => [r.code, r.name, r.type, r.subtype, r.accountId])).toEqual([
      ['1010', 'Operating account', 'asset', 'bank', f.acct['1010']],
      ['6200', 'Rent', 'expense', 'operating_expense', f.acct['6200']],
    ]);
  });

  it('SS-PLAT-76 a cut period is read from its posted lines by date [T-0076]', async () => {
    expect(await moves({ from: '2026-10-01', to: '2026-10-10' })).toEqual({
      '1010': ['0.0000', '100.0000'],
      '6200': ['100.0000', '0.0000'],
    });
    expect(await moves({ from: '2026-10-06', to: '2026-10-19' })).toEqual({});
    // Cut at both ends, whole period in the middle.
    expect(await moves({ from: '2026-09-30', to: '2026-11-02' })).toEqual({
      '1010': ['70.0000', '150.0000'],
      '4110': ['0.0000', '70.0000'],
      '6200': ['150.0000', '0.0000'],
    });
    expect(await moves({ from: '2026-10-21', to: '2026-11-03' })).toEqual({
      '1010': ['0.0000', '30.0000'],
      '6310': ['30.0000', '0.0000'],
    });
  });

  it('SS-PLAT-76 no start date means from the first period [T-0076]', async () => {
    expect(await moves({ to: '2026-10-31' })).toEqual({
      '1010': ['70.0000', '150.0000'],
      '4110': ['0.0000', '70.0000'],
      '6200': ['150.0000', '0.0000'],
    });
    expect(await moves({ from: null, to: '2026-09-29' })).toEqual({});
    expect(await moves({ to: '2027-06-30' })).toEqual({
      '1010': ['70.0000', '180.0000'],
      '4110': ['0.0000', '70.0000'],
      '6200': ['150.0000', '0.0000'],
      '6310': ['30.0000', '0.0000'],
    });
  });

  it('SS-PLAT-76 a dimension filter keeps sets holding every requested value [T-0076]', async () => {
    const sales = [dim.SALES ?? ''];
    expect(await moves({ to: '2026-12-31', dimensionValueIds: sales })).toEqual({
      '6200': ['100.0000', '0.0000'],
    });
    expect(
      await moves({ from: '2026-10-01', to: '2026-10-10', dimensionValueIds: [dim.OPS ?? ''] }),
    ).toEqual({});
    expect(
      await moves({ to: '2026-12-31', dimensionValueIds: [dim.SALES ?? '', dim.OPS ?? ''] }),
    ).toEqual({});
    expect(await moves({ to: '2026-12-31', dimensionValueIds: [] })).toEqual(
      await moves({ to: '2026-12-31' }),
    );
  });
});
