/**
 * T-0126 foreign-currency open items at conversion (design §4.1 step 9, §3.7, GP-043, RQ-0170,
 * DL-0740, DL-0741), against a real PostgreSQL as lf_app.
 *
 * SS-PLAT-137: a USD invoice and a USD bill post as GP-043 line for line, with their transaction
 * currency, amount and rate on the control line and the old system's base amount; the open items
 * keep both amounts, age in base and settle in USD with the realised difference as fx_difference.
 * SS-PLAT-138: inconsistent FX input is refused and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agedReceivables } from '@ledgerforce/ar';
import { auServicesSmb } from '@ledgerforce/gl';
import {
  allocate,
  entrySeriesFor,
  post,
  SOURCE_TYPES,
  subledgerEntriesOf,
} from '@ledgerforce/ledger';
import { AU_SERVICES_BINDINGS, approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOpenItemsCsv, parseTrialBalanceCsv, type OpeningItemInput } from './opening-csv.ts';
import {
  openingBalanceOf,
  postOpeningBalance,
  previewOpeningBalance,
  type OpeningBalanceCommand,
} from './opening-balances.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp043 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-043',
);
const roleCode = new Map(
  auServicesSmb.accounts.filter((a) => a.systemRole).map((a) => [a.systemRole, a.code]),
);
const codeOf = (binding: string): string => {
  const b = AU_SERVICES_BINDINGS[binding];
  if (!b) throw new Error(`unbound ${binding}`);
  return 'code' in b ? b.code : (roleCode.get(b.role as never) ?? `role ${b.role}`);
};
const money = (s: string) => (s === '0' ? '0.0000' : `${s}${s.includes('.') ? '00' : '.0000'}`);

/** The old system's trial balance at 2026-10-31 (GP-043), by template account code. */
const TB_CSV = [
  'account_code,account_name,debit,credit',
  '1010,Operating account,10000.00,',
  '1200,Trade debtors,2913.46,',
  '2000,Trade creditors,,615.38',
  '2310,GST collected,,125.00',
  '3200,Retained earnings,,8000.00',
  '4110,Professional services,,4173.08',
].join('\n');
const HEAD =
  'party,document_no,document_date,due_date,amount,gst_amount,currency,currency_amount,fx_rate';
const AR_CSV = [
  HEAD,
  'Acme Pty Ltd,INV-0991,2026-09-15,2026-10-15,1375.00,125.00,,,',
  'Acme Pty Ltd,INV-2001,2026-09-20,2026-10-20,1538.46,0,USD,1000.00,1.53846154',
].join('\n');
const AP_CSV = [
  HEAD,
  'Supplier Pty Ltd,B-88,2026-10-05,2026-11-04,-615.38,,USD,-400.00,1.53846154',
].join('\n');

let f: LedgerFixture;
const parties = new Map<string, string>();

async function seedCompany(companyId: string): Promise<void> {
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: companyId, code, prefix: `X${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const [name, role] of [
      ['Acme', 'customer'],
      ['Supplier', 'supplier'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: companyId, party_id: p.id, role })
        .execute();
      parties.set(`${companyId}:${name}`, p.id);
    }
  });
}

const items = () => [...parseOpenItemsCsv(AR_CSV, 'ar'), ...parseOpenItemsCsv(AP_CSV, 'ap')];
const command = (over: Partial<OpeningBalanceCommand> = {}): OpeningBalanceCommand => ({
  companyId: f.companyId,
  conversionDate: '2026-11-01',
  trialBalance: parseTrialBalanceCsv(TB_CSV),
  items: items(),
  idempotencyKey: 'opening-fx-2026-11-01',
  ...over,
});
/** GP-043's items with the one at `index` changed. */
const withItem = (index: number, change: Partial<OpeningItemInput>) =>
  items().map((it, i) => (i === index ? { ...it, ...change } : it));

/** An item without one optional field (exactOptionalPropertyTypes forbids `undefined`). */
const without = (it: OpeningItemInput, key: 'fxRate' | 'currencyAmount'): OpeningItemInput => {
  const { [key]: _dropped, ...rest } = it;
  return rest;
};

const entryCount = () =>
  f.inTenant(
    async (trx) =>
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.journal_entry`.execute(trx))
        .rows[0]?.n,
  );

