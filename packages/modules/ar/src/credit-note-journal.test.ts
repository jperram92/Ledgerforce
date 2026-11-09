/**
 * T-0045 credit-note builder, creditable check and BAS period (RQ-0114 findings 3, 4, 6).
 * GP-005 numbers: CN-000007 credits $200.00 ex GST of INV-000123's Professional services line.
 */
import { describe, expect, it } from 'vitest';
import {
  CreditNoteError,
  basPeriodOf,
  buildCreditNoteJournal,
  checkCreditable,
  type CreditNoteJournalInput,
} from './credit-note-journal.ts';

const GST = { id: 'gst-v1', code: 'GST', rate: '0.10000000', collectedAccountId: 'acct-2200' };
const FRE = { id: 'fre-v1', code: 'FRE', rate: '0.00000000', collectedAccountId: null };

/** Element i, or a test failure. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${String(i)}`);
  return x;
}

const base = (lines: CreditNoteJournalInput['lines']): CreditNoteJournalInput => ({
  partyId: 'acme',
  controlAccountId: 'acct-1200',
  currency: 'AUD',
  amountsAre: 'exclusive',
  rounding: 'per_line',
  dueDate: '2026-11-20',
  lines,
});

/** INV-000123 (GP-001): line 1 1,000.00 + GST 100.00, line 2 250.00 + GST 25.00. */
const INV_123 = {
  currency: 'AUD',
  invoiceTotal: '1375.0000',
  creditedTotal: '0.0000',
  invoiceLines: [
    { invoiceLineId: 'L1', net: '1000.0000', tax: '100.0000', creditedNet: '0', creditedTax: '0' },
    { invoiceLineId: 'L2', net: '250.0000', tax: '25.0000', creditedNet: '0', creditedTax: '0' },
  ],
};

describe('buildCreditNoteJournal', () => {
  it('GP-005 shape: revenue Dr 200 (GST tax 20), GST collected Dr 20, AR control Cr 220', () => {
    const j = buildCreditNoteJournal(
      base([{ amount: '200.00', accountId: 'acct-4000', taxCode: GST }]),
    );
    expect(j.lines).toEqual([
      {
        account: { id: 'acct-4000' },
        debit: '200.0000',
        taxCodeId: 'gst-v1',
        taxAmount: '20.0000',
        partyId: 'acme',
      },
      { account: { id: 'acct-2200' }, debit: '20.0000', taxCodeId: 'gst-v1' },
      { account: { id: 'acct-1200' }, credit: '220.0000', partyId: 'acme', dueDate: '2026-11-20' },
    ]);
    expect([j.netTotal, j.taxTotal, j.total, j.residue]).toEqual([
      '200.0000',
      '20.0000',
      '220.0000',
      '0.0000',
    ]);
    expect(j.lineResults).toEqual([{ net: '200.0000', tax: '20.0000' }]);
  });

  it('groups lines by (account, tax code) in first-appearance order; no tax line for GST-free', () => {
    const j = buildCreditNoteJournal(
      base([
        { amount: '10.00', accountId: 'acct-4000', taxCode: GST },
        { amount: '5.00', accountId: 'acct-4100', taxCode: FRE },
        { amount: '1.00', accountId: 'acct-4000', taxCode: GST },
      ]),
    );
    expect(j.lines.map((l) => [l.account, l.debit ?? null, l.credit ?? null])).toEqual([
      [{ id: 'acct-4000' }, '11.0000', null],
      [{ id: 'acct-4100' }, '5.0000', null],
      [{ id: 'acct-2200' }, '1.1000', null],
      [{ id: 'acct-1200' }, null, '17.1000'],
    ]);
  });

  it('a per-document residue goes to ROUNDING on the mirrored side of an invoice (credit)', () => {
    const j = buildCreditNoteJournal({
      ...base([1, 2, 3].map(() => ({ amount: '3.35', accountId: 'acct-4100', taxCode: GST }))),
      amountsAre: 'inclusive',
      rounding: 'per_document',
    });
    // GP-018b mirrored: revenue Dr 9.15 (tax 0.91), GST Dr 0.91, ROUNDING Cr 0.01, AR Cr 10.05.
    expect(j.lines.map((l) => [l.account, l.debit ?? null, l.credit ?? null])).toEqual([
      [{ id: 'acct-4100' }, '9.1500', null],
      [{ id: 'acct-2200' }, '0.9100', null],
      [{ role: 'ROUNDING' }, null, '0.0100'],
      [{ id: 'acct-1200' }, null, '10.0500'],
    ]);
  });

  it('refuses a taxed code without a collected account (TAX_ACCOUNT_MISSING)', () => {
    expect(() =>
      buildCreditNoteJournal(
        base([{ amount: '1.00', accountId: 'a', taxCode: { ...GST, collectedAccountId: null } }]),
      ),
    ).toThrow(expect.objectContaining({ code: 'TAX_ACCOUNT_MISSING' }));
  });

  it('refuses a non-positive or malformed amount (INVALID_CREDIT_NOTE)', () => {
    for (const amount of ['0', '0.00', '-1.00', '1.234', 'x']) {
      expect(() =>
        buildCreditNoteJournal(base([{ amount, accountId: 'a', taxCode: GST }])),
      ).toThrow(expect.objectContaining({ code: 'INVALID_CREDIT_NOTE' }));
    }
  });
});

