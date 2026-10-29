/**
 * AR/AP open items and allocations (T-0028, design §3.3, RQ-0039, ADR-0035), against a real
 * PostgreSQL as lf_app.
 *
 * SS-PLAT-81 — the posting engine writes one open item (subledger_entry) for every line on an
 *   AR_CONTROL or AP_CONTROL account, in its write savepoint, signed like the GL (debit +,
 *   credit −), in transaction and base currency, filled by the database from the line. Preview
 *   returns the same items and writes nothing. The AR and AP subledgers equal their control
 *   accounts (subledgerReconciliation), today and as at a past date.
 * SS-PLAT-82 — allocations: an allocation pairs a debit item with a credit item of the same
 *   control account, party and currency and moves both towards zero; it never over-allocates,
 *   even with two concurrent writers; it is append-only and undone only by a reversing
 *   allocation; fx_difference is recorded as data and no FX journal is posted (golden posting
 *   Draft, DL-0187).
 *
 * Commands are raw journals written by the test (no event posting rule: every golden posting is
 * still Draft). Source types such as ar_invoice only label the subledger.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostingError, type PostingCommand, type PostingLineInput } from './posting-command.ts';
import { post, preview } from './posting-engine.ts';
import {
  AllocationError,
  allocate,
  openItem,
  reverseAllocation,
  subledgerDrift,
  subledgerEntriesOf,
  subledgerReconciliation,
  type AllocationCommand,
  type OpenItem,
} from './subledger.ts';
import {
  createLedgerFixture,
  databaseFingerprint,
  type LedgerFixture,
} from './testing/journal-fixture.ts';

let f: LedgerFixture;
const party: Record<string, string> = {};
const SERIES = [
  'manual_journal',
  'ar_invoice',
  'ar_receipt',
  'ar_credit_note',
  'ap_bill',
  'ap_payment',
];

const fp = () => databaseFingerprint(f.admin);
const inT = <R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R> => f.inTenant(fn);

const cmd = (
  lines: PostingLineInput[],
  over: Partial<PostingCommand> & { sourceType: string },
): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-10',
  lines,
  ...over,
});

const AR = { role: 'AR_CONTROL' } as const;
const AP = { role: 'AP_CONTROL' } as const;
const SUSPENSE = { role: 'SUSPENSE' } as const;

/** AR invoice: Dr AR control (party), Cr suspense. Optional USD amount and due date. */
const invoice = (
  base: string,
  p: string,
  o: { usd?: string; date?: string; due?: string; company?: string } = {},
) =>
  cmd(
    [
      {
        account: AR,
        debit: base,
        partyId: p,
        ...(o.usd ? { txnCurrency: 'USD', txnAmount: o.usd, fxRate: '1.5' } : {}),
        ...(o.due ? { dueDate: o.due } : {}),
      },
      { account: SUSPENSE, credit: base },
    ],
    {
      sourceType: 'ar_invoice',
      sourceId: `INV-${randomUUID().slice(0, 8)}`,
      ...(o.date ? { entryDate: o.date } : {}),
      ...(o.company ? { companyId: o.company } : {}),
    },
  );
/** AR receipt: Dr suspense, Cr AR control (party). */
const receipt = (base: string, p: string, o: { usd?: string; date?: string } = {}) =>
  cmd(
    [
      { account: SUSPENSE, debit: base },
      {
        account: AR,
        credit: base,
        partyId: p,
        ...(o.usd ? { txnCurrency: 'USD', txnAmount: o.usd, fxRate: '1.6' } : {}),
      },
    ],
    {
      sourceType: 'ar_receipt',
      sourceId: `RCT-${randomUUID().slice(0, 8)}`,
      ...(o.date ? { entryDate: o.date } : {}),
    },
  );
/** AP bill: Dr suspense, Cr AP control (party). */
const bill = (base: string, p: string) =>
  cmd(
    [
      { account: SUSPENSE, debit: base },
      { account: AP, credit: base, partyId: p },
    ],
    { sourceType: 'ap_bill', sourceId: `BILL-${randomUUID().slice(0, 8)}` },
  );