async function refused(fn: () => Promise<unknown>, code: string, message?: RegExp) {
  const before = await entryCount();
  const err = await fn().then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string },
  );
  expect(err?.code, err?.message).toBe(code);
  if (message) expect(err?.message).toMatch(message);
  expect(await entryCount()).toBe(before);
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012601');
  await seedCompany(f.companyId);
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0126: foreign-currency opening items are refused when inconsistent (SS-PLAT-138)', () => {
  const postIt = (c: OpeningBalanceCommand) => f.inTenant((trx) => postOpeningBalance(trx, c));

  it('SS-PLAT-138 a rate that does not reproduce the base amount half-up to cents', async () => {
    await refused(
      () => postIt(command({ items: withItem(1, { fxRate: '1.5' }) })),
      'FX_MISMATCH',
      /INV-2001.*1500\.00.*1538\.46/,
    );
    await refused(
      () => postIt(command({ items: withItem(1, { fxRate: '1.53845' }) })),
      'FX_MISMATCH',
    );
  });

  it('SS-PLAT-138 a currency amount of the other sign or zero, a bad code, a bad rate', async () => {
    await refused(
      () => postIt(command({ items: withItem(1, { currencyAmount: '-1000.00' }) })),
      'INVALID_COMMAND',
      /sign/,
    );
    await refused(
      () => postIt(command({ items: withItem(1, { currencyAmount: '0' }) })),
      'INVALID_COMMAND',
    );
    await refused(
      () => postIt(command({ items: withItem(1, { currency: 'usd1' }) })),
      'INVALID_COMMAND',
      /currency/,
    );
    await refused(
      () => postIt(command({ items: withItem(1, { fxRate: '0' }) })),
      'INVALID_COMMAND',
      /rate/,
    );
    await refused(
      () =>
        postIt(
          command({
            items: items().map((it, i) => (i === 1 ? without(it, 'currencyAmount') : it)),
          }),
        ),
      'INVALID_COMMAND',
      /currency amount/,
    );
  });

  it('SS-PLAT-138 a base-currency item with another currency amount or a rate other than 1', async () => {
    await refused(
      () => postIt(command({ items: withItem(0, { currency: 'AUD', currencyAmount: '1300.00' }) })),
      'INVALID_COMMAND',
      /AUD/,
    );
    await refused(
      () => postIt(command({ items: withItem(0, { currency: 'AUD', fxRate: '1.1' }) })),
      'INVALID_COMMAND',
      /rate 1/,
    );
  });

  it('SS-PLAT-138 without a rate the rate is implied from base ÷ currency amount (8 decimals); a base item named AUD stays base', async () => {
    const p = await f.inTenant((trx) =>
      previewOpeningBalance(
        trx,
        command({
          items: items().map((it, i) =>
            i === 0
              ? { ...it, currency: 'AUD', currencyAmount: '1375.00', fxRate: '1' }
              : without(it, 'fxRate'),
          ),
        }),
      ),
    );
    const usd = p.entry.lines.filter((l) => l.txnCurrency === 'USD');
    // 1538.46 / 1000 = 1.53846; 615.38 / 400 = 1.53845 (the engine prints rates without trailing zeros)
    expect(usd.map((l) => [l.txnAmount, l.fxRate])).toEqual([
      ['1000.0000', '1.53846'],
      ['400.0000', '1.53845'],
    ]);
    expect(p.entry.lines.find((l) => l.lineNo === 2)).toMatchObject({
      txnCurrency: 'AUD',
      fxRate: '1',
    });
  });
});

