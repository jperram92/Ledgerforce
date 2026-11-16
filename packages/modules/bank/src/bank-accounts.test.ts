/**
 * SS-PLAT-130 — the replay comparison of a company bank account create (T-0185, RQ-0166,
 * DL-0700, DL-0702): a stored, masked account and a create request are the same request when the
 * fields the row keeps in clear, and the last 3 characters of the number, are equal after the
 * module's own normalisation.
 */
import { describe, expect, it } from 'vitest';
import { sameCompanyBankAccount, type MaskedCompanyBankAccount } from './bank-accounts.ts';

const stored: MaskedCompanyBankAccount = {
  id: 'a',
  name: 'Operating',
  glAccountId: 'gl-1',
  currency: 'AUD',
  bsb: '062-000',
  accountName: 'Harbour & Co Pty Ltd',
  accountNumber: '***678',
  apcaUserId: '123456',
  abaUserName: 'HARBOUR CO',
  abaFiMnemonic: 'CBA',
  status: 'active',
};

const input = {
  glAccountId: 'gl-1',
  name: ' Operating ',
  bsb: '062 000',
  accountNumber: '1234 5678',
  accountName: 'Harbour & Co Pty Ltd ',
  currency: 'AUD',
  apcaUserId: '123456',
  abaUserName: 'HARBOUR CO',
  abaFiMnemonic: 'CBA',
};

describe('SS-PLAT-130: sameCompanyBankAccount', () => {
  it('SS-PLAT-130 the same request after normalisation is a replay [T-0185]', () => {
    expect(sameCompanyBankAccount(stored, input)).toBe(true);
    expect(sameCompanyBankAccount(stored, { ...input, bsb: '062-000' })).toBe(true);
  });

  it('SS-PLAT-130 any differing field is not a replay [T-0185]', () => {
    const variants = [
      { name: 'Payroll' },
      { bsb: '062-001' },
      { accountNumber: '12345679' },
      { accountName: 'Other Pty Ltd' },
      { currency: 'NZD' },
      { apcaUserId: '654321' },
      { abaUserName: 'OTHER' },
      { abaFiMnemonic: 'WBC' },
      { glAccountId: 'gl-2' },
    ];
    for (const v of variants)
      expect(sameCompanyBankAccount(stored, { ...input, ...v })).toBe(false);
  });

  it('SS-PLAT-130 missing optional ABA details equal stored nulls, and differ from stored values [T-0185]', () => {
    const bare = { ...stored, apcaUserId: null, abaUserName: null, abaFiMnemonic: null };
    const { apcaUserId: _a, abaUserName: _b, abaFiMnemonic: _c, ...noAba } = input;
    expect(sameCompanyBankAccount(bare, noAba)).toBe(true);
    expect(sameCompanyBankAccount(stored, noAba)).toBe(false);
  });

  it('SS-PLAT-130 an archived account is never a replay [T-0185]', () => {
    expect(sameCompanyBankAccount({ ...stored, status: 'archived' }, input)).toBe(false);
  });
});
