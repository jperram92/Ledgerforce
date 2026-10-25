/**
 * SS-PLAT-54 (db) — CAMT batch entries and multi-statement files import correctly (T-0059,
 * RQ-0028, design §5.7, UC-08): a batch is stored as its parts with the entry reference kept,
 * adding up exactly to the booked amount; each statement of a multi-account file lands on its own
 * bank account, atomically; duplicate detection holds across re-imports; camt.054 and a file
 * naming an unknown account are refused with nothing written.
 * Real PostgreSQL, as lf_app inside withTenant.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyBankAccount } from './bank-accounts.ts';
import { StatementParseError } from './parse.ts';
import { importStatement, importStatementFile, StatementImportError } from './statements.ts';

const T = '01900000-0000-7000-8000-000000000b59';
let tdb: TestDatabase;
let db: Kysely<Database>;
let su: Kysely<Database>;
let companyId: string;
let operatingId: string;
let savingsId: string;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
/** The same statement re-exported by the bank: new message id, same entries. */
const reexport = (bytes: Buffer, from: string, to: string): Buffer => {
  const text = bytes.toString('utf8');
  if (!text.includes(from)) throw new Error(`fixture has no ${from}`);
  return Buffer.from(text.replace(from, to), 'utf8');
};
const BATCH = 'harbour-2026-12-batch.camt053.xml';
const TWO = 'harbour-2027-01-02-two-accounts.camt053.xml';

const linesOf = (bankAccountId: string) =>
  su
    .selectFrom('app.bank_statement_line')
    .select(['line_no', 'posted_on', 'amount', 'reference', 'bank_txn_id', 'entry_ref', 'entry_tx_no'])
    .where('bank_account_id', '=', bankAccountId)
    .orderBy('created_at')
    .orderBy('line_no')
    .execute();
const statementsWithSha = (sha: string) =>
  su
    .selectFrom('app.bank_statement')
    .select(['bank_account_id', 'lines_total', 'format'])
    .where('file_sha256', '=', sha)
    .execute();
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 4);
  su = createDb(tdb.url('superuser'), 1);
  ({ companyId, operatingId, savingsId } = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
    const gl = (code: string) => chart.accounts.get(code) ?? '';
    const base = { bsb: '062000', accountName: 'Harbour & Co Pty Ltd', currency: 'AUD' };
    const op = await createCompanyBankAccount(trx, kms, c.id, {
      ...base,
      name: 'Operating',
      accountNumber: '12345678',
      glAccountId: gl('1010'),
    });
    const sv = await createCompanyBankAccount(trx, kms, c.id, {
      ...base,
      name: 'Business saver',
      accountNumber: '87654321',
      glAccountId: gl('1020'),
    });
    return { companyId: c.id, operatingId: op, savingsId: sv };
  }));
});

