/**
 * SS-PLAT-151 — lf_app may change only the ABA header of a company bank account in place
 * (T-0193, migration 0076, RQ-0176, ADR-0094): the APCA user id, ABA user name and FI mnemonic,
 * and not on an archived account. The BSB, account name, number columns, currency, GL account and
 * company stay immutable (a different number is a new account, migration 0013). Real PostgreSQL,
 * as lf_app inside a tenant transaction.
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './index.ts';
import type { Database } from './schema.ts';
import { withTenant } from './tenant.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

const T = '01900000-0000-7000-8000-000000019301';
let tdb: TestDatabase;
let db: Kysely<Database>;
let companyId = '';
let glId = '';
let otherGlId = '';
const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => withTenant(db, T, fn);

async function addAccount(name: string): Promise<string> {
  return inTenant(async (trx) => {
    const id = (await sql<{ id: string }>`SELECT app.uuid_generate_v7() AS id`.execute(trx)).rows[0]
      ?.id;
    if (!id) throw new Error('no id');
    await trx
      .insertInto('app.bank_account')
      .values({
        id,
        company_id: companyId,
        gl_account_id: glId,
        name,
        currency: 'AUD',
        bsb: '062-000',
        account_name: 'Harbour & Co Pty Ltd',
        account_number_last3: '678',
        account_number_ct: randomBytes(8),
        account_number_iv: randomBytes(12),
        account_number_tag: randomBytes(16),
        dek_wrapped: randomBytes(60),
        kek_id: 'k1',
        enc_version: 1,
      })
      .execute();
    return id;
  });
}

const aba = (id: string) =>
  inTenant((trx) =>
    trx
      .selectFrom('app.bank_account')
      .select(['apca_user_id', 'aba_user_name', 'aba_fi_mnemonic', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  db = createDb(tdb.url('lf_app'), 1);
  await inTenant(async (trx) => {
    await trx.insertInto('app.tenant').values({ id: T, name: 'Harbour & Co Pty Ltd' }).execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    companyId = c.id;
    const gl = async (code: string) =>
      (
        await trx
          .insertInto('app.account')
          .values({
            company_id: companyId,
            code,
            name: `Bank ${code}`,
            type: 'asset',
            subtype: 'bank',
            normal_balance: 'debit',
            currency: null,
            default_tax_code: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    glId = await gl('1010');
    otherGlId = await gl('1020');
  });
});

afterAll(async () => {
  await db.destroy();
  await tdb.close();
});

describe('SS-PLAT-151: only the ABA header of a company bank account is editable in place', () => {
  it('SS-PLAT-151 lf_app sets the APCA user id, ABA user name and FI mnemonic of an active account [T-0193]', async () => {
    const id = await addAccount('Operating');
    await inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ apca_user_id: '301500', aba_user_name: 'HARBOUR & CO', aba_fi_mnemonic: 'CBA' })
        .where('id', '=', id)
        .execute(),
    );
    expect(await aba(id)).toEqual({
      apca_user_id: '301500',
      aba_user_name: 'HARBOUR & CO',
      aba_fi_mnemonic: 'CBA',
      status: 'active',
    });
    // The database CHECKs still hold for the app role.
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.bank_account')
          .set({ apca_user_id: '12345' })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('SS-PLAT-151 the BSB, account name, number columns, currency, GL account and company stay immutable for lf_app [T-0193]', async () => {
    const [account] = await inTenant((trx) =>
      trx.selectFrom('app.bank_account').select('id').where('name', '=', 'Operating').execute(),
    );
    const id = account?.id ?? '';
    for (const [column, value] of [
      ['bsb', sql`'063-000'`],
      ['account_name', sql`'Someone Else'`],
      ['account_number_last3', sql`'999'`],
      ['account_number_ct', sql`'\\x00'::bytea`],
      ['account_number_iv', sql`decode(repeat('00', 12), 'hex')`],
      ['account_number_tag', sql`decode(repeat('00', 16), 'hex')`],
      ['dek_wrapped', sql`decode(repeat('00', 60), 'hex')`],
      ['kek_id', sql`'k2'`],
      ['currency', sql`'USD'`],
      ['gl_account_id', sql`${otherGlId}::uuid`],
      ['company_id', sql`company_id`],
      ['created_by', sql`NULL`],
    ] as const) {
      await expect(
        inTenant((trx) =>
          sql`UPDATE app.bank_account SET ${sql.ref(column)} = ${value} WHERE id = ${id}`.execute(
            trx,
          ),
        ),
        column,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('SS-PLAT-151 an archived account keeps its ABA details: changing them is refused [T-0193]', async () => {
    // The partial unique index allows one active account per GL account: archive the first one,
    // then add its replacement on the same GL account.
    await inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ status: 'archived' })
        .where('name', '=', 'Operating')
        .execute(),
    );
    const id = await addAccount('Replacement');
    const [old] = await inTenant((trx) =>
      trx.selectFrom('app.bank_account').select('id').where('name', '=', 'Operating').execute(),
    );
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.bank_account')
          .set({ apca_user_id: '999999' })
          .where('id', '=', old?.id ?? '')
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/archived/) });
    // Archiving and changing the details in the same statement is refused too.
    await expect(
      inTenant((trx) =>
        trx
          .updateTable('app.bank_account')
          .set({ status: 'archived', aba_user_name: 'NEW NAME' })
          .where('id', '=', id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await aba(old?.id ?? '')).toMatchObject({ apca_user_id: '301500', status: 'archived' });
    // A name change of an archived account is unaffected (grant of 0013).
    await inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ name: 'Operating (closed)' })
        .where('id', '=', old?.id ?? '')
        .execute(),
    );
  });
});
