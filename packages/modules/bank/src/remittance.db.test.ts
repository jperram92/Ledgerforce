/**
 * ADR-0079 control 1 and 4 (T-0180, RQ-0150): remittanceDetailsOf decrypts only the company's
 * designated remittance account, and only when one is set and still active. Every other account
 * stays sealed, and the read APIs stay masked. Real PostgreSQL as lf_app, real envelope sealing
 * with a counting KMS so the test sees exactly which numbers were unwrapped.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { approveRemittanceAccountChange, requestRemittanceAccountChange } from '@ledgerforce/ar';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms, type Kms } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanyBankAccount, listCompanyBankAccounts } from './bank-accounts.ts';
import { remittanceDetailsOf } from './remittance.ts';

const keyring = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);
/** Records the AAD of every unwrap: the AAD names the bank account row (ADR-0018). */
const unwrapped: string[] = [];
const kms: Kms = {
  activeKeyId: keyring.activeKeyId,
  wrap: (dek, aad) => keyring.wrap(dek, aad),
  unwrap: (wrapped, keyId, aad) => {
    unwrapped.push(aad);
    return keyring.unwrap(wrapped, keyId, aad);
  },
};

let f: LedgerFixture;
let operating = '';
let reserve = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018011');
  await f.inTenant(async (trx) => {
    operating = await createCompanyBankAccount(trx, kms, f.companyId, {
      glAccountId: f.acct['1010'] ?? '',
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
    });
    reserve = await createCompanyBankAccount(trx, kms, f.companyId, {
      glAccountId: f.acct['1020'] ?? '',
      name: 'Reserve',
      bsb: '083-004',
      accountNumber: '99887766',
      accountName: 'Harbour Reserve',
      currency: 'AUD',
    });
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

async function designate(bankAccountId: string | null): Promise<void> {
  const maker = await f.addUser('finance_admin');
  const checker = await f.addUser('owner');
  const changeId = randomUUID();
  await f.inTenant((trx) =>
    requestRemittanceAccountChange(trx, {
      companyId: f.companyId,
      changeId,
      bankAccountId,
      requestedBy: maker,
    }),
  );
  await f.inTenant((trx) =>
    approveRemittanceAccountChange(trx, { companyId: f.companyId, changeId, approvedBy: checker }),
  );
}

describe('T-0180 ADR-0079: only the designated remittance account is decrypted', () => {
  it('AC-2 without a designated account nothing is decrypted [T-0180]', async () => {
    unwrapped.length = 0;
    expect(await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId))).toBeNull();
    expect(unwrapped).toEqual([]);
  });

  it('AC-2 the designated account is decrypted, and no other; reads stay masked [T-0180]', async () => {
    await designate(reserve);
    unwrapped.length = 0;
    const d = await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId));
    expect(d).toEqual({
      bankAccountId: reserve,
      accountName: 'Harbour Reserve',
      bsb: '083-004',
      accountNumber: '99887766',
      currency: 'AUD',
    });
    expect(unwrapped).toHaveLength(1);
    expect(unwrapped[0]).toContain(`|${reserve}|account_number`);
    expect(unwrapped.join()).not.toContain(operating);
    const listed = await f.inTenant((trx) => listCompanyBankAccounts(trx, f.companyId));
    expect(listed.map((a) => a.accountNumber).sort()).toEqual(['***678', '***766']);
  });

  it('AC-2 another company, another currency, or an archived designated account, decrypts nothing [T-0180]', async () => {
    unwrapped.length = 0;
    expect(
      await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId, { currency: 'USD' })),
    ).toBeNull();
    expect(await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.otherCompanyId))).toBeNull();
    await f.inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ status: 'archived' })
        .where('id', '=', reserve)
        .execute(),
    );
    expect(await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId))).toBeNull();
    expect(unwrapped).toEqual([]);
  });
});

