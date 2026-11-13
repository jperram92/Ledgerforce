/**
 * Bank matching against a real PostgreSQL as lf_app (T-0060, UC-08 steps 2–4, RQ-0108, DL-0312).
 *
 * SS-UC08-03 — exact (amount + reference) matches are matched automatically when matching runs.
 * SS-UC08-04 (stored half) — a rule match is stored as an open suggestion, the line stays unmatched.
 * SS-UC08-05 — an unmatched line created as a transaction: a balanced manual journal posts through
 * the posting engine (manual-journal and control-account rules) and the line is matched.
 * T-0150 — the journal preview of a transaction from a line: the posting engine's preview of the
 * command the post uses; it refuses what the post refuses and writes nothing.
 *
 * The statement is the November Harbour CSV fixture used by T-0058 (1,375.00 "INV-000123" in,
 * 10.00 account fee out, 550.55 Stripe payout in, …).
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { recordReceipt } from '@ledgerforce/ar';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { DEFAULT_SOD_SETTINGS } from '@ledgerforce/shared/sod';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyBankAccount } from './bank-accounts.ts';
import {
  createMatchRule,
  createTransactionFromLine,
  listLineMatching,
  previewTransactionFromLine,
  runMatching,
  BankMatchError,
} from './matching.ts';
import { validateCsvMapping } from './parse.ts';
import { importStatement } from './statements.ts';

let f: LedgerFixture;
let bankAccountId: string;
let accountant: string;
let acme: string;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const acct = (code: string): string => {
  const id = f.acct[code];
  if (!id) throw new Error(`no account ${code}`);
  return id;
};

async function lineBy(description: string): Promise<{ id: string; status: string }> {
  const r = await f.inTenant(
    async (trx) =>
      (
        await sql<{ id: string; status: string }>`
          SELECT id::text, status FROM app.bank_statement_line
           WHERE bank_account_id = ${bankAccountId} AND description = ${description}
           ORDER BY line_no LIMIT 1`.execute(trx)
      ).rows,
  );
  const row = r[0];
  if (!row) throw new Error(`no statement line "${description}"`);
  return row;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000006001');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  accountant = await f.addUser('accountant');
  bankAccountId = await f.inTenant((trx) =>
    createCompanyBankAccount(trx, kms, f.companyId, {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
      glAccountId: acct('1010'),
      csvMapping: validateCsvMapping(
        JSON.parse(fixture('harbour-csv-mapping.json').toString('utf8')),
      ),
    }),
  );
  await f.inTenant((trx) =>
    importStatement(trx, {
      bankAccountId,
      content: fixture('harbour-2026-11.csv'),
      fileName: 'harbour-2026-11.csv',
    }),
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC08-03: Exact match auto-matches', () => {
  it('SS-UC08-03 a receipt of 1,375.00 ref INV-000123 and a statement line 1,375.00 "INV-000123" are matched automatically', async () => {
    const receipt = await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-02',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: acct('1010') },
        reference: 'INV-000123',
        idempotencyKey: 'acme-eft-1',
        allocations: [],
      }),
    );
    // A second receipt of the same amount without the reference must not be taken.
    await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-02',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: acct('1010') },
        reference: 'other',
        idempotencyKey: 'acme-eft-2',
        allocations: [],
      }),
    );
    const run = await f.inTenant((trx) => runMatching(trx, { bankAccountId, runBy: accountant }));
    expect(run.autoMatched).toBe(1);

    const credit = await lineBy('Direct credit Acme Pty Ltd');
    expect(credit.status).toBe('matched');
    const m = await f.inTenant((trx) => listLineMatching(trx, credit.id));
    expect(m.match).toMatchObject({
      sourceKind: 'customer_receipt',
      sourceId: receipt.receiptId,
      journalEntryId: receipt.entryId,
      method: 'auto_exact',
      status: 'matched',
    });
    expect(m.suggestions).toEqual([]);

    // Running again changes nothing (idempotent) and the receipt is not matched twice.
    const again = await f.inTenant((trx) => runMatching(trx, { bankAccountId, runBy: accountant }));
    expect(again.autoMatched).toBe(0);
    const n = await f.inTenant(
      async (trx) =>
        (
          await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.bank_match
            WHERE journal_entry_id = ${receipt.entryId}`.execute(trx)
        ).rows[0]?.n,
    );
    expect(n).toBe(1);
  });

  it('the database refuses a match whose entry does not move the bank account by the line amount', async () => {
    const fee = await lineBy('Account fee');
    const receiptEntry = await f.inTenant(
      async (trx) =>
        (
          await sql<{ entry_id: string; id: string }>`
            SELECT entry_id::text, id::text FROM app.customer_receipt WHERE idempotency_key = 'acme-eft-2'`.execute(
            trx,
          )
        ).rows[0],
    );
    await expect(
      f.inTenant((trx) =>
        sql`INSERT INTO app.bank_match (company_id, bank_account_id, statement_line_id, journal_entry_id,
                                         source_kind, source_id, method, matched_by)
            VALUES (${f.companyId}, ${bankAccountId}, ${fee.id}, ${receiptEntry?.entry_id},
                    'customer_receipt', ${receiptEntry?.id}, 'manual', ${accountant})`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('SS-UC08-04: Rule match is suggested, not applied (stored)', () => {
  it('SS-UC08-04 a "description contains STRIPE → Stripe clearing" rule stores an open suggestion and the line stays unmatched', async () => {
    const ruleId = await f.inTenant((trx) =>
      createMatchRule(trx, {
        companyId: f.companyId,
        bankAccountId,
        name: 'Stripe payouts',
        priority: 10,
        definition: {
          match: 'all',
          conditions: [{ field: 'description', op: 'contains', value: 'STRIPE' }],
          direction: 'in',
        },
        accountId: acct('1210'),
        createdBy: accountant,
      }),
    );
    const run = await f.inTenant((trx) => runMatching(trx, { bankAccountId, runBy: accountant }));
    expect(run.autoMatched).toBe(0);
    expect(run.suggested).toBe(1);
    const payout = await lineBy('Stripe payout');
    expect(payout.status).toBe('unmatched');
    const m = await f.inTenant((trx) => listLineMatching(trx, payout.id));
    expect(m.match).toBeNull();
    expect(m.suggestions).toEqual([
      expect.objectContaining({ kind: 'rule', ruleId, accountId: acct('1210'), status: 'open' }),
    ]);
    // Re-running does not duplicate the open suggestion.
    const again = await f.inTenant((trx) => runMatching(trx, { bankAccountId, runBy: accountant }));
    expect(again.suggested).toBe(0);
  });
});

describe('SS-UC08-05: Unmatched line created as a transaction', () => {
  it('SS-UC08-05 the 10.00 bank fee line becomes a balanced manual journal posted by the engine and the line is matched', async () => {
    const fee = await lineBy('Account fee');
    expect(fee.status).toBe('unmatched');
    const before = await f.countEntries();
    const r = await f.inTenant((trx) =>
      createTransactionFromLine(trx, {
        statementLineId: fee.id,
        lines: [{ account: { id: acct('6110') }, amount: '10.00', memo: 'Account keeping fee' }],
        createdBy: accountant,
        settings: DEFAULT_SOD_SETTINGS,
      }),
    );
    expect(await f.countEntries()).toBe(before + 1);
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{
            code: string;
            debit: string;
            credit: string;
            source_type: string;
            status: string;
          }>`
            SELECT a.code, l.debit::text, l.credit::text, e.source_type, e.status
              FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
              JOIN app.journal_entry e ON e.id = l.entry_id
             WHERE l.entry_id = ${r.entryId} ORDER BY l.line_no`.execute(trx)
        ).rows,
    );
    expect(rows).toEqual([
      {
        code: '1010',
        debit: '0.0000',
        credit: '10.0000',
        source_type: 'manual_journal',
        status: 'posted',
      },
      {
        code: '6110',
        debit: '10.0000',
        credit: '0.0000',
        source_type: 'manual_journal',
        status: 'posted',
      },
    ]);
    expect((await lineBy('Account fee')).status).toBe('matched');
    const m = await f.inTenant((trx) => listLineMatching(trx, fee.id));
    expect(m.match).toMatchObject({
      sourceKind: 'bank_transaction',
      sourceId: r.manualJournalId,
      journalEntryId: r.entryId,
      method: 'created',
    });
    // A repeat returns the same transaction; nothing new is posted.
    const again = await f.inTenant((trx) =>
      createTransactionFromLine(trx, {
        statementLineId: fee.id,
        lines: [{ account: { id: acct('6110') }, amount: '10.00' }],
        createdBy: accountant,
        settings: DEFAULT_SOD_SETTINGS,
      }),
    );
    expect(again).toMatchObject({ entryId: r.entryId, replayed: true });
    expect(await f.countEntries()).toBe(before + 1);
  });

  it('accepting the Stripe rule suggestion posts to Stripe clearing and closes the suggestion', async () => {
    const payout = await lineBy('Stripe payout');
    const [s] = (await f.inTenant((trx) => listLineMatching(trx, payout.id))).suggestions;
    const r = await f.inTenant((trx) =>
      createTransactionFromLine(trx, {
        statementLineId: payout.id,
        fromSuggestionId: s?.id ?? '',
        createdBy: accountant,
        settings: DEFAULT_SOD_SETTINGS,
      }),
    );
    const m = await f.inTenant((trx) => listLineMatching(trx, payout.id));
    expect(m.match).toMatchObject({ journalEntryId: r.entryId, method: 'rule', ruleId: s?.ruleId });
    expect(m.suggestions).toEqual([expect.objectContaining({ id: s?.id, status: 'accepted' })]);
  });

  it('refuses lines that do not add up, control accounts (manual-journal rule) and matched lines', async () => {
    const rent = await lineBy('BPAY Office Rent Pty');
    await expect(
      f.inTenant((trx) =>
        createTransactionFromLine(trx, {
          statementLineId: rent.id,
          lines: [{ account: { id: acct('6230') }, amount: '2000.00' }],
          createdBy: accountant,
          settings: DEFAULT_SOD_SETTINGS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
    await expect(
      f.inTenant((trx) =>
        createTransactionFromLine(trx, {
          statementLineId: rent.id,
          lines: [{ account: { id: acct('2000') }, amount: '2200.00' }],
          createdBy: accountant,
          settings: DEFAULT_SOD_SETTINGS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONTROL_ACCOUNT' });
    const credit = await lineBy('Direct credit Acme Pty Ltd');
    await expect(
      f.inTenant((trx) =>
        createTransactionFromLine(trx, {
          statementLineId: credit.id,
          lines: [{ account: { id: acct('4110') }, amount: '1375.00' }],
          createdBy: accountant,
          settings: DEFAULT_SOD_SETTINGS,
        }),
      ),
    ).rejects.toBeInstanceOf(BankMatchError);
    expect((await lineBy('BPAY Office Rent Pty')).status).toBe('unmatched');
  });
});

describe('T-0150: journal preview of a transaction from a line', () => {
  const written = (): Promise<{ entries: number; journals: number; matches: number }> =>
    f.inTenant(async (trx) => {
      const r = await sql<{ entries: number; journals: number; matches: number }>`
        SELECT (SELECT count(*)::int FROM app.journal_entry) AS entries,
               (SELECT count(*)::int FROM app.manual_journal) AS journals,
               (SELECT count(*)::int FROM app.bank_match) AS matches`.execute(trx);
      const row = r.rows[0];
      if (!row) throw new Error('no counts');
      return row;
    });

  it('T-0150 AC-1 previews the rent line as the journal the post then writes, and writes nothing', async () => {
    const rent = await lineBy('BPAY Office Rent Pty');
    const before = await written();
    const p = await f.inTenant((trx) =>
      previewTransactionFromLine(trx, {
        statementLineId: rent.id,
        lines: [{ account: { id: acct('6230') }, amount: '2200.00', memo: 'November rent' }],
        createdBy: accountant,
      }),
    );
    expect(p).toMatchObject({
      entryDate: '2026-11-05',
      requestedDate: '2026-11-05',
      redirected: false,
      baseCurrency: 'AUD',
      total: '2200.0000',
    });
    expect(
      p.lines.map((l) => ({ code: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo })),
    ).toEqual([
      { code: '1010', debit: '0.0000', credit: '2200.0000', memo: 'BPAY Office Rent Pty' },
      { code: '6230', debit: '2200.0000', credit: '0.0000', memo: 'November rent' },
    ]);
    expect(p.lines.every((l) => l.accountName !== '' && l.accountType !== '')).toBe(true);
    expect(await written()).toEqual(before);
    expect((await lineBy('BPAY Office Rent Pty')).status).toBe('unmatched');

    // The post writes exactly the previewed lines.
    const r = await f.inTenant((trx) =>
      createTransactionFromLine(trx, {
        statementLineId: rent.id,
        lines: [{ account: { id: acct('6230') }, amount: '2200.00', memo: 'November rent' }],
        createdBy: accountant,
        settings: DEFAULT_SOD_SETTINGS,
      }),
    );
    const posted = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; memo: string | null }>`
            SELECT a.code, l.debit::text, l.credit::text, l.memo
              FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
             WHERE l.entry_id = ${r.entryId} ORDER BY l.line_no`.execute(trx)
        ).rows,
    );
    expect(posted).toEqual(
      p.lines.map((l) => ({ code: l.accountCode, debit: l.debit, credit: l.credit, memo: l.memo })),
    );
  });

  it('T-0150 AC-1 refuses what the post refuses: unbalanced lines, a control account and a matched line', async () => {
    const telstra = await lineBy('Telstra direct debit November, mobile');
    const before = await written();
    await expect(
      f.inTenant((trx) =>
        previewTransactionFromLine(trx, {
          statementLineId: telstra.id,
          lines: [{ account: { id: acct('6230') }, amount: '80.00' }],
          createdBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
    await expect(
      f.inTenant((trx) =>
        previewTransactionFromLine(trx, {
          statementLineId: telstra.id,
          lines: [{ account: { id: acct('2000') }, amount: '89.90' }],
          createdBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONTROL_ACCOUNT' });
    const fee = await lineBy('Account fee');
    await expect(
      f.inTenant((trx) =>
        previewTransactionFromLine(trx, {
          statementLineId: fee.id,
          lines: [{ account: { id: acct('6110') }, amount: '10.00' }],
          createdBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_MATCHED' });
    await expect(
      f.inTenant((trx) =>
        previewTransactionFromLine(trx, {
          statementLineId: telstra.id,
          createdBy: accountant,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION' });
    expect(await written()).toEqual(before);
  });
});