/** AP payment: Dr AP control (party), Cr suspense. */
const payment = (base: string, p: string) =>
  cmd(
    [
      { account: AP, debit: base, partyId: p },
      { account: SUSPENSE, credit: base },
    ],
    { sourceType: 'ap_payment', sourceId: `PAY-${randomUUID().slice(0, 8)}` },
  );

/** Post a command and return its one open item. */
async function postItem(command: PostingCommand): Promise<OpenItem> {
  return inT(async (trx) => {
    const r = await post(trx, command);
    const items = await subledgerEntriesOf(trx, r.entryId);
    expect(items).toHaveLength(1);
    return items[0] as OpenItem;
  });
}

const alloc = (
  from: string,
  to: string,
  amount: string,
  over: Partial<AllocationCommand> = {},
): AllocationCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  fromEntryId: from,
  toEntryId: to,
  amount,
  allocationDate: '2026-10-20',
  ...over,
});

const item = (id: string) => inT((trx) => openItem(trx, id));
const refusedWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e, `expected ${code}`).toBeInstanceOf(AllocationError);
  expect((e as AllocationError).code).toBe(code);
  return e as AllocationError;
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002801');
  await f.inTenant(async (trx) => {
    for (const company of [f.companyId, f.otherCompanyId]) {
      for (const st of SERIES) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code: `je_${st}`, prefix: `${st.toUpperCase()}-` })
          .execute();
      }
    }
    for (const [name, company] of [
      ['acme', f.companyId],
      ['bolt', f.companyId],
      ['supplier', f.companyId],
      ['elsewhere', f.otherCompanyId],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: company, legal_name: `${name} Pty Ltd` })
        .returning('id')
        .executeTakeFirstOrThrow();
      party[name] = p.id;
    }
  });
}, 120_000);

afterAll(async () => {
  await f.close();
});

const P = (name: string) => party[name] ?? `missing ${name}`;

