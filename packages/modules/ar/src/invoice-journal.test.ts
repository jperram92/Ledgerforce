/**
 * The sales-invoice journal builder (T-0040, RQ-0104 finding 1) — pure, no database. The golden
 * tests (invoice.golden.db.test.ts) prove the same builder through the engine against GP-001 and
 * GP-018; these cases pin the line order, grouping and refusals in isolation.
 */
import { checkCommand } from '@ledgerforce/ledger';
import { describe, expect, it } from 'vitest';
import {
  InvoiceJournalError,
  buildInvoiceJournal,
  type InvoiceJournalInput,
} from './invoice-journal.ts';

const GST = {
  id: '01900000-0000-7000-8000-00000000c001',
  code: 'GST',
  rate: '0.10000000',
  collectedAccountId: '01900000-0000-7000-8000-00000000a220',
};
const FRE = {
  id: '01900000-0000-7000-8000-00000000c002',
  code: 'FRE',
  rate: '0.00000000',
  collectedAccountId: null,
};
const PS = '01900000-0000-7000-8000-00000000a411';
const SUB = '01900000-0000-7000-8000-00000000a412';
const ACME = '01900000-0000-7000-8000-00000000b001';

const base = (over: Partial<InvoiceJournalInput> = {}): InvoiceJournalInput => ({
  companyId: '01900000-0000-7000-8000-00000000f001',
  invoiceId: '01900000-0000-7000-8000-00000000e001',
  partyId: ACME,
  controlRole: 'AR_CONTROL',
  currency: 'AUD',
  amountsAre: 'exclusive',
  rounding: 'per_line',
  dueDate: '2026-11-19',
  lines: [
    { amount: '1000.00', accountId: PS, taxCode: GST },
    { amount: '250.00', accountId: SUB, taxCode: GST },
  ],
  ...over,
});

const inclusive3 = (rounding: 'per_line' | 'per_document') =>
  base({
    amountsAre: 'inclusive',
    rounding,
    lines: [1, 2, 3].map(() => ({ amount: '3.35', accountId: SUB, taxCode: GST })),
  });

describe('buildInvoiceJournal (RQ-0104 finding 1)', () => {
  it('GP-001 shape: AR first, one revenue line per account in order, one GST line, party on AR and revenue', () => {
    const j = buildInvoiceJournal(base());
    expect(j.lines).toEqual([
      {
        account: { role: 'AR_CONTROL' },
        debit: '1375.0000',
        partyId: ACME,
        dueDate: '2026-11-19',
      },
      {
        account: { id: PS },
        credit: '1000.0000',
        taxCodeId: GST.id,
        taxAmount: '100.0000',
        partyId: ACME,
      },
      {
        account: { id: SUB },
        credit: '250.0000',
        taxCodeId: GST.id,
        taxAmount: '25.0000',
        partyId: ACME,
      },
      { account: { id: GST.collectedAccountId }, credit: '125.0000', taxCodeId: GST.id },
    ]);
    expect(j).toMatchObject({
      netTotal: '1250.0000',
      taxTotal: '125.0000',
      total: '1375.0000',
      residue: '0.0000',
    });
  });

  it('GP-018a per_line inclusive: three lines of one product become one revenue line, no rounding line', () => {
    const j = buildInvoiceJournal(inclusive3('per_line'));
    expect(j.lines.map((l) => [l.account, l.debit ?? null, l.credit ?? null, l.taxAmount ?? null])).toEqual([
      [{ role: 'AR_CONTROL' }, '10.0500', null, null],
      [{ id: SUB }, null, '9.1500', '0.9000'],
      [{ id: GST.collectedAccountId }, null, '0.9000', null],
    ]);
  });

  it('GP-018b per_document inclusive: the 0.01 residue is a ROUNDING debit right after AR', () => {
    const j = buildInvoiceJournal(inclusive3('per_document'));
    expect(j.lines.map((l) => [l.account, l.debit ?? null, l.credit ?? null, l.taxAmount ?? null])).toEqual([
      [{ role: 'AR_CONTROL' }, '10.0500', null, null],
      [{ role: 'ROUNDING' }, '0.0100', null, null],
      [{ id: SUB }, null, '9.1500', '0.9100'],
      [{ id: GST.collectedAccountId }, null, '0.9100', null],
    ]);
    expect(j.residue).toBe('0.0100');
  });

  it('every built journal passes the engine command checks (balanced, non-negative amounts)', () => {
    for (const input of [base(), inclusive3('per_line'), inclusive3('per_document')]) {
      const j = buildInvoiceJournal(input);
      expect(() =>
        checkCommand({
          companyId: input.companyId,
          idempotencyKey: 'k',
          entryDate: '2026-11-05',
          sourceType: 'ar_invoice',
          lines: j.lines,
        }),
      ).not.toThrow();
    }
  });

  it('a GST-free line posts no tax line and carries tax 0 on its revenue line', () => {
    const j = buildInvoiceJournal(base({ lines: [{ amount: '80.00', accountId: PS, taxCode: FRE }] }));
    expect(j.lines).toEqual([
      { account: { role: 'AR_CONTROL' }, debit: '80.0000', partyId: ACME, dueDate: '2026-11-19' },
      { account: { id: PS }, credit: '80.0000', taxCodeId: FRE.id, taxAmount: '0.0000', partyId: ACME },
    ]);
  });

  it('refuses no lines, a non-positive amount, more than two decimals, and tax without a collected account', () => {
    const code = (input: InvoiceJournalInput) => {
      try {
        buildInvoiceJournal(input);
      } catch (e) {
        if (e instanceof InvoiceJournalError) return e.code;
        throw e;
      }
      return 'accepted';
    };
    expect(code(base({ lines: [] }))).toBe('INVALID_INVOICE');
    expect(code(base({ lines: [{ amount: '0.00', accountId: PS, taxCode: GST }] }))).toBe(
      'INVALID_INVOICE',
    );
    expect(code(base({ lines: [{ amount: '-5.00', accountId: PS, taxCode: GST }] }))).toBe(
      'INVALID_INVOICE',
    );
    expect(code(base({ lines: [{ amount: '1.005', accountId: PS, taxCode: GST }] }))).toBe(
      'INVALID_INVOICE',
    );
    expect(
      code(
        base({
          lines: [{ amount: '10.00', accountId: PS, taxCode: { ...GST, collectedAccountId: null } }],
        }),
      ),
    ).toBe('TAX_ACCOUNT_MISSING');
  });
});
