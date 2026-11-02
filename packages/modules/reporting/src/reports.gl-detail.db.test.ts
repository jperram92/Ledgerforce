/**
 * General ledger detail against a real PostgreSQL as lf_app (T-0077, design §8.1, DL-0290).
 *
 * SS-PLAT-108 — GL detail for a date range or a period, filtered by account, dimension values and
 *   party: per account an opening balance (everything before `from`, same filters), every posted
 *   line in date order with its running balance, and a closing balance; base currency; drafts
 *   and other companies left out. Unfiltered, each account's closing balance equals its trial
 *   balance at `to`, so the detail reconciles to the TB (and to the AR/AP control accounts).
 *
 * Postings are raw journals through the posting engine; the AR line uses the ar_invoice source
 * type so the control account accepts it (design §3.2).
 */
import { findPeriod, post, type PostingLineInput } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { glDetailReport, type GlDetailReport } from './gl-detail.ts';
import { ReportError, trialBalanceReport } from './reports.ts';

let f: LedgerFixture;
let october = '';
let customer = '';
const dim: Record<string, string> = {};

type Line = [code: string, amount: string, opts?: { dim?: string; party?: string; memo?: string }];

const postLines = (
  entryDate: string,
  lines: Line[],
  sourceType = 'manual_journal',
  memo?: string,
) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate,
      sourceType,
      ...(memo ? { memo } : {}),
      lines: lines.map(([code, amount, o]): PostingLineInput => {
        const id = f.acct[code.slice(1)] ?? `missing ${code}`;
        const side = code.startsWith('D') ? 'debit' : 'credit';
        return {
          account: { id },
          [side]: amount,
          ...(o?.dim ? { dimensions: [o.dim] } : {}),
          ...(o?.party ? { partyId: o.party } : {}),
          ...(o?.memo ? { memo: o.memo } : {}),
        };
      }),
    }),
  );

/** The report with Money as NUMERIC strings, for exact comparison. */
const plain = (r: GlDetailReport) =>
  r.accounts.map((a) => ({
    code: a.code,
    opening: a.opening.toNumericString(),
    lines: a.lines.map((l) => [
      l.date,
      l.debit.toNumericString(),
      l.credit.toNumericString(),
      l.balance.toNumericString(),
    ]),
    totalDebit: a.totalDebit.toNumericString(),
    totalCredit: a.totalCredit.toNumericString(),
    closing: a.closing.toNumericString(),
  }));