describe('SS-PLAT-81 open items are written by the posting engine [T-0028]', () => {
  it('SS-PLAT-81: an AR invoice and an AP bill each create one open item, signed like the GL and filled from the line', async () => {
    const inv = invoice('110.0000', P('acme'), { due: '2026-11-09' });
    const i = await postItem(inv);
    expect(i).toMatchObject({
      controlRole: 'AR_CONTROL',
      accountId: f.acct['1200'],
      partyId: P('acme'),
      sourceType: 'ar_invoice',
      documentId: inv.sourceId,
      documentDate: '2026-10-10',
      dueDate: '2026-11-09',
      currency: 'AUD',
      originalAmount: '110.0000',
      openAmount: '110.0000',
      baseOriginalAmount: '110.0000',
      baseOpenAmount: '110.0000',
      lineNo: 1,
    });
    const b = await postItem(bill('55.5000', P('supplier')));
    expect(b).toMatchObject({
      controlRole: 'AP_CONTROL',
      accountId: f.acct['2000'],
      partyId: P('supplier'),
      originalAmount: '-55.5000',
      openAmount: '-55.5000',
      baseOriginalAmount: '-55.5000',
      baseOpenAmount: '-55.5000',
      lineNo: 2,
      // no due date given: the document date
      dueDate: '2026-10-10',
    });
  });

  it('SS-PLAT-81: a foreign-currency item keeps the transaction amount and the base amount; non-control lines create none', async () => {
    const usd = await postItem(invoice('150.0000', P('acme'), { usd: '100.0000' }));
    expect(usd).toMatchObject({
      currency: 'USD',
      originalAmount: '100.0000',
      openAmount: '100.0000',
      baseOriginalAmount: '150.0000',
      baseOpenAmount: '150.0000',
    });
    const none = await inT(async (trx) => {
      const r = await post(
        trx,
        cmd(
          [
            { account: { id: f.acct['6110'] ?? '' }, debit: '9.0000' },
            { account: SUSPENSE, credit: '9.0000' },
          ],
          { sourceType: 'manual_journal' },
        ),
      );
      return subledgerEntriesOf(trx, r.entryId);
    });
    expect(none).toEqual([]);
  });

  it('SS-PLAT-81: preview returns the open items post would write and writes nothing; post stores exactly those', async () => {
    const command = invoice('42.0000', P('bolt'), { due: '2026-12-01' });
    const before = await fp();
    const built = await inT((trx) => preview(trx, command));
    expect(await fp()).toEqual(before);
    expect(built.subledgerItems).toEqual([
      {
        lineNo: 1,
        controlRole: 'AR_CONTROL',
        accountId: f.acct['1200'],
        partyId: P('bolt'),
        currency: 'AUD',
        originalAmount: '42.0000',
        baseOriginalAmount: '42.0000',
        documentDate: '2026-10-10',
        dueDate: '2026-12-01',
      },
    ]);
    const stored = await inT(async (trx) => {
      const r = await post(trx, command);
      return subledgerEntriesOf(trx, r.entryId);
    });
    expect(
      stored.map((s) => ({
        lineNo: s.lineNo,
        controlRole: s.controlRole,
        accountId: s.accountId,
        partyId: s.partyId,
        currency: s.currency,
        originalAmount: s.originalAmount,
        baseOriginalAmount: s.baseOriginalAmount,
        documentDate: s.documentDate,
        dueDate: s.dueDate,
      })),
    ).toEqual(built.subledgerItems);
    expect((await fp()).tables['app.subledger_entry']).not.toEqual(
      before.tables['app.subledger_entry'],
    );
  });

  it('SS-PLAT-81: a due date on a non-subledger line, a bad due date and a zero transaction amount on a control line are refused by preview and post alike', async () => {
    const cases: [string, PostingCommand][] = [
      [
        'INVALID_COMMAND',
        cmd(
          [
            { account: SUSPENSE, debit: '1.0000', dueDate: '2026-11-01' },
            { account: AR, credit: '1.0000', partyId: P('acme') },
          ],
          { sourceType: 'ar_receipt' },
        ),
      ],
      [
        'INVALID_COMMAND',
        cmd(
          [
            { account: AR, debit: '1.0000', partyId: P('acme'), dueDate: '2026-02-30' },
            { account: SUSPENSE, credit: '1.0000' },
          ],
          { sourceType: 'ar_invoice' },
        ),
      ],
      [
        'INVALID_COMMAND',
        cmd(
          [
            {
              account: AR,
              debit: '1.0000',
              partyId: P('acme'),
              txnCurrency: 'USD',
              txnAmount: '0',
              fxRate: '1.5',
            },
            { account: SUSPENSE, credit: '1.0000' },
          ],
          { sourceType: 'ar_invoice' },
        ),
      ],
    ];
    for (const [code, command] of cases) {
      const before = await fp();
      for (const run of [preview, post]) {
        const e = await inT<unknown>((trx) => run(trx, command)).then(
          () => undefined,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(PostingError);
        expect((e as PostingError).code).toBe(code);
      }
      expect(await fp()).toEqual(before);
    }
  });

  it('SS-PLAT-81: lf_app cannot change or delete an open item; the owner can change only open amounts, and only from an allocation; an item is always filled from its line', async () => {
    const i = await postItem(invoice('10.0000', P('acme')));
    for (const stmt of [
      sql`UPDATE app.subledger_entry SET open_amount = 0 WHERE id = ${i.id}`,
      sql`DELETE FROM app.subledger_entry WHERE id = ${i.id}`,
      sql`TRUNCATE app.subledger_entry`,
    ]) {
      const e = await inT((trx) => stmt.execute(trx)).then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
      expect(e?.code).toBe('42501');
    }
    const owner = createDb(f.tdb.url('lf_migrator'), 1);
    try {
      for (const stmt of [
        sql`UPDATE app.subledger_entry SET open_amount = 0, base_open_amount = 0 WHERE id = ${i.id}`,
        sql`UPDATE app.subledger_entry SET due_date = '2027-01-01' WHERE id = ${i.id}`,
        sql`DELETE FROM app.subledger_entry WHERE id = ${i.id}`,
      ]) {
        const e = await withTenant(owner, f.tenantId, (trx) => stmt.execute(trx)).then(
          () => undefined,
          (x: unknown) => x as { code?: string; message?: string },
        );
        expect(e?.code, String(e?.message)).toBe('23514');
      }
    } finally {
      await owner.destroy();
    }
    expect(await item(i.id)).toEqual(i);

    // A second item for the same line is refused; an item for a non-control line is refused;
    // whatever amounts the inserter claims, the database fills them from the line.
    const suspenseLine = await inT(async (trx) => {
      const r = await post(trx, invoice('3.0000', P('acme')));
      return r.entryId;
    });
    const dup = await inT((trx) =>
      trx
        .insertInto('app.subledger_entry')
        .values({ company_id: f.companyId, entry_id: suspenseLine, line_no: 1 })
        .execute(),
    ).then(
      () => undefined,
      (x: unknown) => x as { code?: string },
    );
    expect(dup?.code).toBe('23505');
    const notControl = await inT((trx) =>
      trx
        .insertInto('app.subledger_entry')
        .values({ company_id: f.companyId, entry_id: suspenseLine, line_no: 2 })
        .execute(),
    ).then(
      () => undefined,
      (x: unknown) => x as { code?: string; message?: string },
    );
    expect(notControl?.code).toBe('23514');
    expect(notControl?.message).toMatch(/AR_CONTROL or AP_CONTROL/);
  });

  it('SS-PLAT-81: the AR and AP subledgers equal their control accounts, now and as at a past date; drift is empty', async () => {
    const company = await f.addCompany('Reconcile Pty Ltd');
    const c = (x: PostingCommand): PostingCommand => ({ ...x, companyId: company });
    const p = await inT(async (trx) => {
      for (const st of SERIES) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code: `je_${st}`, prefix: `X-${st}-` })
          .execute();
      }
      const row = await trx
        .insertInto('app.party')
        .values({ company_id: company, legal_name: 'Recon customer' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    await inT(async (trx) => {
      await post(trx, c(invoice('100.0000', p, { date: '2026-09-15' })));
      await post(trx, c(invoice('40.0000', p, { date: '2026-10-05' })));
      await post(trx, c(receipt('25.0000', p, { date: '2026-10-06' })));
      await post(trx, c(bill('70.0000', p)));
      await post(trx, c(payment('20.0000', p)));
    });
    const now = await inT((trx) => subledgerReconciliation(trx, { companyId: company }));
    expect(now).toEqual([
      {
        controlRole: 'AR_CONTROL',
        accountIds: [f.chart(company).acct['1200']],
        controlBalance: '115.0000',
        subledgerBalance: '115.0000',
        unpostedFxDifference: '0.0000',
        difference: '0.0000',
        reconciled: true,
      },
      {
        controlRole: 'AP_CONTROL',
        accountIds: [f.chart(company).acct['2000']],
        controlBalance: '-50.0000',
        subledgerBalance: '-50.0000',
        unpostedFxDifference: '0.0000',
        difference: '0.0000',
        reconciled: true,
      },
    ]);
    const past = await inT((trx) =>
      subledgerReconciliation(trx, { companyId: company, asOf: '2026-09-30' }),
    );
    expect(past[0]).toMatchObject({
      controlBalance: '100.0000',
      subledgerBalance: '100.0000',
      reconciled: true,
    });
    expect(past[1]).toMatchObject({ controlBalance: '0.0000', subledgerBalance: '0.0000' });
    expect(await inT((trx) => subledgerDrift(trx, company))).toEqual([]);

    // A control-account line written outside the engine has no open item: drift and a difference.
    const outside = await inT((trx) =>
      f.insertEntry(
        trx,
        [
          { code: '1200', debit: '5.0000' },
          { code: '2310', credit: '5.0000' },
        ],
        { company, sourceType: 'ar_invoice', entryDate: '2026-10-07' },
      ),
    );
    const after = await inT((trx) => subledgerReconciliation(trx, { companyId: company }));
    expect(after[0]).toMatchObject({
      controlBalance: '120.0000',
      subledgerBalance: '115.0000',
      difference: '-5.0000',
      reconciled: false,
    });
    expect(await inT((trx) => subledgerDrift(trx, company))).toEqual([
      expect.objectContaining({ kind: 'line_without_item', entryId: outside, lineNo: 1 }),
    ]);
  });
});

describe('SS-PLAT-82 allocations [T-0028]', () => {
  it('SS-PLAT-82: a partial and a full allocation move both items towards zero and post no journal', async () => {
    const inv = await postItem(invoice('100.0000', P('acme')));
    const r1 = await postItem(receipt('60.0000', P('acme')));
    const r2 = await postItem(receipt('40.0000', P('acme')));
    const entries = await f.countEntries();
    const a = await inT((trx) => allocate(trx, alloc(r1.id, inv.id, '60.0000')));
    expect(a).toMatchObject({
      fromEntryId: r1.id,
      toEntryId: inv.id,
      amount: '60.0000',
      currency: 'AUD',
      fromBaseAmount: '60.0000',
      toBaseAmount: '60.0000',
      fxDifference: '0.0000',
      allocationDate: '2026-10-20',
      reversalOfId: null,
      replayed: false,
    });
    expect((await item(inv.id)).openAmount).toBe('40.0000');
    expect((await item(r1.id)).openAmount).toBe('0.0000');
    // from/to order does not matter: the invoice may be "from"
    await inT((trx) => allocate(trx, alloc(inv.id, r2.id, '40.0000')));
    expect(await item(inv.id)).toMatchObject({ openAmount: '0.0000', baseOpenAmount: '0.0000' });
    expect(await item(r2.id)).toMatchObject({ openAmount: '0.0000', baseOpenAmount: '0.0000' });
    expect(await f.countEntries()).toBe(entries);
    // AP: a payment against a bill
    const b = await postItem(bill('30.0000', P('supplier')));
    const pay = await postItem(payment('12.5000', P('supplier')));
    await inT((trx) => allocate(trx, alloc(pay.id, b.id, '12.5000')));
    expect((await item(b.id)).openAmount).toBe('-17.5000');
    expect((await item(pay.id)).openAmount).toBe('0.0000');
  });

  it('SS-PLAT-82: over-allocation, same side, other party, other currency, other control account, same item, unknown item, early date and bad amounts are refused and write nothing', async () => {
    const inv = await postItem(invoice('50.0000', P('acme')));
    const inv2 = await postItem(invoice('5.0000', P('acme')));
    const rct = await postItem(receipt('80.0000', P('acme')));
    const otherParty = await postItem(receipt('10.0000', P('bolt')));
    const usd = await postItem(receipt('16.0000', P('acme'), { usd: '10.0000' }));
    const apItem = await postItem(payment('10.0000', P('acme')));
    const early = await postItem(receipt('1.0000', P('acme'), { date: '2026-10-25' }));
    const otherCompany = await postItem(
      invoice('9.0000', P('elsewhere'), { company: f.otherCompanyId }),
    );
    const before = await fp();
    const go = (c: AllocationCommand) => inT((trx) => allocate(trx, c));
    await refusedWith(go(alloc(rct.id, inv.id, '50.0001')), 'OVER_ALLOCATION');
    await refusedWith(go(alloc(inv2.id, inv.id, '1.0000')), 'SAME_SIDE');
    await refusedWith(go(alloc(otherParty.id, inv.id, '1.0000')), 'PARTY_MISMATCH');
    await refusedWith(go(alloc(usd.id, inv.id, '1.0000')), 'CURRENCY_MISMATCH');
    await refusedWith(go(alloc(apItem.id, inv.id, '1.0000')), 'ACCOUNT_MISMATCH');
    await refusedWith(go(alloc(inv.id, inv.id, '1.0000')), 'SAME_ITEM');
    await refusedWith(go(alloc(randomUUID(), inv.id, '1.0000')), 'UNKNOWN_OPEN_ITEM');
    await refusedWith(go(alloc(otherCompany.id, inv.id, '1.0000')), 'UNKNOWN_OPEN_ITEM');
    await refusedWith(
      go(alloc(early.id, inv.id, '1.0000', { allocationDate: '2026-10-24' })),
      'DATE_BEFORE_DOCUMENT',
    );
    for (const bad of ['0', '0.0000', '-1', '1.00001', 'abc', '1e3']) {
      await refusedWith(go(alloc(rct.id, inv.id, bad)), 'INVALID_AMOUNT');
    }
    await refusedWith(
      go(alloc(rct.id, inv.id, '1', { allocationDate: '2026-13-01' })),
      'INVALID_COMMAND',
    );
    await refusedWith(go(alloc(rct.id, inv.id, '1', { idempotencyKey: '' })), 'INVALID_COMMAND');
    await refusedWith(go(alloc(rct.id, inv.id, '1', { createdBy: randomUUID() })), 'UNKNOWN_USER');
    expect(await fp()).toEqual(before);
    // the caller's transaction stays usable after a refusal
    await inT(async (trx) => {
      await allocate(trx, alloc(rct.id, inv.id, '50.0001')).catch(() => undefined);
      await allocate(trx, alloc(rct.id, inv.id, '50.0000'));
    });
    expect((await item(inv.id)).openAmount).toBe('0.0000');
    expect((await item(rct.id)).openAmount).toBe('-30.0000');
  });

  it('SS-PLAT-82: a reversing allocation restores both items exactly; an allocation is reversed once, a reversal never; allocations are append-only', async () => {
    const inv = await postItem(invoice('30.0000', P('acme'), { usd: '20.0000' }));
    const rct = await postItem(receipt('33.0000', P('acme'), { usd: '20.0000' }));
    const before = [await item(inv.id), await item(rct.id)];
    const a = await inT((trx) => allocate(trx, alloc(rct.id, inv.id, '7.0000')));
    expect(a.fxDifference).not.toBe('0.0000');
    const key = randomUUID();
    const rev = await inT((trx) =>
      reverseAllocation(trx, {
        companyId: f.companyId,
        idempotencyKey: key,
        allocationId: a.allocationId,
        allocationDate: '2026-10-21',
      }),
    );
    expect(rev).toMatchObject({
      reversalOfId: a.allocationId,
      amount: '-7.0000',
      fromBaseAmount: `-${a.fromBaseAmount}`,
      toBaseAmount: `-${a.toBaseAmount}`,
      fxDifference: a.fxDifference.startsWith('-') ? a.fxDifference.slice(1) : `-${a.fxDifference}`,
    });
    expect([await item(inv.id), await item(rct.id)]).toEqual(before);
    // replay of the same reversal key
    const again = await inT((trx) =>
      reverseAllocation(trx, {
        companyId: f.companyId,
        idempotencyKey: key,
        allocationId: a.allocationId,
        allocationDate: '2026-10-21',
      }),
    );
    expect(again).toMatchObject({ allocationId: rev.allocationId, replayed: true });
    const reverse = (id: string, date = '2026-10-22') =>
      inT((trx) =>
        reverseAllocation(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          allocationId: id,
          allocationDate: date,
        }),
      );
    await refusedWith(reverse(a.allocationId), 'ALREADY_REVERSED');
    await refusedWith(reverse(rev.allocationId), 'REVERSAL_OF_REVERSAL');
    await refusedWith(reverse(randomUUID()), 'UNKNOWN_ALLOCATION');
    const b = await inT((trx) => allocate(trx, alloc(rct.id, inv.id, '1.0000')));
    await refusedWith(reverse(b.allocationId, '2026-10-19'), 'DATE_BEFORE_ALLOCATION');

    for (const stmt of [
      sql`UPDATE app.allocation SET amount = 2 WHERE id = ${a.allocationId}`,
      sql`DELETE FROM app.allocation WHERE id = ${a.allocationId}`,
    ]) {
      const e = await inT((trx) => stmt.execute(trx)).then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
      expect(e?.code).toBe('42501');
    }
    const owner = createDb(f.tdb.url('lf_migrator'), 1);
    try {
      for (const stmt of [
        sql`UPDATE app.allocation SET amount = 2 WHERE id = ${a.allocationId}`,
        sql`DELETE FROM app.allocation WHERE id = ${a.allocationId}`,
        sql`TRUNCATE app.allocation`,
      ]) {
        const e = await withTenant(owner, f.tenantId, (trx) => stmt.execute(trx)).then(
          () => undefined,
          (x: unknown) => x as { code?: string },
        );
        expect(e?.code).toBe('23514');
      }
    } finally {
      await owner.destroy();
    }
  });

  it('SS-PLAT-82: the same key replays the first allocation; the same key for another allocation is a conflict', async () => {
    const inv = await postItem(invoice('20.0000', P('bolt')));
    const rct = await postItem(receipt('20.0000', P('bolt')));
    const c = alloc(rct.id, inv.id, '5.0000');
    const first = await inT((trx) => allocate(trx, c));
    const second = await inT((trx) => allocate(trx, c));
    expect(second).toEqual({ ...first, replayed: true });
    expect((await item(inv.id)).openAmount).toBe('15.0000');
    await refusedWith(
      inT((trx) => allocate(trx, { ...c, amount: '6.0000' })),
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('SS-PLAT-82: allocating across rates records fx_difference (base released from the credit item − from the debit item), posts no FX journal, and the reconciliation shows it as unposted FX', async () => {
    const company = await f.addCompany('FX Pty Ltd');
    const p = await inT(async (trx) => {
      for (const st of SERIES) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code: `je_${st}`, prefix: `F-${st}-` })
          .execute();
      }
      const row = await trx
        .insertInto('app.party')
        .values({ company_id: company, legal_name: 'FX customer' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    const inC = (x: PostingCommand): PostingCommand => ({ ...x, companyId: company });
    const inv = await postItem(inC(invoice('150.0000', p, { usd: '100.0000' })));
    const rct = await postItem(inC(receipt('160.0000', p, { usd: '100.0000' })));
    const entries = await f.countEntries();
    const a = await inT((trx) =>
      allocate(trx, { ...alloc(rct.id, inv.id, '100.0000'), companyId: company }),
    );
    expect(a).toMatchObject({
      currency: 'USD',
      fromBaseAmount: '160.0000',
      toBaseAmount: '150.0000',
      fxDifference: '10.0000',
    });
    expect(await f.countEntries()).toBe(entries);
    const rec = await inT((trx) => subledgerReconciliation(trx, { companyId: company }));
    expect(rec[0]).toEqual({
      controlRole: 'AR_CONTROL',
      accountIds: [f.chart(company).acct['1200']],
      controlBalance: '-10.0000',
      subledgerBalance: '0.0000',
      unpostedFxDifference: '10.0000',
      difference: '0.0000',
      reconciled: true,
    });

    // Partial allocations release base in proportion (half-up to 4 decimals) and the last one
    // releases the remainder, so a closed item keeps no base residue.
    const i3 = await postItem(inC(invoice('4.0000', p, { usd: '3.0000' })));
    const r3 = await postItem(inC(receipt('4.8000', p, { usd: '3.0000' })));
    const rel: string[] = [];
    for (const amt of ['1.0000', '1.0000', '1.0000']) {
      const x = await inT((trx) =>
        allocate(trx, { ...alloc(r3.id, i3.id, amt), companyId: company }),
      );
      rel.push(x.toBaseAmount);
    }
    expect(rel).toEqual(['1.3333', '1.3334', '1.3333']);
    expect(await item(i3.id)).toMatchObject({ openAmount: '0.0000', baseOpenAmount: '0.0000' });
    expect(await item(r3.id)).toMatchObject({ openAmount: '0.0000', baseOpenAmount: '0.0000' });
    expect(await inT((trx) => subledgerDrift(trx, company))).toEqual([]);
    const rec2 = await inT((trx) => subledgerReconciliation(trx, { companyId: company }));
    expect(rec2[0]).toMatchObject({ unpostedFxDifference: '10.8000', reconciled: true });
  });

  it('SS-PLAT-82: two concurrent allocations against one invoice never over-allocate (engine path)', async () => {
    const inv = await postItem(invoice('100.0000', P('acme')));
    const r1 = await postItem(receipt('70.0000', P('acme')));
    const r2 = await postItem(receipt('70.0000', P('acme')));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstDone!: () => void;
    const firstAllocated = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const t1 = f.inTenant(async (trx) => {
      const a = await allocate(trx, alloc(r1.id, inv.id, '70.0000'));
      firstDone();
      await gate;
      return a;
    });
    await firstAllocated;
    const t2 = f
      .inTenant((trx) => allocate(trx, alloc(r2.id, inv.id, '70.0000')))
      .then(
        () => undefined,
        (x: unknown) => x,
      );
    // t2 is blocked on the open item's lock while t1 is uncommitted
    await waitFor(async () => {
      const r = await f.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      return (r.rows[0]?.n ?? 0) > 0;
    });
    release();
    await t1;
    const e = await t2;
    expect(e).toBeInstanceOf(AllocationError);
    expect((e as AllocationError).code).toBe('OVER_ALLOCATION');
    expect((await item(inv.id)).openAmount).toBe('30.0000');
    expect((await item(r2.id)).openAmount).toBe('-70.0000');
  });

  it('SS-PLAT-82: two concurrent direct inserts by lf_app, bypassing the engine, cannot over-allocate either (database trigger + CHECK)', async () => {
    const inv = await postItem(invoice('100.0000', P('acme')));
    const r1 = await postItem(receipt('70.0000', P('acme')));
    const r2 = await postItem(receipt('70.0000', P('acme')));
    const row = (from: string) => ({
      company_id: f.companyId,
      from_entry_id: from,
      to_entry_id: inv.id,
      amount: '70.0000',
      allocation_date: '2026-10-20',
      idempotency_key: randomUUID(),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstDone!: () => void;
    const firstInserted = new Promise<void>((resolve) => {
      firstDone = resolve;
    });
    const t1 = f.inTenant(async (trx) => {
      await trx.insertInto('app.allocation').values(row(r1.id)).execute();
      firstDone();
      await gate;
    });
    await firstInserted;
    const t2 = f
      .inTenant((trx) => trx.insertInto('app.allocation').values(row(r2.id)).execute())
      .then(
        () => undefined,
        (x: unknown) => x as { code?: string; message?: string },
      );
    await waitFor(async () => {
      const r = await f.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted`,
      );
      return (r.rows[0]?.n ?? 0) > 0;
    });
    release();
    await t1;
    const e = await t2;
    expect(e?.code).toBe('23514');
    expect(e?.message).toMatch(/over-allocat/);
    expect((await item(inv.id)).openAmount).toBe('30.0000');
  });

  it('SS-PLAT-82: two concurrent allocations touching the same two items in opposite order do not deadlock', async () => {
    const inv = await postItem(invoice('10.0000', P('bolt')));
    const rct = await postItem(receipt('10.0000', P('bolt')));
    const results = await Promise.all([
      f.inTenant((trx) => allocate(trx, alloc(rct.id, inv.id, '3.0000'))),
      f.inTenant((trx) => allocate(trx, alloc(inv.id, rct.id, '4.0000'))),
    ]);
    expect(results).toHaveLength(2);
    expect((await item(inv.id)).openAmount).toBe('3.0000');
  });
});

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor: condition not met');
}