describe('checkCreditable', () => {
  it('SS-UC11-07: Credit cannot exceed the creditable amount', () => {
    // A 1,500.00 credit note against INV-000123 (total 1,375.00).
    const j = buildCreditNoteJournal(
      base([
        { amount: '1000.00', accountId: 'acct-4000', taxCode: GST },
        { amount: '363.64', accountId: 'acct-4100', taxCode: GST },
      ]),
    );
    expect(j.total).toBe('1500.0000');
    let err: unknown;
    try {
      checkCreditable({
        ...INV_123,
        request: {
          total: j.total,
          lines: [
            { invoiceLineId: 'L1', ...at(j.lineResults, 0) },
            { invoiceLineId: 'L2', ...at(j.lineResults, 1) },
          ],
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CreditNoteError);
    expect(err).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });
  });

  it('allows the GP-005 credit and a full credit of the rest; refuses one cent more', () => {
    const ok = (lines: { invoiceLineId: string; net: string; tax: string }[], total: string) =>
      checkCreditable({ ...INV_123, request: { total, lines } });
    expect(() =>
      ok([{ invoiceLineId: 'L1', net: '200.0000', tax: '20.0000' }], '220.0000'),
    ).not.toThrow();
    const afterGp005 = {
      ...INV_123,
      creditedTotal: '220.0000',
      invoiceLines: [
        { ...at(INV_123.invoiceLines, 0), creditedNet: '200.0000', creditedTax: '20.0000' },
        at(INV_123.invoiceLines, 1),
      ],
    };
    const rest = [
      { invoiceLineId: 'L1', net: '800.0000', tax: '80.0000' },
      { invoiceLineId: 'L2', net: '250.0000', tax: '25.0000' },
    ];
    expect(() =>
      checkCreditable({ ...afterGp005, request: { total: '1155.0000', lines: rest } }),
    ).not.toThrow();
    expect(() =>
      checkCreditable({
        ...afterGp005,
        request: {
          total: '1155.0100',
          lines: [{ invoiceLineId: 'L1', net: '800.0100', tax: '80.0000' }, at(rest, 1)],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_INVOICE' }));
  });

  it('sums several credit lines on one invoice line; tax is checked as well as net', () => {
    expect(() =>
      checkCreditable({
        ...INV_123,
        request: {
          total: '1100.0000',
          lines: [
            { invoiceLineId: 'L1', net: '600.0000', tax: '60.0000' },
            { invoiceLineId: 'L1', net: '400.0100', tax: '40.0000' },
          ],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_INVOICE' }));
    expect(() =>
      checkCreditable({
        ...INV_123,
        request: {
          total: '25.0100',
          lines: [{ invoiceLineId: 'L2', net: '0.0000', tax: '25.0100' }],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'CREDIT_EXCEEDS_INVOICE' }));
  });

  it('refuses a line that is not on the invoice (LINE_NOT_ON_INVOICE)', () => {
    expect(() =>
      checkCreditable({
        ...INV_123,
        request: {
          total: '1.1000',
          lines: [{ invoiceLineId: 'L9', net: '1.0000', tax: '0.1000' }],
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'LINE_NOT_ON_INVOICE' }));
  });
});

describe('basPeriodOf (RQ-0114 finding 4)', () => {
  it('monthly, quarterly (calendar quarters) and annual (AU financial year)', () => {
    expect(basPeriodOf('2026-11-05', 'monthly')).toBe('2026-11-01');
    expect(basPeriodOf('2026-11-20', 'quarterly')).toBe('2026-10-01');
    expect(basPeriodOf('2026-12-31', 'quarterly')).toBe('2026-10-01');
    expect(basPeriodOf('2027-01-01', 'quarterly')).toBe('2027-01-01');
    expect(basPeriodOf('2026-06-30', 'annual')).toBe('2025-07-01');
    expect(basPeriodOf('2026-07-01', 'annual')).toBe('2026-07-01');
  });

  it('refuses a malformed date', () => {
    expect(() => basPeriodOf('2026-13-01', 'monthly')).toThrow();
  });
});
