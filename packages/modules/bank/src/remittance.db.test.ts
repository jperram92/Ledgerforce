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
