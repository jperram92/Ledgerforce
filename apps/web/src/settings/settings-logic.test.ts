/** Wording and small form helpers of the setup settings screens (T-0176, SS-PLAT-129). */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import {
  abnText,
  bankCurrencyFor,
  bankNumberText,
  bankRefusal,
  companyRefusal,
  dayText,
  fiscalStart,
  percentOf,
  REMOVE_REMITTANCE,
  remittanceChoices,
  remittanceRefusal,
  remittanceText,
  taxRefusal,
} from './settings-logic.ts';

describe('T-0176 settings logic', () => {
  it('formats API dates as Australian days without shifting the day', () => {
    expect(dayText('2026-07-01')).toBe('1 Jul 2026');
    expect(dayText('2027-06-30')).toBe('30 Jun 2027');
  });

  it('groups an ABN the way the ABN register prints it', () => {
    expect(abnText('51824753556')).toBe('51 824 753 556');
    expect(abnText('123')).toBe('123');
  });

  it('builds the first day of a fiscal year from a month and a year, or null', () => {
    expect(fiscalStart('7', '2026')).toBe('2026-07-01');
    expect(fiscalStart('12', ' 2026 ')).toBe('2026-12-01');
    expect(fiscalStart('7', '26')).toBeNull();
    expect(fiscalStart('13', '2026')).toBeNull();
    expect(fiscalStart('', '2026')).toBeNull();
  });

  it('shows a tax rate decimal string as a percentage by moving the point, never through a number', () => {
    expect(percentOf('0.10000000')).toBe('10%');
    expect(percentOf('0.00000000')).toBe('0%');
    expect(percentOf('0.12500000')).toBe('12.5%');
    expect(percentOf('0.00125000')).toBe('0.125%');
    expect(percentOf('not a rate')).toBe('not a rate');
  });

  it('says the company refusals in plain words', () => {
    expect(companyRefusal(new AdminApiError(422, { error: 'INVALID_ABN' }))).toMatch(
      /does not pass the ABN check/,
    );
    expect(companyRefusal(new AdminApiError(409, { error: 'BASE_CURRENCY_LOCKED' }))).toMatch(
      /already has journal entries/,
    );
    expect(
      companyRefusal(
        new AdminApiError(409, { error: 'FISCAL_YEAR_OVERLAP', message: 'would overlap FY2027' }),
      ),
    ).toMatch(/would overlap a financial year the company already has/);
    expect(
      companyRefusal(
        new AdminApiError(400, { error: 'invalid_request', message: 'abn must be 11 digits' }),
      ),
    ).toMatch(/ABN must be 11 digits/);
    expect(companyRefusal(new Error('boom'))).toBeNull();
  });

  it('says the tax refusals in plain words', () => {
    expect(
      taxRefusal(
        new AdminApiError(400, {
          error: 'INVALID_TAX_SETTINGS',
          message: 'effectiveFrom must be the 1st of a month (YYYY-MM-01)',
        }),
      ),
    ).toMatch(/Choose the month the settings apply from/);
    expect(taxRefusal(new Error('boom'))).toBeNull();
  });
});

describe('T-0185 bank accounts logic (SS-PLAT-130)', () => {
  it('SS-PLAT-130 says a masked number in words and never shows more than the API gave', () => {
    expect(bankNumberText('***678')).toBe('ending 678');
    expect(bankNumberText('12345678')).toBe('ending 678');
    expect(bankNumberText('')).toBe('not shown');
  });

  it('SS-PLAT-130 defaults the currency to the GL account’s, else the base currency', () => {
    expect(bankCurrencyFor({ currency: 'USD' }, 'AUD')).toBe('USD');
    expect(bankCurrencyFor({ currency: null }, 'AUD')).toBe('AUD');
    expect(bankCurrencyFor(undefined, 'AUD')).toBe('AUD');
  });

  it('SS-PLAT-130 turns the bank account refusals into plain words', () => {
    const e = (status: number, error: string, message = '') =>
      new AdminApiError(status, { error, message });
    expect(bankRefusal(e(409, 'GL_ACCOUNT_IN_USE', 'x'))).toMatch(
      /already has a bank account.*Choose another GL account/,
    );
    expect(bankRefusal(e(422, 'GL_ACCOUNT_NOT_BANK'))).toMatch(/bank account in the chart/);
    expect(bankRefusal(e(503, 'kms_not_configured'))).toMatch(/cannot store bank account numbers/);
    expect(bankRefusal(e(404, 'UNKNOWN_GL_ACCOUNT'))).toMatch(/no longer in the chart/);
    expect(bankRefusal(e(400, 'invalid_request', 'BSB must be 6 digits, got "06200"'))).toBe(
      'BSB must be 6 digits, got "06200".',
    );
    expect(bankRefusal(new Error('x'))).toBeNull();
    expect(bankRefusal(e(500, 'boom'))).toBeNull();
  });

  it('SS-PLAT-153 turns the ABA change and archive refusals into plain words [T-0193]', () => {
    const e = (status: number, error: string) => new AdminApiError(status, { error, message: 'x' });
    expect(bankRefusal(e(409, 'BANK_ACCOUNT_ARCHIVED'))).toMatch(
      /archived, so its ABA details cannot change.*new bank account/,
    );
    expect(bankRefusal(e(404, 'UNKNOWN_BANK_ACCOUNT'))).toMatch(
      /no longer one of this company’s accounts/,
    );
  });
});

