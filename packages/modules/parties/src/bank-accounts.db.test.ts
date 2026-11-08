/**
 * SS-PLAT-22 — bank details are encrypted at rest and masked on read (T-0037, design §4.2,
 * §6.6, ADR-0018). Only the account number is secret; BSB and account name stay in clear for
 * ABA files (RQ-0006). Reads are masked to the last 3 characters; decryption is one explicit
 * call reserved for payment files (T-0054).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { DecryptionError, LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addBankAccount,
  BankAccountValidationError,
  listBankAccounts,
  revealAccountNumber,
} from './bank-accounts.ts';
import { createParty } from './parties.ts';

const T = '01900000-0000-7000-8000-000000000aaa';
let tdb: TestDatabase;
let db: Kysely<Database>;
let su: Kysely<Database>;
let companyId: string;
let supplier: string;
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 2);
  su = createDb(tdb.url('superuser'), 1);
  ({ companyId, supplier } = await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const s = await createParty(trx, c.id, {
      legalName: 'Office Supplies Pty Ltd',
      roles: ['supplier'],
    });
    return { companyId: c.id, supplier: s };
  }));
});

afterAll(async () => {
  await su.destroy();
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-22: Bank details encrypted and masked', () => {
  it('stores ciphertext at rest: no column of the stored row contains the account number', async () => {
    const id = await inTenant((trx) =>
      addBankAccount(trx, kms, companyId, supplier, {
        bsb: '062000',
        accountNumber: '123456789',
        accountName: 'Office Supplies',
        source: 'ui',
      }),
    );
    const raw = await su
      .selectFrom('app.party_bank_account')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    for (const [column, value] of Object.entries(raw)) {
      const text = Buffer.isBuffer(value)
        ? value.toString('latin1') + value.toString('hex')
        : String(value);
      expect(text, column).not.toContain('123456789');
    }
    expect(raw.bsb).toBe('062-000');
    expect(raw.account_number_last3).toBe('789');
    const dump = await sql<{
      t: string;
    }>`SELECT x::text AS t FROM app.party_bank_account x WHERE id = ${id}`.execute(su);
    expect(dump.rows[0]?.t).not.toContain('123456789');
  });

  it('reads are masked to the last 3 characters; only revealAccountNumber decrypts', async () => {
    const list = await inTenant((trx) => listBankAccounts(trx, supplier));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      bsb: '062-000',
      accountName: 'Office Supplies',
      accountNumber: '***789',
      status: 'pending_verification',
    });
    expect(JSON.stringify(list)).not.toContain('123456789');
    const id = list[0]?.id ?? '';
    expect(await inTenant((trx) => revealAccountNumber(trx, kms, id))).toBe('123456789');
  });

  it("a ciphertext copied onto another party's row cannot be decrypted there", async () => {
    const other = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Other Supplier', roles: ['supplier'] }),
    );
    const victim = await inTenant((trx) =>
      addBankAccount(trx, kms, companyId, other, {
        bsb: '033-000',
        accountNumber: '555000111',
        accountName: 'Other',
        source: 'ui',
      }),
    );
    const [source] = await inTenant((trx) => listBankAccounts(trx, supplier));
    await sql`
      UPDATE app.party_bank_account v
         SET account_number_ct = s.account_number_ct, account_number_iv = s.account_number_iv,
             account_number_tag = s.account_number_tag, dek_wrapped = s.dek_wrapped, kek_id = s.kek_id
        FROM app.party_bank_account s
       WHERE v.id = ${victim} AND s.id = ${source?.id ?? ''}`.execute(su);
    await expect(inTenant((trx) => revealAccountNumber(trx, kms, victim))).rejects.toBeInstanceOf(
      DecryptionError,
    );
    expect(await inTenant((trx) => revealAccountNumber(trx, kms, source?.id ?? ''))).toBe(
      '123456789',
    );
  });

  it('lf_app cannot rewrite the encrypted columns; only the status may change', async () => {
    const [acct] = await inTenant((trx) => listBankAccounts(trx, supplier));
    await expect(
      inTenant((trx) =>
        sql`UPDATE app.party_bank_account SET account_number_last3 = '000' WHERE id = ${acct?.id ?? ''}`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      inTenant((trx) =>
        sql`DELETE FROM app.party_bank_account WHERE id = ${acct?.id ?? ''}`.execute(trx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await inTenant((trx) =>
      sql`UPDATE app.party_bank_account SET status = 'archived' WHERE id = ${acct?.id ?? ''}`.execute(
        trx,
      ),
    );
  });

  it('bank details are never sourced from Salesforce', async () => {
    await expect(
      inTenant((trx) =>
        addBankAccount(trx, kms, companyId, supplier, {
          bsb: '062-000',
          accountNumber: '111222333',
          accountName: 'X',
          // Deliberately outside the type: proves the database refuses it too.
          source: 'salesforce' as 'ui',
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('only suppliers and employees hold bank details; formats follow ABA rules (RQ-0006)', async () => {
    const customer = await inTenant((trx) =>
      createParty(trx, companyId, { legalName: 'Customer Only', roles: ['customer'] }),
    );
    await expect(
      inTenant((trx) =>
        addBankAccount(trx, kms, companyId, customer, {
          bsb: '062-000',
          accountNumber: '123456',
          accountName: 'C',
          source: 'ui',
        }),
      ),
    ).rejects.toThrow(/supplier or employee/);
    for (const [bsb, accountNumber] of [
      ['06200', '123456'],
      ['062-000', '1234567890'],
      ['062-000', '12 34!'],
    ]) {
      await expect(
        inTenant((trx) =>
          addBankAccount(trx, kms, companyId, supplier, {
            bsb: bsb ?? '',
            accountNumber: accountNumber ?? '',
            accountName: 'S',
            source: 'ui',
          }),
        ),
        `${bsb ?? ''}/${accountNumber ?? ''}`,
      ).rejects.toBeInstanceOf(BankAccountValidationError);
    }
  });
});
