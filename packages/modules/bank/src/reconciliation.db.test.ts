/**
 * Bank reconciliation against a real PostgreSQL as lf_app (T-0061, UC-08 step 5 + A2, DL-0326,
 * migration 0057).
 *
 * SS-UC08-06 — with every November line matched, the reconciliation report shows statement closing
 * balance = book balance (the bank GL account at the statement date) and nothing unreconciled.
 * A2 — an unmatched line is listed as unreconciled; a book entry the bank has not cleared yet is
 * listed as an outstanding book item; the adjusted statement balance still ties to the book.
 * SS-PLAT-126 — a completed reconciliation locks the lines it covers against unmatching (module
 * and database), and cannot be completed while the statement does not tie.
 * SS-UC08-07 — with November hard-locked, unmatching a November line is rejected; December can
 * still be unmatched.
 *
 * The November statement is the Harbour CSV fixture (10 lines, 8,394.43 net; the bank's running
 * balance closes at 13,394.43 from 5,000.00). The books start with a 5,000.00 opening balance on
 * 2026-11-01, before the first statement line: the opening position, not an outstanding item.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  approveManualJournal,
  createManualJournal,
  getManualJournal,
  postManualJournal,
  submitManualJournal,
} from '@ledgerforce/journals';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { findPeriod, PeriodLockedError, setPeriodStatus } from '@ledgerforce/ledger';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { DEFAULT_SOD_SETTINGS, type SodSettings } from '@ledgerforce/shared/sod';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyBankAccount } from './bank-accounts.ts';
import { BankMatchError, createTransactionFromLine } from './matching.ts';
import { validateCsvMapping } from './parse.ts';
import {
  BankReconciliationError,
  completeReconciliation,
  reconciliationReport,
  unmatchLine,
} from './reconciliation.ts';
import { importStatement } from './statements.ts';

const SETTINGS: SodSettings = {
  ...DEFAULT_SOD_SETTINGS,
  thresholds: { ...DEFAULT_SOD_SETTINGS.thresholds, journal_approval: '100000.0000' },
};
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const DECEMBER = Buffer.from(
  [
    'Date,Description,Reference,Debit,Credit,Balance,Transaction ID',
    '03/12/2026,Account fee,,10.00,,"13,384.43",202612030001',
    '08/12/2026,Interest,,,5.00,"13,389.43",202612080002',
  ].join('\n'),
);

let f: LedgerFixture;
let accountant: string;
let financeAdmin: string;
let approver: string;

interface Book {
  company: string;
  bankAccountId: string;
  november: string;
  december: string;
}
let main: Book;
let locked: Book;

const acct = (company: string, code: string): string => {
  const id = f.chart(company).acct[code];
  if (!id) throw new Error(`no account ${code}`);
  return id;
};

/** A manual journal through @ledgerforce/journals (the posting engine). */
async function postJournal(
  company: string,
  entryDate: string,
  key: string,
  lines: { code: string; debit?: string; credit?: string }[],
): Promise<string> {
  return f.inTenant(async (trx) => {
    const { id } = await createManualJournal(trx, {
      input: {
        companyId: company,
        entryDate,
        memo: key,
        lines: lines.map((l) => ({
          account: { id: acct(company, l.code) },
          ...(l.debit ? { debit: l.debit } : { credit: l.credit ?? '0' }),
        })),
      },
      createdBy: accountant,
      idempotencyKey: key,
    });
    if ((await getManualJournal(trx, id)).status === 'draft') {
      const sub = await submitManualJournal(trx, {
        id,
        submittedBy: accountant,
        settings: SETTINGS,
      });
      // Equity lines (the opening balance) need a second person (design §6.5 rule 4).
      if (sub.approvalRequired) await approveManualJournal(trx, { id, approvedBy: approver });
    }
    return (await postManualJournal(trx, { id, postedBy: accountant, settings: SETTINGS })).entryId;
  });
}