/**
 * SS-UC01-18 (T-0191, ADR-0086, RQ-0168, security review r8 L1): archiving the designated account
 * releases the designation, so re-activating it prints nothing until a new change is approved.
 */
describe('SS-UC01-18: an archived remittance account needs a new approval to print again', () => {
  const designated = async (): Promise<string | null> => {
    const r = await f.admin.query<{ id: string | null }>(
      'SELECT remittance_bank_account_id AS id FROM app.ar_settings WHERE tenant_id = $1 AND company_id = $2',
      [f.tenantId, f.companyId],
    );
    return r.rows[0]?.id ?? null;
  };
  const setStatus = (id: string, status: 'active' | 'archived') =>
    f.inTenant((trx) =>
      trx.updateTable('app.bank_account').set({ status }).where('id', '=', id).execute(),
    );
  const sqlState = (p: Promise<unknown>): Promise<string | undefined> =>
    p.then(
      () => undefined,
      (e: unknown) => (e as { code?: string }).code ?? String(e),
    );

  it('SS-UC01-18 archiving releases the designation; re-activating prints nothing; a new approval prints again [T-0191]', async () => {
    await designate(operating);
    expect(await designated()).toBe(operating);
    await setStatus(operating, 'archived');
    expect(await designated()).toBeNull();
    const audit = await f.admin.query<{ after: string; actor_type: string }>(
      `SELECT after::text AS after, actor_type FROM audit.audit_log
        WHERE tenant_id = $1 AND action = 'remittance_account.released' AND entity_id = $2
          AND after -> 'bank_account' ->> 'id' = $3`,
      [f.tenantId, f.companyId, operating],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_type).toBe('system');
    expect(audit.rows[0]?.after).toContain('***678');
    expect(audit.rows[0]?.after).not.toContain('12345678');

    await setStatus(operating, 'active');
    unwrapped.length = 0;
    expect(await designated()).toBeNull();
    expect(await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId))).toBeNull();
    expect(unwrapped).toEqual([]);

    await designate(operating);
    const d = await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId));
    expect(d?.bankAccountId).toBe(operating);
    expect(d?.accountNumber).toBe('12345678');
  });

  it('SS-UC01-18 a designation left on an archived account by an older schema is released on re-activation [T-0191]', async () => {
    expect(await designated()).toBe(operating);
    // Migration 0071 kept the designation while archived: reproduce that state as a superuser
    // seed step with triggers off (lf_app cannot do this).
    const client = await f.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE app.bank_account SET status = 'archived' WHERE id = $1`, [
        operating,
      ]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await designated()).toBe(operating);
    await setStatus(operating, 'active');
    expect(await designated()).toBeNull();
    expect(await f.inTenant((trx) => remittanceDetailsOf(trx, kms, f.companyId))).toBeNull();
  });

  it('SS-UC01-18 the database refuses to designate an archived account, even with an approved change [T-0191]', async () => {
    const maker = await f.addUser('finance_admin');
    const checker = await f.addUser('owner');
    const changeId = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId,
        bankAccountId: operating,
        requestedBy: maker,
      }),
    );
    await setStatus(operating, 'archived');
    // Bypass the module: approve and write the setting directly, in one transaction.
    expect(
      await sqlState(
        f.inTenant(async (trx) => {
          await trx
            .updateTable('app.remittance_account_change')
            .set({ status: 'approved', decided_by: checker, decided_at: new Date() })
            .where('id', '=', changeId)
            .execute();
          await trx
            .insertInto('app.ar_settings')
            .values({ company_id: f.companyId, remittance_bank_account_id: operating })
            .onConflict((oc) =>
              oc
                .columns(['tenant_id', 'company_id'])
                .doUpdateSet({ remittance_bank_account_id: operating }),
            )
            .execute();
        }),
      ),
    ).toBe('23514');
    expect(await designated()).toBeNull();
    await setStatus(operating, 'active');
  });
});
