/**
 * T-0080 opening balances at conversion (design §4.1 step 9, GP-037, RQ-0109, DL-0292), against
 * a real PostgreSQL as lf_app.
 *
 * SS-PLAT-115: the trial balance at the balance date plus the open AR/AP items post as one
 * journal equal to GP-037 line for line; every open document becomes its own open item (ageing
 * and allocation work on it) and keeps its original number, date and GST content.
 * SS-PLAT-116: every refusal writes nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agedReceivables } from '@ledgerforce/ar';
import { auServicesSmb } from '@ledgerforce/gl';
import {
  allocate,
  entrySeriesFor,
  findPeriod,
  post,
  reverse,
  setPeriodStatus,
  SOURCE_TYPES,
  subledgerEntriesOf,
} from '@ledgerforce/ledger';
import { AU_SERVICES_BINDINGS, approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOpenItemsCsv, parseTrialBalanceCsv } from './opening-csv.ts';
import {
  openingBalanceOf,
  postOpeningBalance,
  previewOpeningBalance,
  type OpeningBalanceCommand,
} from './opening-balances.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp037 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-037',
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

/** The old system's trial balance at 2026-10-31 (GP-037), by template account code. */
const TB_CSV = [
  'account_code,account_name,debit,credit',
  '1010,Operating account,12400.00,',
  '1200,Trade debtors,1925.00,',
  '1500,Office equipment,3000.00,',
  '1820,GST paid,120.00,',
  '6230,Office expenses,2515.00,',
  '2000,Trade creditors,,660.00',
  '2310,GST collected,,300.00',
  '3200,Retained earnings,,10000.00',
  '4110,Professional services,,9000.00',
].join('\n');
const AR_CSV = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Acme Pty Ltd,INV-0991,2026-09-15,2026-10-15,1375.00,125.00',
  'Acme Pty Ltd,INV-1004,2026-10-15,2026-11-14,550.00,50.00',
].join('\n');
const AP_CSV = [
  'party,document_no,document_date,due_date,amount,gst_amount',
  'Supplier Pty Ltd,B-77,2026-10-08,2026-11-07,-660.00,-60.00',
].join('\n');

let f: LedgerFixture;
const parties = new Map<string, string>(); // `${company}:${name}` → id

async function seedCompany(companyId: string): Promise<void> {
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: companyId, code, prefix: `O${String(i)}-` })
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

const command = (over: Partial<OpeningBalanceCommand> = {}): OpeningBalanceCommand => ({
  companyId: f.companyId,
  conversionDate: '2026-11-01',
  trialBalance: parseTrialBalanceCsv(TB_CSV),
  items: [...parseOpenItemsCsv(AR_CSV, 'ar'), ...parseOpenItemsCsv(AP_CSV, 'ap')],
  idempotencyKey: 'opening-2026-11-01',
  ...over,
});