const run = <R>(fn: Parameters<typeof f.inTenant<R>>[0]) => f.inTenant(fn);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007701');
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of [
      ['je_manual_journal', 'MJ-'],
      ['je_ar_invoice', 'AR-'],
    ] as const)
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix })
        .execute();
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.otherCompanyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute();
    october = (await findPeriod(trx, f.companyId, '2026-10-15'))?.id ?? '';
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
    customer = (
      await trx
        .insertInto('app.party')
        .values({
          company_id: f.companyId,
          legal_name: 'Ledger Detail Customer Pty Ltd',
          status: 'active',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  // Before October: capital 1,000 into the bank.
  await postLines('2026-08-10', [
    ['D1010', '1000.0000'],
    ['C3000', '1000.0000'],
  ]);
  // October.
  await postLines(
    '2026-10-05',
    [
      ['D6200', '150.0000', { dim: dim.SALES ?? '', memo: 'Rent October' }],
      ['C1010', '150.0000'],
    ],
    'manual_journal',
    'October rent',
  );
  await postLines(
    '2026-10-20',
    [
      ['D1200', '1100.0000', { party: customer }],
      ['C4110', '1000.0000', { party: customer }],
      ['C2310', '100.0000'],
    ],
    'ar_invoice',
  );
  await postLines('2026-10-21', [
    ['D6200', '40.0000', { dim: dim.OPS ?? '' }],
    ['C1010', '40.0000'],
  ]);
  // After October, a draft in October and another company: never in the October detail.
  await postLines('2026-11-02', [
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
      { status: 'draft', entryDate: '2026-10-25' },
    ),
  );
  await f.inTenant((trx) =>
    post(trx, {
      companyId: f.otherCompanyId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-10-05',
      sourceType: 'manual_journal',
      lines: [
        { account: { id: f.chart(f.otherCompanyId).acct['6200'] ?? '' }, debit: '7.0000' },
        { account: { id: f.chart(f.otherCompanyId).acct['1010'] ?? '' }, credit: '7.0000' },
      ],
    }),
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-108 GL detail with filters reconciling to the trial balance [T-0077]', () => {
  it('SS-PLAT-108 one account for October: opening, each line with a running balance, closing', async () => {
    const r = await run((trx) =>
      glDetailReport(trx, {
        companyId: f.companyId,
        from: '2026-10-01',
        to: '2026-10-31',
        accountIds: [f.acct['1010'] ?? ''],
      }),
    );
    expect([r.currency, r.from, r.to, r.partyId]).toEqual([
      'AUD',
      '2026-10-01',
      '2026-10-31',
      null,
    ]);
    expect(plain(r)).toEqual([
      {
        code: '1010',
        opening: '1000.0000',
        lines: [
          ['2026-10-05', '0.0000', '150.0000', '850.0000'],
          ['2026-10-21', '0.0000', '40.0000', '810.0000'],
        ],
        totalDebit: '0.0000',
        totalCredit: '190.0000',
        closing: '810.0000',
      },
    ]);
    const first = r.accounts[0]?.lines[0];
    expect(first).toMatchObject({ sourceType: 'manual_journal', memo: 'October rent', lineNo: 2 });
    expect(first?.entryNo).toMatch(/^MJ-/);
  });

  it('SS-PLAT-108 unfiltered October detail: every account in code order, closing = TB at the period end, drafts/November/other companies left out', async () => {
    const r = await run((trx) =>
      glDetailReport(trx, { companyId: f.companyId, periodId: october }),
    );
    expect([r.from, r.to]).toEqual(['2026-10-01', '2026-10-31']);
    expect(plain(r)).toEqual([
      {
        code: '1010',
        opening: '1000.0000',
        lines: [
          ['2026-10-05', '0.0000', '150.0000', '850.0000'],
          ['2026-10-21', '0.0000', '40.0000', '810.0000'],
        ],
        totalDebit: '0.0000',
        totalCredit: '190.0000',
        closing: '810.0000',
      },
      {
        code: '1200',
        opening: '0.0000',
        lines: [['2026-10-20', '1100.0000', '0.0000', '1100.0000']],
        totalDebit: '1100.0000',
        totalCredit: '0.0000',
        closing: '1100.0000',
      },
      {
        code: '2310',
        opening: '0.0000',
        lines: [['2026-10-20', '0.0000', '100.0000', '-100.0000']],
        totalDebit: '0.0000',
        totalCredit: '100.0000',
        closing: '-100.0000',
      },
      {
        code: '3000',
        opening: '-1000.0000',
        lines: [],
        totalDebit: '0.0000',
        totalCredit: '0.0000',
        closing: '-1000.0000',
      },
      {
        code: '4110',
        opening: '0.0000',
        lines: [['2026-10-20', '0.0000', '1000.0000', '-1000.0000']],
        totalDebit: '0.0000',
        totalCredit: '1000.0000',
        closing: '-1000.0000',
      },
      {
        code: '6200',
        opening: '0.0000',
        lines: [
          ['2026-10-05', '150.0000', '0.0000', '150.0000'],
          ['2026-10-21', '40.0000', '0.0000', '190.0000'],
        ],
        totalDebit: '190.0000',
        totalCredit: '0.0000',
        closing: '190.0000',
      },
    ]);
    expect([r.totalDebit.toNumericString(), r.totalCredit.toNumericString()]).toEqual([
      '1290.0000',
      '1290.0000',
    ]);
    const tb = await run((trx) =>
      trialBalanceReport(trx, { companyId: f.companyId, to: '2026-10-31' }),
    );
    expect(r.accounts.map((a) => [a.accountId, a.closing.toNumericString()])).toEqual(
      tb.rows.map((t) => [t.accountId, t.debit.sub(t.credit).toNumericString()]),
    );
  });

  it('SS-PLAT-108 a dimension filter keeps only lines tagged with every value; opening uses the same filter', async () => {
    const r = await run((trx) =>
      glDetailReport(trx, {
        companyId: f.companyId,
        from: '2026-10-01',
        to: '2026-10-31',
        dimensionValueIds: [dim.SALES ?? ''],
      }),
    );
    expect(r.dimensionValueIds).toEqual([dim.SALES]);
    expect(plain(r)).toEqual([
      {
        code: '6200',
        opening: '0.0000',
        lines: [['2026-10-05', '150.0000', '0.0000', '150.0000']],
        totalDebit: '150.0000',
        totalCredit: '0.0000',
        closing: '150.0000',
      },
    ]);
    expect(r.accounts[0]?.lines[0]?.memo).toBe('Rent October');
  });

  it('SS-PLAT-108 a party filter keeps only that party’s lines, with its name', async () => {
    const r = await run((trx) =>
      glDetailReport(trx, {
        companyId: f.companyId,
        from: '2026-10-01',
        to: '2026-10-31',
        partyId: customer,
      }),
    );
    expect(r.partyId).toBe(customer);
    expect(plain(r).map((a) => [a.code, a.closing])).toEqual([
      ['1200', '1100.0000'],
      ['4110', '-1000.0000'],
    ]);
    expect(r.accounts[0]?.lines[0]).toMatchObject({
      partyId: customer,
      partyName: 'Ledger Detail Customer Pty Ltd',
      sourceType: 'ar_invoice',
    });
  });

  it('SS-PLAT-108 bad filters are refused with a report error', async () => {
    const c = f.companyId;
    await expect(
      run((trx) => glDetailReport(trx, { companyId: c, from: '2026-11-01', to: '2026-10-31' })),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      run((trx) => glDetailReport(trx, { companyId: c, from: '2026-10-01' })),
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
    await expect(
      run((trx) => glDetailReport(trx, { companyId: c, periodId: randomUUID() })),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PERIOD' });
    await expect(
      run((trx) => glDetailReport(trx, { companyId: randomUUID(), to: '2026-10-31' })),
    ).rejects.toMatchObject({ code: 'UNKNOWN_COMPANY' });
    await expect(
      run((trx) =>
        glDetailReport(trx, { companyId: c, to: '2026-10-31', accountIds: ['not-a-uuid'] }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    await expect(
      run((trx) => glDetailReport(trx, { companyId: c, to: '2026-10-31', partyId: 'x' })),
    ).rejects.toBeInstanceOf(ReportError);
  });
});