afterAll(async () => {
  await su.destroy();
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-54: CAMT batch entries and multi-statement files (db)', () => {
  it('a batch entry is stored as its parts, with the entry reference, adding up to the booked amount', async () => {
    const r = await inTenant((trx) =>
      importStatement(trx, { bankAccountId: operatingId, content: fixture(BATCH) }),
    );
    expect(r).toMatchObject({ outcome: 'imported', linesInFile: 7, linesCreated: 7 });
    const rows = await linesOf(operatingId);
    expect(
      rows.map((x) => [x.line_no, x.amount, x.reference, x.bank_txn_id, x.entry_ref, x.entry_tx_no]),
    ).toEqual([
      [1, '1000.0000', 'INV-000130', 'BPAY-778201', '202612020001', 1],
      [2, '450.0000', 'INV-000131', null, '202612020001', 2],
      [3, '200.0000', null, null, '202612020001', 3],
      [4, '-25.0000', null, '202612020002', null, null],
      [5, '-99.9000', null, '202612100003', null, null],
      [6, '-600.0000', 'PAY-0042', null, '202612150004', 1],
      [7, '100.0000', 'PAY-0043', null, '202612150004', 2],
    ]);
    const sum = await su
      .selectFrom('app.bank_statement_line')
      .select((eb) => eb.fn.sum<string>('amount').as('total'))
      .where('entry_ref', '=', '202612020001')
      .executeTakeFirstOrThrow();
    expect(sum.total).toBe('1650.0000');
  });

  it('re-importing the batch file, or a re-export of it, adds nothing', async () => {
    const again = await inTenant((trx) =>
      importStatement(trx, { bankAccountId: operatingId, content: fixture(BATCH) }),
    );
    expect(again).toMatchObject({ outcome: 'duplicate_file', linesCreated: 0 });
    const re = await inTenant((trx) =>
      importStatement(trx, {
        bankAccountId: operatingId,
        content: reexport(fixture(BATCH), 'HARBOUR-20270101', 'HARBOUR-20270101-R2'),
      }),
    );
    expect(re).toMatchObject({ outcome: 'duplicate_lines', linesCreated: 0, linesDuplicate: 7 });
    expect(await linesOf(operatingId)).toHaveLength(7);
  });

  it('the single-account import refuses a multi-statement file and points to the file import', async () => {
    await expect(
      inTenant((trx) => importStatement(trx, { bankAccountId: operatingId, content: fixture(TWO) })),
    ).rejects.toThrow(/2 statements/);
  });

  it('a file naming an unknown account is refused as a whole: nothing is written', async () => {
    const content = reexport(fixture(TWO), '062000-87654321', '062000-55555999');
    await expect(
      inTenant((trx) => importStatementFile(trx, { companyId, content })),
    ).rejects.toThrow(/statement 2 .*062000-55555999.*no bank account/);
    expect(await statementsWithSha(sha256(content))).toEqual([]);
    expect(await linesOf(operatingId)).toHaveLength(7);
    expect(await linesOf(savingsId)).toHaveLength(0);
  });

  it('each statement of a multi-account file lands on its own bank account', async () => {
    const r = await inTenant((trx) =>
      importStatementFile(trx, { companyId, content: fixture(TWO), fileName: TWO }),
    );
    expect(r.outcome).toBe('imported');
    expect(r.statements.map((s) => [s.bankAccountId, s.outcome, s.linesCreated])).toEqual([
      [operatingId, 'imported', 2],
      [savingsId, 'imported', 2],
    ]);
    expect(r.message).toMatch(/Operating.*2 new lines.*Business saver.*2 new lines/);
    const stored = await statementsWithSha(sha256(fixture(TWO)));
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((s) => s.bank_account_id))).toEqual(new Set([operatingId, savingsId]));
    expect((await linesOf(savingsId)).map((x) => x.amount)).toEqual(['-1000.0000', '41.1000']);
    const op = await linesOf(operatingId);
    expect(op.slice(7).map((x) => [x.amount, x.entry_ref, x.entry_tx_no])).toEqual([
      ['120.0000', '202701020001', 1],
      ['180.0000', '202701020001', 2],
    ]);
  });

  it('re-importing the multi-account file adds nothing on either account', async () => {
    const r = await inTenant((trx) => importStatementFile(trx, { companyId, content: fixture(TWO) }));
    expect(r.outcome).toBe('duplicate_file');
    expect(r.statements.map((s) => s.outcome)).toEqual(['duplicate_file', 'duplicate_file']);
    const re = await inTenant((trx) =>
      importStatementFile(trx, {
        companyId,
        content: reexport(fixture(TWO), 'HARBOUR-20270103', 'HARBOUR-20270103-R2'),
      }),
    );
    expect(re.outcome).toBe('duplicate_lines');
    expect(re.statements.map((s) => s.linesDuplicate)).toEqual([2, 2]);
    expect(await linesOf(operatingId)).toHaveLength(9);
    expect(await linesOf(savingsId)).toHaveLength(2);
  });

  it('the same account twice in one file is refused', async () => {
    const content = reexport(fixture(TWO), '062000-87654321', '062000-12345678');
    await expect(
      inTenant((trx) => importStatementFile(trx, { companyId, content })),
    ).rejects.toThrow(/statements 1 and 2 .*same bank account/);
  });

  it('camt.052 and camt.054 are refused by both imports, writing nothing', async () => {
    for (const name of ['harbour-2027-01-04.camt052.xml', 'harbour-2027-01-04.camt054.xml']) {
      const content = fixture(name);
      await expect(
        inTenant((trx) => importStatement(trx, { bankAccountId: operatingId, content })),
        name,
      ).rejects.toBeInstanceOf(StatementParseError);
      await expect(
        inTenant((trx) => importStatementFile(trx, { companyId, content })),
        name,
      ).rejects.toThrow(/camt\.05[24].*camt\.053/);
      expect(await statementsWithSha(sha256(content)), name).toEqual([]);
    }
  });

  it('the file import accepts only camt.053 (other formats name no account reliably)', async () => {
    await expect(
      inTenant((trx) =>
        importStatementFile(trx, { companyId, content: fixture('harbour-2026-11.ofx') }),
      ),
    ).rejects.toBeInstanceOf(StatementImportError);
  });
});