const entryCount = () =>
  f.inTenant(
    async (trx) =>
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.journal_entry`.execute(trx))
        .rows[0]?.n,
  );

/** Expect `fn` to be refused with `code`, writing nothing. */
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
  f = await createLedgerFixture('01900000-0000-7000-8000-000000008001');
  await seedCompany(f.companyId);
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0080: opening balances at conversion (GP-037)', () => {
  it('SS-PLAT-115 preview shows the GP-037 journal dated the balance date and writes nothing', async () => {
    const before = await entryCount();
    const p = await f.inTenant((trx) => previewOpeningBalance(trx, command()));
    expect(p.balanceDate).toBe('2026-10-31');
    expect(p.entry.entryDate).toBe('2026-10-31');
    expect(p.entry.lines.map((l) => l.accountCode)).toEqual(
      gp037?.lines.map((g) => codeOf(g.binding)),
    );
    expect(p.entry.subledgerItems).toHaveLength(3);
    expect(await entryCount()).toBe(before);
  });

  it('SS-PLAT-115 posting writes exactly GP-037: one AR/AP line per open document with its party and due date', async () => {
    const r = await f.inTenant((trx) => postOpeningBalance(trx, command()));
    expect(r).toMatchObject({ balanceDate: '2026-10-31', replayed: false });
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${r.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    expect(rows).toHaveLength(gp037?.lines.length ?? -1);
    gp037?.lines.forEach((g, i) => {
      const at = `GP-037 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf(g.binding));
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(
        g.party ? (parties.get(`${f.companyId}:${g.party}`) ?? '?') : null,
      );
    });
    const entry = await f.inTenant(
      async (trx) =>
        (
          await sql<{ source_type: string; entry_date: string }>`
          SELECT source_type, entry_date::text FROM app.journal_entry WHERE id = ${r.entryId}`.execute(
            trx,
          )
        ).rows[0],
    );
    expect(entry).toEqual({ source_type: 'ledger_opening_balance', entry_date: '2026-10-31' });

    const items = await f.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
    expect(items.map((i) => [i.controlRole, i.lineNo, i.dueDate, i.openAmount, i.partyId])).toEqual(
      [
        ['AR_CONTROL', 2, '2026-10-15', '1375.0000', parties.get(`${f.companyId}:Acme`)],
        ['AR_CONTROL', 3, '2026-11-14', '550.0000', parties.get(`${f.companyId}:Acme`)],
        ['AP_CONTROL', 7, '2026-11-07', '-660.0000', parties.get(`${f.companyId}:Supplier`)],
      ],
    );
    expect(
      r.items.map((i) => [i.kind, i.documentNo, i.documentDate, i.lineNo, i.amount, i.gstAmount]),
    ).toEqual([
      ['ar', 'INV-0991', '2026-09-15', 2, '1375.0000', '125.0000'],
      ['ar', 'INV-1004', '2026-10-15', 3, '550.0000', '50.0000'],
      ['ap', 'B-77', '2026-10-08', 7, '-660.0000', '-60.0000'],
    ]);
    const view = await f.inTenant((trx) => openingBalanceOf(trx, f.companyId));
    expect(view).toMatchObject({
      id: r.openingBalanceId,
      entryId: r.entryId,
      conversionDate: '2026-11-01',
      balanceDate: '2026-10-31',
    });
    expect(view?.items).toHaveLength(3);
  });

  it('SS-PLAT-115 a repeat with the same key returns the first result and writes nothing', async () => {
    const first = await f.inTenant((trx) => openingBalanceOf(trx, f.companyId));
    const before = await entryCount();
    const again = await f.inTenant((trx) => postOpeningBalance(trx, command()));
    expect(again).toMatchObject({ replayed: true, entryId: first?.entryId });
    expect(again.items).toHaveLength(3);
    expect(await entryCount()).toBe(before);
  });

  it('SS-PLAT-115 aged AR at the conversion date ages the opening items by due date and equals the AR control balance', async () => {
    const aged = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: '2026-11-01' }),
    );
    expect(aged.rows).toEqual([
      expect.objectContaining({
        partyId: parties.get(`${f.companyId}:Acme`),
        current: '550.0000',
        days1to30: '1375.0000',
        total: '1925.0000',
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

  it('SS-PLAT-115 a receipt after conversion allocates to an opening item, which then cannot be reversed', async () => {
    const opening = await f.inTenant((trx) => openingBalanceOf(trx, f.companyId));
    const acme = parties.get(`${f.companyId}:Acme`) ?? '';
    await f.inTenant(async (trx) => {
      const receipt = await post(trx, {
        companyId: f.companyId,
        idempotencyKey: 'rcpt-inv-1004',
        entryDate: '2026-11-10',
        sourceType: 'ar_receipt',
        lines: [
          { account: { id: f.acct['1010'] ?? '' }, debit: '550.00' },
          { account: { role: 'AR_CONTROL' }, credit: '550.00', partyId: acme },
        ],
      });
      const [from] = await subledgerEntriesOf(trx, receipt.entryId);
      const to = (await subledgerEntriesOf(trx, opening?.entryId ?? '')).find(
        (i) => i.lineNo === 3,
      );
      await allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: 'alloc-inv-1004',
        fromEntryId: from?.id ?? '',
        toEntryId: to?.id ?? '',
        amount: '550.00',
        allocationDate: '2026-11-10',
      });
      const after = (await subledgerEntriesOf(trx, opening?.entryId ?? '')).find(
        (i) => i.lineNo === 3,
      );
      expect(after?.openAmount).toBe('0.0000');
    });
    await refused(
      () =>
        f.inTenant((trx) =>
          reverse(trx, {
            companyId: f.companyId,
            entryId: opening?.entryId ?? '',
            idempotencyKey: 'reverse-opening',
            entryDate: '2026-11-15',
          }),
        ),
      'ALLOCATED',
    );
  });
});