describe('T-0126: foreign-currency opening items (GP-043, SS-PLAT-137)', () => {
  it('SS-PLAT-137 posting writes exactly GP-043, the USD lines carrying currency, amount and rate', async () => {
    const r = await f.inTenant((trx) => postOpeningBalance(trx, command()));
    expect(r).toMatchObject({ balanceDate: '2026-10-31', replayed: false });
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{
            code: string;
            debit: string;
            credit: string;
            party_id: string | null;
            txn_currency: string;
            txn_amount: string;
            fx_rate: string;
          }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text, l.txn_currency,
                 l.txn_amount::text, l.fx_rate::text
            FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
           WHERE l.entry_id = ${r.entryId} ORDER BY l.line_no`.execute(trx)
        ).rows,
    );
    expect(rows).toHaveLength(gp043?.lines.length ?? -1);
    gp043?.lines.forEach((g, i) => {
      const at = `GP-043 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf(g.binding));
      expect(rows[i]?.debit, at).toBe(money(g.debit.replaceAll(',', '')));
      expect(rows[i]?.credit, at).toBe(money(g.credit.replaceAll(',', '')));
      expect(rows[i]?.party_id ?? null, at).toBe(
        g.party ? (parties.get(`${f.companyId}:${g.party}`) ?? '?') : null,
      );
    });
    expect(rows.map((l) => [l.txn_currency, l.txn_amount, l.fx_rate])).toEqual([
      ['AUD', '10000.0000', '1.00000000'],
      ['AUD', '1375.0000', '1.00000000'],
      ['USD', '1000.0000', '1.53846154'],
      ['USD', '400.0000', '1.53846154'],
      ['AUD', '125.0000', '1.00000000'],
      ['AUD', '8000.0000', '1.00000000'],
      ['AUD', '4173.0800', '1.00000000'],
    ]);

    const open = await f.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
    expect(
      open.map((i) => [i.lineNo, i.currency, i.originalAmount, i.baseOriginalAmount, i.dueDate]),
    ).toEqual([
      [2, 'AUD', '1375.0000', '1375.0000', '2026-10-15'],
      [3, 'USD', '1000.0000', '1538.4600', '2026-10-20'],
      [4, 'USD', '-400.0000', '-615.3800', '2026-11-04'],
    ]);
    expect(
      r.items.map((i) => [
        i.documentNo,
        i.lineNo,
        i.amount,
        i.gstAmount,
        i.currency,
        i.currencyAmount,
        i.fxRate,
      ]),
    ).toEqual([
      ['INV-0991', 2, '1375.0000', '125.0000', 'AUD', '1375.0000', '1.00000000'],
      ['INV-2001', 3, '1538.4600', '0.0000', 'USD', '1000.0000', '1.53846154'],
      ['B-88', 4, '-615.3800', '0.0000', 'USD', '-400.0000', '1.53846154'],
    ]);
    const view = await f.inTenant((trx) => openingBalanceOf(trx, f.companyId));
    expect(view?.items.map((i) => i.currency)).toEqual(['AUD', 'USD', 'USD']);
  });

  it('SS-PLAT-137 aged AR at the conversion date is in base and equals the AR control balance', async () => {
    const aged = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: '2026-11-01' }),
    );
    expect(aged.rows).toEqual([
      expect.objectContaining({
        partyId: parties.get(`${f.companyId}:Acme`),
        current: '0.0000',
        days1to30: '2913.4600',
        total: '2913.4600',
      }),
    ]);
    const ar = await f.inTenant(
      async (trx) =>
        (
          await sql<{ b: string }>`
          SELECT (sum(debit) - sum(credit))::text AS b FROM app.journal_line
           WHERE company_id = ${f.companyId} AND account_id = ${f.acct['1200'] ?? ''}`.execute(trx)
        ).rows[0]?.b,
    );
    expect(aged.totals.total).toBe(ar);
  });

  it('SS-PLAT-137 a USD receipt at a later rate settles the opening item in USD; fx_difference is the realised difference since conversion', async () => {
    const opening = await f.inTenant((trx) => openingBalanceOf(trx, f.companyId));
    const acme = parties.get(`${f.companyId}:Acme`) ?? '';
    const alloc = await f.inTenant(async (trx) => {
      const receipt = await post(trx, {
        companyId: f.companyId,
        idempotencyKey: 'rcpt-inv-2001',
        entryDate: '2026-11-20',
        sourceType: 'ar_receipt',
        lines: [
          { account: { id: f.acct['1010'] ?? '' }, debit: '1562.50' },
          {
            account: { role: 'AR_CONTROL' },
            credit: '1562.50',
            partyId: acme,
            txnCurrency: 'USD',
            txnAmount: '1000.00',
            fxRate: '1.5625',
          },
        ],
      });
      const [from] = await subledgerEntriesOf(trx, receipt.entryId);
      const to = (await subledgerEntriesOf(trx, opening?.entryId ?? '')).find(
        (i) => i.lineNo === 3,
      );
      return allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: 'alloc-inv-2001',
        fromEntryId: from?.id ?? '',
        toEntryId: to?.id ?? '',
        amount: '1000.00',
        allocationDate: '2026-11-20',
      });
    });
    expect(alloc).toMatchObject({ currency: 'USD', amount: '1000.0000', fxDifference: '24.0400' });
    const after = await f.inTenant(async (trx) =>
      (await subledgerEntriesOf(trx, opening?.entryId ?? '')).find((i) => i.lineNo === 3),
    );
    expect([after?.openAmount, after?.baseOpenAmount]).toEqual(['0.0000', '0.0000']);
  });
});
