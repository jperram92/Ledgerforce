/**
 * T-0048 bad-debt write-off builder (RQ-0130 findings 2 and 4; GP-007, GP-007-A A2/A3).
 * INV-000140: 1,250.00 + GST 125.00 = 1,375.00, unpaid.
 */
import { describe, expect, it } from 'vitest';
import {
  BadDebtError,
  allowanceReleaseLinesOf,
  buildWriteOffJournal,
  writeOffGst,
  type WriteOffJournalInput,
} from './bad-debt-journal.ts';

const ADJ_BD = { id: 'adj-bd-v1', collectedAccountId: 'acct-2310' };

const base = (over: Partial<WriteOffJournalInput> = {}): WriteOffJournalInput => ({
  currency: 'AUD',
  partyId: 'acme',
  controlAccountId: 'acct-1200',
  badDebtAccountId: 'acct-6500',
  allowanceAccountId: 'acct-1290',
  adjBd: ADJ_BD,
  amount: '1375.00',
  invoiceTotal: '1375.0000',
  invoiceTax: '125.0000',
  method: 'direct',
  allowanceAvailable: '0',
  writeOffDate: '2027-12-01',
  ...over,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadDebtError) return e.code;
    throw e;
  }
  return undefined;
};

describe('writeOffGst — written-off amount × invoice tax ÷ invoice total, half-up to cents', () => {
  it.each([
    ['1375.00', '1375.0000', '125.0000', '125.0000'], // GP-007 full write-off
    ['500.00', '1375.0000', '125.0000', '45.4500'], // partial: 500/11 = 45.4545… → 45.45
    ['0.06', '0.0600', '0.0100', '0.0100'], // full write-off returns exactly the GST raised
    ['100.00', '100.0000', '0.0000', '0.0000'], // GST-free invoice: no adjustment
    ['55.00', '1100.0000', '50.0000', '2.5000'], // mixed: half taxable → 2.50 (not 5.00)
    ['0.11', '1.1000', '0.0500', '0.0100'], // 0.005 → half-up 0.01
  ])('%s of an invoice %s with tax %s → GST %s', (amount, total, tax, gst) => {
    expect(writeOffGst({ amount, invoiceTotal: total, invoiceTax: tax, currency: 'AUD' })).toBe(
      gst,
    );
  });
});

