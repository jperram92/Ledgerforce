/**
 * Reversal (void) of posted entries (T-0032, design §3.3 principle 2, GP-019, RQ-0095 Q11),
 * against a real PostgreSQL as lf_app.
 *
 * A reversal is a new entry (source type ledger_reversal, reversal_of_id = the original) whose
 * every line swaps debit and credit and keeps account, tax code, (unsigned) tax amount, party,
 * dimension set, currency, amount and rate. The original is never edited: its one permitted
 * change is posted → reversed (app.journal_mark_reversed, migration 0008). Open items of the
 * original are closed by allocating the reversal's mirrored items against them. Q11: a void is
 * allowed only when the original has no allocations (open = original) and the reversal falls in
 * the original's period; otherwise it is refused with a pointer to a credit note.
 */
import { randomUUID } from 'node:crypto';
import { Money } from '@ledgerforce/shared/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trialBalance, accountBalanceDrift } from './account-balance.ts';
import { verifyChain } from './hash-chain.ts';
import { findPeriod, setPeriodStatus } from './period.ts';
import { PostingError, type PostingCommand } from './posting-command.ts';
import { post, type PostingOutbox } from './posting-engine.ts';
import { previewReversal, reverse, type ReversalCommand } from './reversal.ts';
import { allocate, subledgerEntriesOf } from './subledger.ts';
import {
  createLedgerFixture,
  databaseFingerprint,
  expectedJournal,
  storedJournal,
  type LedgerFixture,
} from './testing/journal-fixture.ts';

let f: LedgerFixture;
const users: Record<string, string> = {};
let acme = '';
let dims: string[] = [];
const GST = '01900000-0000-7000-8000-0000000a0001';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003201');
  users.accountant = await f.addUser('accountant');
  users.financeAdmin = await f.addUser('finance_admin');
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of [
      ['je_ar_invoice', 'INV-'],
      ['je_ar_receipt', 'RCT-'],
      ['je_manual_journal', 'MJ-'],
      ['je_ledger_reversal', 'REV-'],
    ] as const) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix })
        .execute();
    }
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    acme = p.id;
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: f.companyId, code: 'department', name: 'Department' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const v = await trx
      .insertInto('app.dimension_value')
      .values({ company_id: f.companyId, dimension_id: d.id, code: 'SALES', name: 'Sales' })
      .returning('id')
      .executeTakeFirstOrThrow();
    dims = [v.id];
  });
});

afterAll(async () => {
  await f.close();
});

/** GP-001: INV-000123 to Acme, two GST lines, total 1,375.00. */
const invoice = (over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-11-05',
  sourceType: 'ar_invoice',
  sourceId: 'INV-000123',
  lines: [
    { account: { role: 'AR_CONTROL' }, debit: '1375.00', partyId: acme, dueDate: '2026-11-19' },
    {
      account: { id: f.acct['4110'] ?? '' },
      credit: '1000.00',
      taxCodeId: GST,
      taxAmount: '100.00',
      partyId: acme,
      dimensions: dims,
    },
    {
      account: { id: f.acct['4120'] ?? '' },
      credit: '250.00',
      taxCodeId: GST,
      taxAmount: '25.00',
      partyId: acme,
    },
    { account: { role: 'GST_COLLECTED' }, credit: '125.00', taxCodeId: GST },
  ],
  ...over,
});

const voidOf = (entryId: string, over: Partial<ReversalCommand> = {}): ReversalCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryId,
  entryDate: '2026-11-06',
  ...over,
});

const postInvoice = async (over: Partial<PostingCommand> = {}) =>
  (await f.inTenant((trx) => post(trx, invoice(over)))).entryId;

const entryRow = async (id: string) =>
  (
    await f.admin.query<Record<string, unknown>>(
      `SELECT to_jsonb(e) AS j FROM app.journal_entry e WHERE id = $1`,
      [id],
    )
  ).rows[0]?.j as Record<string, unknown>;

const lineRows = async (id: string) =>
  (await f.admin.query(`SELECT * FROM app.journal_line WHERE entry_id = $1 ORDER BY line_no`, [id]))
    .rows;

async function refused(c: ReversalCommand, code: string, message?: RegExp): Promise<void> {
  const before = await databaseFingerprint(f.admin);
  const error = await f
    .inTenant((trx) => reverse(trx, c))
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(error, `expected ${code}`).toBeInstanceOf(PostingError);
  expect((error as PostingError).code).toBe(code);
  if (message) expect((error as PostingError).message).toMatch(message);
  // Nothing was written: not a row, not a counter, not a sequence.
  expect(await databaseFingerprint(f.admin)).toEqual(before);
}