describe('T-0080: opening-balance refusals write nothing (SS-PLAT-116)', () => {
  let fresh = '';
  beforeAll(async () => {
    fresh = await f.addCompany('Fresh Co');
    await seedCompany(fresh);
  });
  /** GP-037's items naming the parties of `co` by id (a duplicate name added below stays harmless). */
  const itemsFor = (co: string) => [
    ...parseOpenItemsCsv(AR_CSV.replaceAll('Acme Pty Ltd', parties.get(`${co}:Acme`) ?? ''), 'ar'),
    ...parseOpenItemsCsv(
      AP_CSV.replaceAll('Supplier Pty Ltd', parties.get(`${co}:Supplier`) ?? ''),
      'ap',
    ),
  ];
  let n = 0;
  const on = (over: Partial<OpeningBalanceCommand> = {}) => {
    const co = over.companyId ?? fresh;
    n += 1;
    return command({
      companyId: co,
      idempotencyKey: `fresh-${String(n)}`,
      trialBalance: parseTrialBalanceCsv(TB_CSV),
      items: itemsFor(co),
      ...over,
    });
  };
  const postOn = (c: OpeningBalanceCommand) => f.inTenant((trx) => postOpeningBalance(trx, c));

  it('a second live opening balance for the same company', async () => {
    await refused(() => postOn(command({ idempotencyKey: 'another-key' })), 'OPENING_EXISTS');
  });

  it('an unbalanced trial balance (no plug account)', async () => {
    const tb = parseTrialBalanceCsv(
      TB_CSV.replace('1010,Operating account,12400.00,', '1010,x,12400.01,'),
    );
    await refused(() => postOn(on({ trialBalance: tb })), 'UNBALANCED', /0\.01/);
  });

  it('open items that do not add up to the AR or AP amount in the trial balance', async () => {
    await refused(
      () =>
        postOn(
          on({
            items: [
              ...parseOpenItemsCsv(AR_CSV, 'ar').slice(0, 1),
              ...parseOpenItemsCsv(AP_CSV, 'ap'),
            ],
          }),
        ),
      'CONTROL_MISMATCH',
      /AR_CONTROL.*550\.00/,
    );
    await refused(
      () => postOn(on({ items: parseOpenItemsCsv(AR_CSV, 'ar') })),
      'CONTROL_MISMATCH',
      /AP_CONTROL.*660\.00/,
    );
  });

  it('an unknown or repeated account code, and current year earnings', async () => {
    await refused(
      () =>
        postOn(on({ trialBalance: parseTrialBalanceCsv(`${TB_CSV}\n9999,x,1.00,\n9998,y,,1.00`) })),
      'UNKNOWN_ACCOUNT',
      /9999/,
    );
    await refused(
      () =>
        postOn(on({ trialBalance: parseTrialBalanceCsv(`${TB_CSV}\n1020,x,1.00,\n1020,y,,1.00`) })),
      'DUPLICATE_ACCOUNT',
      /1020/,
    );
    await refused(
      () =>
        postOn(on({ trialBalance: parseTrialBalanceCsv(`${TB_CSV}\n3300,x,1.00,\n1020,y,,1.00`) })),
      'ACCOUNT_NOT_POSTABLE',
    );
  });

  it('an unknown or ambiguous party, or one without the customer / supplier role', async () => {
    const ar = (party: string) => parseOpenItemsCsv(AR_CSV.replaceAll('Acme Pty Ltd', party), 'ar');
    const ap = parseOpenItemsCsv(AP_CSV, 'ap');
    await refused(
      () => postOn(on({ items: [...ar('Nobody Pty Ltd'), ...ap] })),
      'UNKNOWN_PARTY',
      /row 2/,
    );
    await refused(() => postOn(on({ items: [...ar('Supplier Pty Ltd'), ...ap] })), 'PARTY_ROLE');
    await f.inTenant((trx) =>
      trx
        .insertInto('app.party')
        .values({ company_id: fresh, legal_name: 'ACME PTY LTD', status: 'active' })
        .execute(),
    );
    await refused(() => postOn(on({ items: [...ar('acme pty ltd'), ...ap] })), 'AMBIGUOUS_PARTY');
    // The party id still identifies it exactly.
    const byId = await f.inTenant((trx) =>
      previewOpeningBalance(trx, on({ items: [...ar(parties.get(`${fresh}:Acme`) ?? ''), ...ap] })),
    );
    expect(byId.entry.subledgerItems).toHaveLength(3);
  });

  it('an item dated after the balance date', async () => {
    const ar = parseOpenItemsCsv(
      AR_CSV.replace('2026-10-15,2026-11-14', '2026-11-01,2026-11-14'),
      'ar',
    );
    await refused(
      () => postOn(on({ items: [...ar, ...parseOpenItemsCsv(AP_CSV, 'ap')] })),
      'ITEM_AFTER_BALANCE_DATE',
      /row 3/,
    );
  });

  it('a balance date with no fiscal period or in a period that is not open', async () => {
    await refused(
      () =>
        postOn(
          on({
            conversionDate: '2026-07-01',
            items: [],
            trialBalance: parseTrialBalanceCsv('account_code,debit,credit\n1010,1.00,\n3200,,1.00'),
          }),
        ),
      'PERIOD_NOT_OPEN',
      /2026-06-30/,
    );
    const lockCo = await f.addCompany('Locked Co');
    await seedCompany(lockCo);
    const admin = await f.addUser('finance_admin');
    await f.inTenant(async (trx) => {
      const p = await findPeriod(trx, lockCo, '2026-10-31');
      await setPeriodStatus(trx, { periodId: p?.id ?? '', status: 'ar_locked', actorId: admin });
    });
    await refused(() => postOn(on({ companyId: lockCo })), 'PERIOD_NOT_OPEN', /ar_locked/);
  });

  it('posted entries on or before the balance date; after reversing its opening entry a company can post a new one', async () => {
    const co = await f.addCompany('Prior Co');
    await seedCompany(co);
    await f.inTenant((trx) =>
      post(trx, {
        companyId: co,
        idempotencyKey: 'old-journal',
        entryDate: '2026-10-20',
        sourceType: 'manual_journal',
        lines: [
          { account: { id: f.chart(co).acct['1010'] ?? '' }, debit: '1.00' },
          { account: { id: f.chart(co).acct['3200'] ?? '' }, credit: '1.00' },
        ],
      }),
    );
    await refused(() => postOn(on({ companyId: co })), 'PRIOR_ENTRIES', /1 posted entry/);

    const first = await postOn(on({ idempotencyKey: 'fresh-first' }));
    await f.inTenant((trx) =>
      reverse(trx, {
        companyId: fresh,
        entryId: first.entryId,
        idempotencyKey: 'fresh-reverse',
        entryDate: '2026-10-31',
      }),
    );
    expect(await f.inTenant((trx) => openingBalanceOf(trx, fresh))).toBeNull();
    const second = await postOn(on({ idempotencyKey: 'fresh-second' }));
    expect(second.replayed).toBe(false);
    expect((await f.inTenant((trx) => openingBalanceOf(trx, fresh)))?.entryId).toBe(second.entryId);
  });

  it('the database refuses an opening-balance record that points at any other entry', async () => {
    const other = await f.inTenant((trx) =>
      post(trx, {
        companyId: fresh,
        idempotencyKey: 'not-opening',
        entryDate: '2026-11-05',
        sourceType: 'manual_journal',
        lines: [
          { account: { id: f.chart(fresh).acct['1010'] ?? '' }, debit: '1.00' },
          { account: { id: f.chart(fresh).acct['3200'] ?? '' }, credit: '1.00' },
        ],
      }),
    );
    await expect(
      f.inTenant((trx) =>
        trx
          .insertInto('app.opening_balance')
          .values({
            company_id: fresh,
            conversion_date: '2026-11-06',
            balance_date: '2026-11-05',
            entry_id: other.entryId,
            idempotency_key: 'forged',
          })
          .execute(),
      ),
    ).rejects.toThrow(/opening balance/);
  });
});