describe('buildWriteOffJournal', () => {
  it('GP-007 direct: Dr bad debts 1,250.00 ADJ-BD (tax 125.00), Dr GST collected 125.00, Cr AR 1,375.00', () => {
    const j = buildWriteOffJournal(base());
    expect(j.lines).toEqual([
      {
        account: { id: 'acct-6500' },
        debit: '1250.0000',
        taxCodeId: 'adj-bd-v1',
        taxAmount: '125.0000',
        partyId: 'acme',
      },
      { account: { id: 'acct-2310' }, debit: '125.0000', taxCodeId: 'adj-bd-v1' },
      { account: { id: 'acct-1200' }, credit: '1375.0000', partyId: 'acme', dueDate: '2027-12-01' },
    ]);
    expect(j).toMatchObject({
      gst: '125.0000',
      net: '1250.0000',
      allowanceCharge: '0.0000',
      badDebtAmount: '1250.0000',
    });
  });

  it('GP-007-A A2: the default charge is the ex-GST amount when the allowance holds 1,375.00', () => {
    const j = buildWriteOffJournal(base({ method: 'allowance', allowanceAvailable: '1375.0000' }));
    expect(j.lines).toEqual([
      {
        account: { id: 'acct-1290' },
        debit: '1250.0000',
        taxCodeId: 'adj-bd-v1',
        taxAmount: '125.0000',
        partyId: 'acme',
      },
      { account: { id: 'acct-2310' }, debit: '125.0000', taxCodeId: 'adj-bd-v1' },
      { account: { id: 'acct-1200' }, credit: '1375.0000', partyId: 'acme', dueDate: '2027-12-01' },
    ]);
    expect(j.allowanceCharge).toBe('1250.0000');
    expect(j.badDebtAmount).toBe('0.0000');
  });

  it('GP-007-A A3: the default charge is capped at the allowance available (1,000.00); the excess goes to bad debts', () => {
    const j = buildWriteOffJournal(base({ method: 'allowance', allowanceAvailable: '1000.0000' }));
    expect(j.lines).toEqual([
      {
        account: { id: 'acct-1290' },
        debit: '1000.0000',
        taxCodeId: 'adj-bd-v1',
        taxAmount: '100.0000',
        partyId: 'acme',
      },
      {
        account: { id: 'acct-6500' },
        debit: '250.0000',
        taxCodeId: 'adj-bd-v1',
        taxAmount: '25.0000',
        partyId: 'acme',
      },
      { account: { id: 'acct-2310' }, debit: '125.0000', taxCodeId: 'adj-bd-v1' },
      { account: { id: 'acct-1200' }, credit: '1375.0000', partyId: 'acme', dueDate: '2027-12-01' },
    ]);
  });

  it('a user-stated charge below the default is used; above the ex-GST amount or the available balance it is refused', () => {
    const j = buildWriteOffJournal(
      base({
        method: 'allowance',
        allowanceAvailable: '1375.0000',
        allowanceRequested: '600.00',
      }),
    );
    expect(j.allowanceCharge).toBe('600.0000');
    expect(j.badDebtAmount).toBe('650.0000');
    expect(j.allowanceTax).toBe('60.0000');
    expect(j.badDebtTax).toBe('65.0000');
    expect(
      codeOf(() =>
        buildWriteOffJournal(
          base({
            method: 'allowance',
            allowanceAvailable: '1375.0000',
            allowanceRequested: '1250.01',
          }),
        ),
      ),
    ).toBe('ALLOWANCE_EXCEEDED');
    expect(
      codeOf(() =>
        buildWriteOffJournal(
          base({ method: 'allowance', allowanceAvailable: '999.99', allowanceRequested: '1000.00' }),
        ),
      ),
    ).toBe('ALLOWANCE_EXCEEDED');
  });

  it('the allowance path needs an allowance account and a credit balance; direct takes no charge', () => {
    expect(
      codeOf(() =>
        buildWriteOffJournal(
          base({ method: 'allowance', allowanceAccountId: null, allowanceAvailable: '10' }),
        ),
      ),
    ).toBe('NO_ALLOWANCE_ACCOUNT');
    expect(
      codeOf(() => buildWriteOffJournal(base({ method: 'allowance', allowanceAvailable: '0' }))),
    ).toBe('ALLOWANCE_EMPTY');
    // a debit balance on the allowance is never "available"
    expect(
      codeOf(() =>
        buildWriteOffJournal(base({ method: 'allowance', allowanceAvailable: '-5.0000' })),
      ),
    ).toBe('ALLOWANCE_EMPTY');
    expect(
      codeOf(() => buildWriteOffJournal(base({ method: 'direct', allowanceRequested: '10.00' }))),
    ).toBe('INVALID_WRITE_OFF');
  });

  it('a partial write-off of 500.00 carries GST 45.45 (GP-007 partial rule)', () => {
    const j = buildWriteOffJournal(base({ amount: '500.00' }));
    expect(j.gst).toBe('45.4500');
    expect(j.net).toBe('454.5500');
  });

  it('a GST-free write-off has no tax code, no GST line', () => {
    const j = buildWriteOffJournal(
      base({ amount: '100.00', invoiceTotal: '100.0000', invoiceTax: '0.0000', adjBd: null }),
    );
    expect(j.lines).toEqual([
      { account: { id: 'acct-6500' }, debit: '100.0000', partyId: 'acme' },
      { account: { id: 'acct-1200' }, credit: '100.0000', partyId: 'acme', dueDate: '2027-12-01' },
    ]);
  });

  it('refuses a non-positive or sub-cent amount, and GST without the ADJ-BD code or its account', () => {
    expect(codeOf(() => buildWriteOffJournal(base({ amount: '0' })))).toBe('INVALID_WRITE_OFF');
    expect(codeOf(() => buildWriteOffJournal(base({ amount: '1.001' })))).toBe(
      'INVALID_WRITE_OFF',
    );
    expect(codeOf(() => buildWriteOffJournal(base({ adjBd: null })))).toBe('TAX_CODE_MISSING');
    expect(
      codeOf(() =>
        buildWriteOffJournal(base({ adjBd: { id: 'adj-bd-v1', collectedAccountId: null } })),
      ),
    ).toBe('TAX_ACCOUNT_MISSING');
  });
});

describe('allowanceReleaseLinesOf — A4 remeasurement lines (manual journal)', () => {
  it('Dr allowance / Cr bad debts, capped at the allowance credit balance', () => {
    expect(
      allowanceReleaseLinesOf({
        currency: 'AUD',
        allowanceAccountId: 'acct-1290',
        badDebtAccountId: 'acct-6500',
        amount: '125.00',
        allowanceAvailable: '125.0000',
      }),
    ).toEqual([
      { account: { id: 'acct-1290' }, debit: '125.0000' },
      { account: { id: 'acct-6500' }, credit: '125.0000' },
    ]);
    expect(
      codeOf(() =>
        allowanceReleaseLinesOf({
          currency: 'AUD',
          allowanceAccountId: 'acct-1290',
          badDebtAccountId: 'acct-6500',
          amount: '125.01',
          allowanceAvailable: '125.0000',
        }),
      ),
    ).toBe('ALLOWANCE_EXCEEDED');
  });
});