describe('reversal (void) of posted entries [T-0032]', () => {
  it('SS-UC10-09: Void posts a reversal, never an edit', async () => {
    const tbBefore = await f.inTenant((trx) => trialBalance(trx, f.companyId));
    const original = await postInvoice();
    const rowBefore = await entryRow(original);
    const linesBefore = await lineRows(original);

    const r = await f.inTenant((trx) => reverse(trx, voidOf(original)));
    expect(r.replayed).toBe(false);
    expect(r.reversalOfId).toBe(original);
    expect(r.entryId).not.toBe(original);
    expect(r.entryDate).toBe('2026-11-06');

    // The original is never edited: only posted → reversed; its lines are untouched.
    const rowAfter = await entryRow(original);
    expect(rowAfter).toEqual({ ...rowBefore, status: 'reversed' });
    expect(await lineRows(original)).toEqual(linesBefore);

    // The reversal: a new posted entry linked to the original, every line mirrored.
    const rev = await entryRow(r.entryId);
    expect(rev).toMatchObject({
      status: 'posted',
      source_type: 'ledger_reversal',
      source_id: original,
      reversal_of_id: original,
      entry_date: '2026-11-06',
    });
    const revLines = await lineRows(r.entryId);
    expect(revLines).toHaveLength(linesBefore.length);
    for (const [i, o] of linesBefore.entries()) {
      const l = revLines[i] as Record<string, unknown>;
      expect(l).toMatchObject({
        line_no: o.line_no,
        account_id: o.account_id,
        debit: o.credit,
        credit: o.debit,
        txn_currency: o.txn_currency,
        txn_amount: o.txn_amount,
        fx_rate: o.fx_rate,
        tax_code_id: o.tax_code_id,
        tax_amount: o.tax_amount,
        dimension_set_id: o.dimension_set_id,
        party_id: o.party_id,
      });
    }
    // Tax amounts stay unsigned (F5, RQ-0095): the side carries the direction.
    expect(revLines.map((l: Record<string, unknown>) => l.tax_amount)).toEqual([
      null,
      '100.0000',
      '25.0000',
      null,
    ]);

    // Balances return to their prior values; account_balance has no drift.
    const tbAfter = await f.inTenant((trx) => trialBalance(trx, f.companyId));
    // Net per account (debit − credit), exact: every account is back where it was.
    const netOf = (rows: typeof tbAfter) =>
      new Map(
        rows.map((x) => [
          x.code,
          Money.of(x.debit, 'XXX').sub(Money.of(x.credit, 'XXX')).toNumericString(),
        ]),
      );
    const netBefore = netOf(tbBefore);
    for (const [code, v] of netOf(tbAfter)) {
      expect(v, code).toBe(netBefore.get(code) ?? '0.0000');
    }
    await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual([]);

    // Subledger: the reversal item −1,375.00 is allocated to the invoice; both open 0.00.
    const [inv] = await f.inTenant((trx) => subledgerEntriesOf(trx, original));
    const [revItem] = await f.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
    expect(inv).toMatchObject({ originalAmount: '1375.0000', openAmount: '0.0000' });
    expect(revItem).toMatchObject({
      originalAmount: '-1375.0000',
      openAmount: '0.0000',
      baseOpenAmount: '0.0000',
      partyId: acme,
      sourceType: 'ledger_reversal',
    });
    const allocs = (
      await f.admin.query(
        `SELECT amount::text, from_entry_id::text, to_entry_id::text FROM app.allocation
          WHERE from_entry_id IN ($1, $2) OR to_entry_id IN ($1, $2)`,
        [inv?.id, revItem?.id],
      )
    ).rows;
    expect(allocs).toHaveLength(1);
    expect(allocs[0]?.amount).toBe('1375.0000');

    // The hash chain still verifies (status is not hashed; the reversal is chained).
    await expect(f.inTenant((trx) => verifyChain(trx, f.companyId))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('a repeat of the same key returns the first reversal and writes nothing [T-0032]', async () => {
    const original = await postInvoice();
    const c = voidOf(original);
    const first = await f.inTenant((trx) => reverse(trx, c));
    const before = await databaseFingerprint(f.admin);
    const again = await f.inTenant((trx) => reverse(trx, c));
    expect(again).toMatchObject({ entryId: first.entryId, replayed: true, reversalOfId: original });
    expect(await databaseFingerprint(f.admin)).toEqual(before);
  });

  it('refuses a second reversal of an entry already reversed [T-0032]', async () => {
    const original = await postInvoice();
    await f.inTenant((trx) => reverse(trx, voidOf(original)));
    await refused(voidOf(original), 'ALREADY_REVERSED');
  });

  it('refuses to reverse a reversal [T-0032]', async () => {
    const original = await postInvoice();
    const r = await f.inTenant((trx) => reverse(trx, voidOf(original)));
    await refused(voidOf(r.entryId), 'REVERSAL_OF_REVERSAL');
  });

  it('refuses an unknown entry and an entry of another company [T-0032]', async () => {
    await refused(voidOf(randomUUID()), 'UNKNOWN_ENTRY');
    const elsewhere = await f.addCompany('Elsewhere Pty Ltd');
    const other = await f.inTenant((trx) =>
      f.insertEntry(
        trx,
        [
          { code: '6200', debit: '10.0000' },
          { code: '1100', credit: '10.0000' },
        ],
        { company: elsewhere },
      ),
    );
    await refused(voidOf(other), 'UNKNOWN_ENTRY');
  });

  it('refuses a reversal dated before the original [T-0032]', async () => {
    const original = await postInvoice();
    await refused(voidOf(original, { entryDate: '2026-11-04' }), 'REVERSAL_BEFORE_ORIGINAL');
  });

  it('Q11: refuses a void once a receipt is allocated to the invoice, pointing to a credit note [T-0032]', async () => {
    const original = await postInvoice();
    const receipt = await f.inTenant((trx) =>
      post(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        entryDate: '2026-11-06',
        sourceType: 'ar_receipt',
        lines: [
          { account: { id: f.acct['1010'] ?? '' }, debit: '100.00' },
          { account: { role: 'AR_CONTROL' }, credit: '100.00', partyId: acme },
        ],
      }),
    );
    await f.inTenant(async (trx) => {
      const [inv] = await subledgerEntriesOf(trx, original);
      const [rct] = await subledgerEntriesOf(trx, receipt.entryId);
      await allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        fromEntryId: rct?.id ?? '',
        toEntryId: inv?.id ?? '',
        amount: '100.00',
        allocationDate: '2026-11-06',
      });
    });
    await refused(voidOf(original), 'VOID_HAS_ALLOCATIONS', /credit note/);
    expect((await entryRow(original)).status).toBe('posted');
  });

  it('Q11: refuses a void in a later period than the invoice, pointing to a credit note [T-0032]', async () => {
    const original = await postInvoice();
    await refused(
      voidOf(original, { entryDate: '2026-12-02' }),
      'VOID_OTHER_PERIOD',
      /credit note/,
    );
  });

  it('the same-period rule binds only what reaches the BAS or the subledger: an untaxed manual journal reverses into a later open period [T-0032]', async () => {
    const lines = [
      { account: { id: f.acct['6200'] ?? '' }, debit: '40.00' },
      { account: { id: f.acct['1100'] ?? '' }, credit: '40.00' },
    ];
    const accrual = (
      await f.inTenant((trx) =>
        post(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-09-30',
          sourceType: 'manual_journal',
          lines,
        }),
      )
    ).entryId;
    const r = await f.inTenant((trx) =>
      reverse(trx, voidOf(accrual, { entryDate: '2026-10-01', memo: 'accrual reversal' })),
    );
    expect(r.entryDate).toBe('2026-10-01');
    expect((await entryRow(accrual)).status).toBe('reversed');
    expect((await entryRow(r.entryId)).memo).toMatch(/^Reversal of .+: accrual reversal$/);

    // The same journal with a tax code is held to the same BAS period.
    const taxed = (
      await f.inTenant((trx) =>
        post(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-09-30',
          sourceType: 'manual_journal',
          lines: [{ ...lines[0], taxCodeId: GST, taxAmount: '4.00' }, lines[1]] as typeof lines,
        }),
      )
    ).entryId;
    await refused(voidOf(taxed, { entryDate: '2026-10-01' }), 'VOID_OTHER_PERIOD', /credit note/);
  });

  it('respects period locks: a soft-closed period needs an override; hard-locked denies [T-0032]', async () => {
    const company = f.companyId;
    // A month of its own so other tests are unaffected: March 2027.
    const original = await postInvoice({ entryDate: '2027-03-10' });
    const period = await f.inTenant((trx) => findPeriod(trx, company, '2027-03-10'));
    await f.inTenant((trx) =>
      setPeriodStatus(trx, {
        periodId: period?.id ?? '',
        status: 'soft_closed',
        actorId: users.financeAdmin ?? '',
      }),
    );
    const c = voidOf(original, { entryDate: '2027-03-11' });
    const before = await databaseFingerprint(f.admin);
    await expect(f.inTenant((trx) => reverse(trx, c))).rejects.toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    expect(await databaseFingerprint(f.admin)).toEqual(before);
    // With a recorded override by a user who holds period.lock.override, it posts.
    const r = await f.inTenant((trx) =>
      reverse(trx, {
        ...c,
        createdBy: users.financeAdmin ?? '',
        periodOverride: { reason: 'Invoice raised in error; void approved' },
      }),
    );
    expect(r.entryDate).toBe('2027-03-11');
    expect((await entryRow(original)).status).toBe('reversed');

    const second = await postInvoice({ entryDate: '2027-04-10' });
    const april = await f.inTenant((trx) => findPeriod(trx, company, '2027-04-10'));
    await f.inTenant((trx) =>
      setPeriodStatus(trx, {
        periodId: april?.id ?? '',
        status: 'hard_locked',
        actorId: users.financeAdmin ?? '',
      }),
    );
    const hard = voidOf(second, { entryDate: '2027-04-11' });
    const b2 = await databaseFingerprint(f.admin);
    await expect(
      f.inTenant((trx) =>
        reverse(trx, {
          ...hard,
          createdBy: users.financeAdmin ?? '',
          periodOverride: { reason: 'try' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(await databaseFingerprint(f.admin)).toEqual(b2);
  });

  it('mirrors a manual journal with dimensions and a foreign-currency line [T-0032]', async () => {
    const original = (
      await f.inTenant((trx) =>
        post(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-10-20',
          sourceType: 'manual_journal',
          lines: [
            {
              account: { id: f.acct['6200'] ?? '' },
              debit: '80.00',
              dimensions: dims,
              memo: 'fees',
            },
            {
              account: { id: f.acct['1100'] ?? '' },
              credit: '80.00',
              txnCurrency: 'USD',
              txnAmount: '52.10',
              fxRate: '1.53550864',
            },
          ],
        }),
      )
    ).entryId;
    const linesBefore = await lineRows(original);
    const r = await f.inTenant((trx) =>
      reverse(trx, voidOf(original, { entryDate: '2026-10-21' })),
    );
    const revLines = await lineRows(r.entryId);
    expect(revLines.map((l: Record<string, unknown>) => [l.debit, l.credit])).toEqual(
      linesBefore.map((l: Record<string, unknown>) => [l.credit, l.debit]),
    );
    expect(revLines[1]).toMatchObject({
      txn_currency: 'USD',
      txn_amount: '52.1000',
      fx_rate: '1.53550864',
    });
    expect(revLines[0]?.dimension_set_id).toBe(linesBefore[0]?.dimension_set_id);
    expect(revLines[0]?.memo).toBe('fees');
    expect((await entryRow(original)).status).toBe('reversed');
  });

  it('previewReversal returns the journal reverse() writes and writes nothing [T-0032]', async () => {
    const original = await postInvoice();
    const c = voidOf(original);
    const before = await databaseFingerprint(f.admin);
    const built = await f.inTenant((trx) => previewReversal(trx, c));
    expect(await databaseFingerprint(f.admin)).toEqual(before);
    expect(built.sourceType).toBe('ledger_reversal');
    expect(built.subledgerItems).toHaveLength(1);
    const r = await f.inTenant((trx) => reverse(trx, c));
    const stored = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(stored).toEqual(expectedJournal(built));
  });

  it('a failure after the lines are written leaves nothing: the original stays posted [T-0032]', async () => {
    const original = await postInvoice();
    const boom: PostingOutbox = {
      enqueue: async () => {
        throw new Error('outbox down');
      },
    };
    const before = await databaseFingerprint(f.admin);
    await expect(
      f.inTenant((trx) => reverse(trx, voidOf(original), { outbox: boom })),
    ).rejects.toThrow(/outbox down/);
    expect(await databaseFingerprint(f.admin)).toEqual(before);
    expect((await entryRow(original)).status).toBe('posted');
  });

  it('raw ledger_reversal commands stay refused: a reversal is produced from the original only [T-0032]', async () => {
    await expect(
      f.inTenant((trx) =>
        post(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-11-06',
          sourceType: 'ledger_reversal',
          lines: [
            { account: { id: f.acct['6200'] ?? '' }, debit: '1.00' },
            { account: { id: f.acct['1100'] ?? '' }, credit: '1.00' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_TYPE_NOT_SUPPORTED' });
    const n = await f.admin.query(
      `SELECT count(*)::int AS n FROM app.journal_entry
        WHERE source_type = 'ledger_reversal' AND reversal_of_id IS NULL`,
    );
    expect(n.rows[0]?.n).toBe(0);
  });
});
