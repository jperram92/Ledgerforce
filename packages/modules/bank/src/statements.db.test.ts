/**
 * SS-UC08-02 — a statement imported twice creates no duplicate lines and says so; overlapping
 * statements add only their new lines (T-0058, UC-08 A1, RQ-0019).
 * SS-PLAT-39 — a company bank account is bound to an active bank GL account of the company; its
 * account number is envelope-encrypted and masked (design §4.1 step 4, §6.6, ADR-0018).
 * Real PostgreSQL, as lf_app inside withTenant.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BankAccountValidationError,
  createCompanyBankAccount,
  listCompanyBankAccounts,
  revealCompanyBankAccountNumber,
  setCsvMapping,
} from './bank-accounts.ts';
import { StatementParseError, validateCsvMapping, type CsvMapping } from './parse.ts';
import { importStatement, StatementImportError } from './statements.ts';

const T = '01900000-0000-7000-8000-000000000b58';
let tdb: TestDatabase;
let db: Kysely<Database>;
let su: Kysely<Database>;
let companyId: string;
let accounts: Map<string, string>;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const HARBOUR_CSV: CsvMapping = validateCsvMapping(
  JSON.parse(fixture('harbour-csv-mapping.json').toString('utf8')),
);
const gl = (code: string): string => {
  const id = accounts.get(code);
  if (!id) throw new Error(`no account ${code}`);
  return id;
};
const operating = {
  name: 'Operating',
  bsb: '062000',
  accountNumber: '12345678',
  accountName: 'Harbour & Co Pty Ltd',
  currency: 'AUD',
  apcaUserId: '301500',
  abaUserName: 'HARBOUR & CO',
  abaFiMnemonic: 'CBA',
};
const lineCount = async (bankAccountId: string): Promise<number> => {
  const r = await su
    .selectFrom('app.bank_statement_line')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('bank_account_id', '=', bankAccountId)
    .executeTakeFirstOrThrow();
  return Number.parseInt(r.n, 10);
};

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 4);
  su = createDb(tdb.url('superuser'), 1);
  ({ companyId, accounts } = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
    return { companyId: c.id, accounts: chart.accounts };
  }));
});

afterAll(async () => {
  await su.destroy();
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-39: Company bank account bound to a bank GL account, number encrypted', () => {
  it('creates the account on GL 1010; at rest the number is ciphertext; reads are masked', async () => {
    const id = await inTenant((trx) =>
      createCompanyBankAccount(trx, kms, companyId, { ...operating, glAccountId: gl('1010') }),
    );
    const raw = await su
      .selectFrom('app.bank_account')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    for (const [column, value] of Object.entries(raw)) {
      const text = Buffer.isBuffer(value)
        ? value.toString('latin1') + value.toString('hex')
        : JSON.stringify(value);
      expect(text, column).not.toContain('12345678');
    }
    expect(raw).toMatchObject({
      bsb: '062-000',
      account_number_last3: '678',
      apca_user_id: '301500',
      aba_fi_mnemonic: 'CBA',
      currency: 'AUD',
      status: 'active',
    });
    const list = await inTenant((trx) => listCompanyBankAccounts(trx, companyId));
    expect(list).toEqual([
      expect.objectContaining({ id, accountNumber: '***678', glAccountId: gl('1010') }),
    ]);
    expect(await inTenant((trx) => revealCompanyBankAccountNumber(trx, kms, id))).toBe('12345678');
  });

  it('refuses a GL account that is not an active asset of subtype bank', async () => {
    // 1200 Trade debtors: asset, subtype receivable, control account.
    await expect(
      inTenant((trx) =>
        createCompanyBankAccount(trx, kms, companyId, { ...operating, glAccountId: gl('1200') }),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/bank/) });
  });

  it('refuses a second active bank account on the same GL account', async () => {
    await expect(
      inTenant((trx) =>
        createCompanyBankAccount(trx, kms, companyId, { ...operating, glAccountId: gl('1010') }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a currency the GL account does not allow', async () => {
    await su
      .updateTable('app.account')
      .set({ currency: 'USD' })
      .where('id', '=', gl('1020'))
      .execute();
    try {
      await expect(
        inTenant((trx) =>
          createCompanyBankAccount(trx, kms, companyId, { ...operating, glAccountId: gl('1020') }),
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/currency/) });
    } finally {
      await su
        .updateTable('app.account')
        .set({ currency: null })
        .where('id', '=', gl('1020'))
        .execute();
    }
  });

  it('validates BSB, APCA user id, ABA user name and FI mnemonic in the service and the database', async () => {
    const bad = [
      { bsb: '06200' },
      { apcaUserId: '12345' },
      { abaUserName: 'Name with | pipe' },
      { abaUserName: 'X'.repeat(27) },
      { abaFiMnemonic: 'cba' },
      { accountNumber: '1234567890' },
      { currency: 'aud' },
    ];
    for (const b of bad) {
      await expect(
        inTenant((trx) =>
          createCompanyBankAccount(trx, kms, companyId, {
            ...operating,
            ...b,
            glAccountId: gl('1020'),
          }),
        ),
        JSON.stringify(b),
      ).rejects.toBeInstanceOf(BankAccountValidationError);
    }
    // The database holds the same rules even if the service is bypassed (superuser: no RLS,
    // no grants in the way, so only the CHECK constraints can refuse).
    for (const [column, value] of [
      ['bsb', '062000'],
      ['apca_user_id', '12345'],
      ['aba_user_name', 'bad|name'],
      ['aba_user_name', 'X'.repeat(27)],
      ['aba_fi_mnemonic', 'cb'],
      ['currency', 'aud'],
    ] as const) {
      await expect(
        sql`UPDATE app.bank_account SET ${sql.ref(column)} = ${value}`.execute(su),
        `${column}=${value}`,
      ).rejects.toMatchObject({ code: '23514' });
    }
    // ...and lf_app may not change the payment identity of an account in place at all.
    await expect(
      inTenant((trx) => sql`UPDATE app.bank_account SET apca_user_id = '999999'`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lf_app cannot delete a bank account, statement or line', async () => {
    for (const table of ['app.bank_account', 'app.bank_statement', 'app.bank_statement_line']) {
      await expect(
        inTenant((trx) => sql`DELETE FROM ${sql.table(table)}`.execute(trx)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('SS-UC08-02: Duplicate statement import detected', () => {
  let bankAccountId: string;

  beforeAll(async () => {
    bankAccountId = await inTenant(async (trx) => {
      const r = await trx
        .selectFrom('app.bank_account')
        .select('id')
        .where('gl_account_id', '=', gl('1010'))
        .executeTakeFirstOrThrow();
      return r.id;
    });
  });

  it('first import of the November OFX creates its 10 lines', async () => {
    const r = await inTenant((trx) =>
      importStatement(trx, {
        bankAccountId,
        content: fixture('harbour-2026-11.ofx'),
        fileName: 'harbour-2026-11.ofx',
      }),
    );
    expect(r).toMatchObject({
      outcome: 'imported',
      linesInFile: 10,
      linesCreated: 10,
      linesDuplicate: 0,
    });
    expect(await lineCount(bankAccountId)).toBe(10);
    const stmt = await su
      .selectFrom('app.bank_statement')
      .selectAll()
      .where('id', '=', r.statementId)
      .executeTakeFirstOrThrow();
    expect(stmt).toMatchObject({ format: 'ofx', lines_total: 10, currency: 'AUD' });
    expect(stmt.closing_balance).toBe('13394.4300');
    const lines = await su
      .selectFrom('app.bank_statement_line')
      .select(['line_no', 'posted_on', 'amount', 'description', 'bank_txn_id', 'dedupe_key'])
      .where('statement_id', '=', r.statementId)
      .orderBy('line_no')
      .execute();
    expect(lines[0]).toMatchObject({
      line_no: 1,
      amount: '1375.0000',
      description: 'Direct credit Acme Pty Ltd',
      dedupe_key: 'id:202611020001',
    });
  });

  it('importing the same file again creates nothing and tells the user', async () => {
    const r = await inTenant((trx) =>
      importStatement(trx, { bankAccountId, content: fixture('harbour-2026-11.ofx') }),
    );
    expect(r).toMatchObject({
      outcome: 'duplicate_file',
      linesCreated: 0,
      linesDuplicate: 10,
    });
    expect(r.message).toMatch(/already imported/);
    expect(await lineCount(bankAccountId)).toBe(10);
    const n = await su
      .selectFrom('app.bank_statement')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('bank_account_id', '=', bankAccountId)
      .executeTakeFirstOrThrow();
    expect(n.n).toBe('1');
  });

  it('the same transactions in another format (CAMT.053, CSV) are recognised as duplicates', async () => {
    for (const [file, csv] of [
      ['harbour-2026-11.camt053.xml', undefined],
      ['harbour-2026-11.csv', HARBOUR_CSV],
      ['harbour-2026-11.v2.ofx', undefined],
    ] as const) {
      const r = await inTenant((trx) =>
        importStatement(trx, { bankAccountId, content: fixture(file), csvMapping: csv }),
      );
      expect(r, file).toMatchObject({
        outcome: 'duplicate_lines',
        linesInFile: 10,
        linesCreated: 0,
        linesDuplicate: 10,
      });
      expect(r.message).toMatch(/10 .*already imported/);
    }
    expect(await lineCount(bankAccountId)).toBe(10);
  });

  it('overlapping CSVs without bank ids add only the new lines and keep identical twins', async () => {
    const saver = await inTenant((trx) =>
      createCompanyBankAccount(trx, kms, companyId, {
        ...operating,
        name: 'Saver',
        accountNumber: '99887766',
        glAccountId: gl('1020'),
      }),
    );
    const mapping: CsvMapping = {
      header: false,
      dateFormat: 'YYYY-MM-DD',
      columns: { date: 0, amount: 1, description: [2] },
    };
    await inTenant((trx) => setCsvMapping(trx, saver, mapping));
    const rows = [
      '2026-11-01,100.00,Opening deposit',
      '2026-11-03,-4.50,Coffee',
      '2026-11-03,-4.50,Coffee',
      '2026-11-04,-20.00,Fuel',
      '2026-11-05,-9.99,Streaming',
      '2026-11-06,250.00,Refund',
    ];
    const first = await inTenant((trx) =>
      importStatement(trx, {
        bankAccountId: saver,
        content: Buffer.from(rows.slice(0, 4).join('\n')),
        format: 'csv',
      }),
    );
    expect(first).toMatchObject({ outcome: 'imported', linesCreated: 4, linesDuplicate: 0 });
    // The second export overlaps on both coffees and the fuel, and adds two lines.
    const second = await inTenant((trx) =>
      importStatement(trx, {
        bankAccountId: saver,
        content: Buffer.from(rows.slice(1).join('\r\n') + '\r\n'),
        format: 'csv',
      }),
    );
    expect(second).toMatchObject({
      outcome: 'imported',
      linesInFile: 5,
      linesCreated: 2,
      linesDuplicate: 3,
    });
    expect(second.message).toMatch(/2 new.*3 .*already imported/);
    const stored = await su
      .selectFrom('app.bank_statement_line')
      .select(['description', 'amount'])
      .where('bank_account_id', '=', saver)
      .orderBy('posted_on')
      .orderBy('line_no')
      .execute();
    expect(stored.map((s) => s.description)).toEqual([
      'Opening deposit',
      'Coffee',
      'Coffee',
      'Fuel',
      'Streaming',
      'Refund',
    ]);
    // A third export with a third identical coffee adds exactly that one.
    const third = await inTenant((trx) =>
      importStatement(trx, {
        bankAccountId: saver,
        content: Buffer.from([rows[1], rows[1], rows[1]].join('\n')),
        format: 'csv',
      }),
    );
    expect(third).toMatchObject({ linesCreated: 1, linesDuplicate: 2 });
  });

  it('two concurrent imports of the same new file: one imports, the other is told it is a duplicate', async () => {
    const fresh = await inTenant(async (trx) => {
      const gl1030 = await trx
        .insertInto('app.account')
        .values({
          company_id: companyId,
          code: '1030',
          name: 'Card clearing',
          type: 'asset',
          subtype: 'bank',
          normal_balance: 'debit',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return createCompanyBankAccount(trx, kms, companyId, {
        ...operating,
        name: 'Card clearing',
        accountNumber: '55500011',
        glAccountId: gl1030.id,
      });
    });
    const content = Buffer.from('2026-11-01,1.00,A\n2026-11-02,2.00,B\n');
    const mapping: CsvMapping = {
      header: false,
      dateFormat: 'YYYY-MM-DD',
      columns: { date: 0, amount: 1, description: [2] },
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        inTenant((trx) =>
          importStatement(trx, { bankAccountId: fresh, content, csvMapping: mapping }),
        ),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate_file', 'imported']);
    expect(await lineCount(fresh)).toBe(2);
  });

  it('refuses a file for another account, a broken balance or an unreadable file, writing nothing', async () => {
    const before = await lineCount(bankAccountId);
    const otherAccount = fixture('harbour-2026-11.ofx')
      .toString('latin1')
      .replace('<ACCTID>12345678', '<ACCTID>12345999');
    await expect(
      inTenant((trx) =>
        importStatement(trx, { bankAccountId, content: Buffer.from(otherAccount, 'latin1') }),
      ),
    ).rejects.toThrow(/account/);
    const badBalance = fixture('harbour-2026-11.camt053.xml')
      .toString('utf8')
      .replace('13394.43', '13394.44');
    await expect(
      inTenant((trx) =>
        importStatement(trx, { bankAccountId, content: Buffer.from(badBalance, 'utf8') }),
      ),
    ).rejects.toBeInstanceOf(StatementImportError);
    await expect(
      inTenant((trx) =>
        importStatement(trx, {
          bankAccountId,
          content: Buffer.from('<OFX><CURDEF>AUD<STMTTRN><DTPOSTED>2026<TRNAMT>1</STMTTRN></OFX>'),
        }),
      ),
    ).rejects.toBeInstanceOf(StatementParseError);
    await expect(
      inTenant((trx) =>
        importStatement(trx, { bankAccountId, content: Buffer.from('a,b\n'), format: 'csv' }),
      ),
    ).rejects.toThrow(/mapping/);
    expect(await lineCount(bankAccountId)).toBe(before);
  });

  it('lf_app cannot rewrite an imported line (only its status may change)', async () => {
    await expect(
      inTenant((trx) => sql`UPDATE app.bank_statement_line SET amount = 0`.execute(trx)),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant((trx) =>
        sql`UPDATE app.bank_statement_line SET status = 'excluded' WHERE false`.execute(trx),
      ),
    ).resolves.toBeDefined();
  });
});