async function setUpBook(company: string): Promise<Book> {
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({ company_id: company, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute(),
  );
  const bankAccountId = await f.inTenant((trx) =>
    createCompanyBankAccount(trx, kms, company, {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
      glAccountId: acct(company, '1010'),
      csvMapping: validateCsvMapping(
        JSON.parse(fixture('harbour-csv-mapping.json').toString('utf8')),
      ),
    }),
  );
  const imp = (content: Buffer, fileName: string) =>
    f.inTenant((trx) => importStatement(trx, { bankAccountId, content, fileName }));
  const november = (await imp(fixture('harbour-2026-11.csv'), 'harbour-2026-11.csv')).statementId;
  const december = (await imp(DECEMBER, 'harbour-2026-12.csv')).statementId;
  await postJournal(company, '2026-11-01', `opening-${company}`, [
    { code: '1010', debit: '5000.00' },
    { code: '3000', credit: '5000.00' },
  ]);
  return { company, bankAccountId, november, december };
}

async function lines(
  b: Book,
): Promise<
  { id: string; amount: string; description: string; posted_on: string; status: string }[]
> {
  return f.inTenant(
    async (trx) =>
      (
        await sql<{
          id: string;
          amount: string;
          description: string;
          posted_on: string;
          status: string;
        }>`
          SELECT id::text, amount::text, description, to_char(posted_on, 'YYYY-MM-DD') AS posted_on, status
            FROM app.bank_statement_line WHERE bank_account_id = ${b.bankAccountId}
           ORDER BY posted_on, line_no`.execute(trx)
      ).rows,
  );
}

/** Every unmatched line of the book becomes a transaction: out → bank fees, in → interest income. */
async function createAll(b: Book): Promise<void> {
  for (const l of await lines(b)) {
    if (l.status !== 'unmatched') continue;
    const out = l.amount.startsWith('-');
    await f.inTenant((trx) =>
      createTransactionFromLine(trx, {
        statementLineId: l.id,
        lines: [
          {
            account: { id: acct(b.company, out ? '6110' : '4900') },
            amount: out ? l.amount.slice(1) : l.amount,
          },
        ],
        createdBy: accountant,
        settings: SETTINGS,
      }),
    );
  }
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000006101');
  accountant = await f.addUser('accountant');
  financeAdmin = await f.addUser('finance_admin');
  approver = await f.addUser('approver');
  main = await setUpBook(f.companyId);
  locked = await setUpBook(await f.addCompany('Hard Lock Pty Ltd'));
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('A2: Unmatched lines are listed as unreconciled', () => {
  it('before matching, all 10 November lines are unreconciled and the adjusted statement balance ties to the book', async () => {
    const r = await f.inTenant((trx) =>
      reconciliationReport(trx, { statementId: main.november, closingBalance: '13394.43' }),
    );
    expect(r).toMatchObject({
      bankAccountId: main.bankAccountId,
      statementId: main.november,
      currency: 'AUD',
      asOf: '2026-11-30',
      startDate: '2026-11-02',
    });
    expect(r.statementClosingBalance.toNumericString()).toBe('13394.4300');
    expect(r.bookBalance.toNumericString()).toBe('5000.0000');
    expect(r.unreconciledLines).toHaveLength(10);
    expect(r.unreconciledLines[0]).toMatchObject({
      postedOn: '2026-11-02',
      description: 'Direct credit Acme Pty Ltd',
      reference: 'INV-000123',
    });
    expect(r.unreconciledLines[0]?.amount.toNumericString()).toBe('1375.0000');
    expect(r.unreconciledLinesTotal.toNumericString()).toBe('8394.4300');
    expect(r.unreconciledBookItems).toEqual([]);
    expect(r.adjustedStatementBalance.toNumericString()).toBe('5000.0000');
    expect(r.difference.isZero()).toBe(true);
    expect(r.unreconciledCount).toBe(10);
  });

  it('a CSV statement has no closing balance of its own: the report asks for one', async () => {
    await expect(
      f.inTenant((trx) => reconciliationReport(trx, { statementId: main.november })),
    ).rejects.toMatchObject({ code: 'CLOSING_BALANCE_REQUIRED' });
    await expect(
      f.inTenant((trx) =>
        reconciliationReport(trx, { statementId: '01900000-0000-7000-8000-00000000dead' }),
      ),
    ).rejects.toBeInstanceOf(BankReconciliationError);
  });
});

describe('SS-UC08-06: Statement balance equals book balance', () => {
  it('SS-UC08-06 with all November lines matched, statement closing balance = book balance and unreconciled = 0', async () => {
    await createAll(main);
    const r = await f.inTenant((trx) =>
      reconciliationReport(trx, { statementId: main.november, closingBalance: '13394.43' }),
    );
    expect(r.statementClosingBalance.toNumericString()).toBe('13394.4300');
    expect(r.bookBalance.toNumericString()).toBe('13394.4300');
    expect(r.statementClosingBalance.equals(r.bookBalance)).toBe(true);
    expect(r.unreconciledLines).toEqual([]);
    expect(r.unreconciledBookItems).toEqual([]);
    expect(r.unreconciledCount).toBe(0);
    expect(r.difference.isZero()).toBe(true);
    expect(r.balanced).toBe(true);
  });

  it('an outstanding book payment the bank has not cleared is listed and the adjusted balance still ties (December)', async () => {
    const cheque = await postJournal(main.company, '2026-12-05', 'cheque-300', [
      { code: '6110', debit: '300.00' },
      { code: '1010', credit: '300.00' },
    ]);
    const r = await f.inTenant((trx) =>
      reconciliationReport(trx, { statementId: main.december, closingBalance: '13389.43' }),
    );
    expect(r.asOf).toBe('2026-12-08');
    expect(r.unreconciledLines).toEqual([]);
    expect(r.unreconciledBookItems).toEqual([
      expect.objectContaining({ entryId: cheque, entryDate: '2026-12-05' }),
    ]);
    expect(r.unreconciledBookItems[0]?.amount.toNumericString()).toBe('-300.0000');
    expect(r.bookBalance.toNumericString()).toBe('13089.4300');
    expect(r.adjustedStatementBalance.toNumericString()).toBe('13089.4300');
    expect(r.balanced).toBe(true);
    expect(r.unreconciledCount).toBe(1);
  });
});

describe('SS-PLAT-126: A completed reconciliation locks its lines against unmatching', () => {
  it('SS-PLAT-126 a statement that does not tie cannot be completed', async () => {
    await expect(
      f.inTenant((trx) =>
        completeReconciliation(trx, {
          statementId: main.november,
          closingBalance: '13000.00',
          completedBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_BALANCED' });
  });

  it('SS-PLAT-126 completing November records the figures; its lines can then no longer be unmatched', async () => {
    const done = await f.inTenant((trx) =>
      completeReconciliation(trx, {
        statementId: main.november,
        closingBalance: '13394.43',
        completedBy: accountant,
      }),
    );
    const row = await f.inTenant(
      async (trx) =>
        (
          await sql<Record<string, string>>`
            SELECT status, to_char(as_of, 'YYYY-MM-DD') AS as_of, statement_balance::text,
                   book_balance::text, unreconciled_lines_total::text, unreconciled_book_total::text,
                   completed_by::text
              FROM app.bank_reconciliation WHERE id = ${done.reconciliationId}`.execute(trx)
        ).rows[0],
    );
    expect(row).toEqual({
      status: 'completed',
      as_of: '2026-11-30',
      statement_balance: '13394.4300',
      book_balance: '13394.4300',
      unreconciled_lines_total: '0.0000',
      unreconciled_book_total: '0.0000',
      completed_by: accountant,
    });
    await expect(
      f.inTenant((trx) =>
        completeReconciliation(trx, {
          statementId: main.november,
          closingBalance: '13394.43',
          completedBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_RECONCILED' });

    const fee = (await lines(main)).find((l) => l.description === 'Account fee');
    await expect(
      f.inTenant((trx) => unmatchLine(trx, { statementLineId: fee?.id ?? '', by: accountant })),
    ).rejects.toMatchObject({ code: 'RECONCILED' });
    // The database refuses it too, whoever asks.
    await expect(
      f.inTenant((trx) =>
        sql`UPDATE app.bank_match SET status = 'unmatched', unmatched_at = clock_timestamp()
             WHERE statement_line_id = ${fee?.id ?? ''} AND status = 'matched'`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'bank_match_reconciled' });
    expect((await lines(main)).find((l) => l.id === fee?.id)?.status).toBe('matched');
  });
});

describe('SS-UC08-07: Reconciled lines locked after hard lock', () => {
  it('SS-UC08-07 with November hard-locked, unmatching a November line is rejected; a December line can be unmatched', async () => {
    await createAll(locked);
    await f.inTenant(async (trx) => {
      const p = await findPeriod(trx, locked.company, '2026-11-15');
      await setPeriodStatus(trx, {
        periodId: p?.id ?? '',
        status: 'hard_locked',
        actorId: financeAdmin,
      });
    });
    const all = await lines(locked);
    const nov = all.find((l) => l.posted_on === '2026-11-02' && l.description === 'Account fee');
    const dec = all.find((l) => l.posted_on === '2026-12-03');
    const err = await f
      .inTenant((trx) => unmatchLine(trx, { statementLineId: nov?.id ?? '', by: accountant }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodLockedError);
    expect(err).toMatchObject({ code: 'PERIOD_LOCKED' });

    const r = await f.inTenant((trx) =>
      unmatchLine(trx, { statementLineId: dec?.id ?? '', by: accountant }),
    );
    const after = await lines(locked);
    expect(after.find((l) => l.id === nov?.id)?.status).toBe('matched');
    expect(after.find((l) => l.id === dec?.id)?.status).toBe('unmatched');
    const m = await f.inTenant(
      async (trx) =>
        (
          await sql<{ status: string; unmatched_by: string }>`
            SELECT status, unmatched_by::text FROM app.bank_match WHERE id = ${r.matchId}`.execute(
            trx,
          )
        ).rows[0],
    );
    expect(m).toEqual({ status: 'unmatched', unmatched_by: accountant });
    // The unmatched December line is unreconciled again; its entry is an outstanding book item.
    const rep = await f.inTenant((trx) =>
      reconciliationReport(trx, { statementId: locked.december, closingBalance: '13389.43' }),
    );
    expect(rep.unreconciledLines.map((l) => l.id)).toEqual([dec?.id]);
    expect(rep.unreconciledBookItems).toHaveLength(1);
    expect(rep.balanced).toBe(true);
    // Unmatching it again is refused: nothing is matched.
    await expect(
      f.inTenant((trx) => unmatchLine(trx, { statementLineId: dec?.id ?? '', by: accountant })),
    ).rejects.toBeInstanceOf(BankMatchError);
  });
});