describe('T-0183 remittance account logic (SS-PLAT-149)', () => {
  const operating = {
    id: 'a1',
    name: 'Operating',
    bsb: '062-000',
    account_name: 'Harbour & Co Pty Ltd',
    account_number: '***678',
    currency: 'AUD',
    status: 'active',
  };

  it('SS-PLAT-149 names a remittance account by its BSB and last 3 digits only', () => {
    expect(remittanceText(operating)).toBe('Operating: BSB 062-000, account ending 678');
    expect(remittanceText({ ...operating, account_number: '12345678' })).toBe(
      'Operating: BSB 062-000, account ending 678',
    );
    expect(remittanceText(null)).toBe('no remittance account');
  });

  it('SS-PLAT-149 offers active accounts other than the one in force, and removal when one is', () => {
    const reserve = { ...operating, id: 'a2', name: 'Reserve', account_number: '***321' };
    const old = { ...operating, id: 'a3', name: 'Old', status: 'archived' };
    expect(remittanceChoices([operating, reserve, old], null)).toEqual([
      { value: 'a1', label: 'Operating: BSB 062-000, account ending 678' },
      { value: 'a2', label: 'Reserve: BSB 062-000, account ending 321' },
    ]);
    expect(remittanceChoices([operating, reserve, old], 'a1')).toEqual([
      { value: 'a2', label: 'Reserve: BSB 062-000, account ending 321' },
      { value: REMOVE_REMITTANCE, label: 'None: remove the remittance account' },
    ]);
  });

  it('SS-PLAT-149 turns the remittance refusals into plain words', () => {
    const e = (status: number, body: Record<string, unknown>) => new AdminApiError(status, body);
    const sod = { error: 'sod_violation', rule: 'SOD_REMITTANCE_SELF_APPROVAL' };
    expect(remittanceRefusal(e(403, { ...sod, small_team_exception_required: false }))).toMatch(
      /You asked for this change, so you can’t approve it as well/,
    );
    expect(remittanceRefusal(e(403, { ...sod, small_team_exception_required: true }))).toMatch(
      /small-team mode you may approve it yourself if you write why/,
    );
    expect(remittanceRefusal(e(409, { error: 'CHANGE_PENDING' }))).toMatch(
      /Another change is already waiting for approval/,
    );
    expect(remittanceRefusal(e(409, { error: 'NOT_PENDING' }))).toMatch(
      /already been approved or rejected/,
    );
    expect(remittanceRefusal(e(404, { error: 'CHANGE_NOT_FOUND' }))).toMatch(
      /already been approved or rejected/,
    );
    expect(remittanceRefusal(e(409, { error: 'STALE_REQUEST' }))).toMatch(
      /changed after this change was asked for/,
    );
    expect(remittanceRefusal(e(422, { error: 'BANK_ACCOUNT_ARCHIVED' }))).toMatch(/archived/);
    expect(remittanceRefusal(e(422, { error: 'NO_CHANGE' }))).toMatch(/already the remittance/);
    expect(remittanceRefusal(e(404, { error: 'BANK_ACCOUNT_NOT_FOUND' }))).toMatch(
      /not in this company/,
    );
    expect(remittanceRefusal(e(409, { error: 'CHANGE_ID_CONFLICT' }))).toMatch(/try again/);
    expect(remittanceRefusal(e(400, { error: 'invalid_sod_exception' }))).toMatch(/Write why/);
    expect(
      remittanceRefusal(e(400, { error: 'invalid_request', message: 'a reason is required' })),
    ).toBe('A reason is required.');
    expect(remittanceRefusal(new Error('x'))).toBeNull();
    expect(remittanceRefusal(e(500, { error: 'boom' }))).toBeNull();
  });
});
