/**
 * INV-balance and INV-ar-control for the sales-invoice builder (T-0040; packages/ledger AGENTS.md
 * property layer, default numRuns): for any invoice the built journal passes the engine's command
 * checks (balanced, non-negative, ≤ 4 decimals), the AR debit equals the document total, revenue
 * credits equal the net total, tax credits equal the tax total, and the rounding line equals the
 * residue on the side the residue gives.
 */
import { checkCommand } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildInvoiceJournal, type InvoiceJournalInput } from './invoice-journal.ts';

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
const ACCOUNTS = [
  '01900000-0000-7000-8000-00000000a411',
  '01900000-0000-7000-8000-00000000a412',
  '01900000-0000-7000-8000-00000000a413',
];

/** Cents as a plain decimal string, by string slicing (no number arithmetic on money). */
const cents = fc.integer({ min: 1, max: 99_999_999 }).map((c) => {
  const s = String(c).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
});

const invoice = fc.record({
  amountsAre: fc.constantFrom('exclusive' as const, 'inclusive' as const),
  rounding: fc.constantFrom('per_line' as const, 'per_document' as const),
  lines: fc.array(
    fc.record({
      amount: cents,
      accountId: fc.constantFrom(...ACCOUNTS),
      taxCode: fc.constantFrom(GST, FRE),
    }),
    { minLength: 1, maxLength: 12 },
  ),
});

const sum = (xs: readonly (string | undefined)[]) =>
  xs.reduce((s, x) => (x === undefined ? s : s.add(Money.of(x, 'AUD'))), Money.zero('AUD'));

describe('sales invoice journal invariants (fast-check, default runs)', () => {
  it('INV-balance / INV-ar-control: every built invoice journal balances and AR equals the document total', () => {
    fc.assert(
      fc.property(invoice, (inv) => {
        const input: InvoiceJournalInput = {
          companyId: '01900000-0000-7000-8000-00000000f001',
          invoiceId: '01900000-0000-7000-8000-00000000e001',
          partyId: '01900000-0000-7000-8000-00000000b001',
          controlRole: 'AR_CONTROL',
          currency: 'AUD',
          dueDate: '2026-11-19',
          ...inv,
        };
        const j = buildInvoiceJournal(input);
        checkCommand({
          companyId: input.companyId,
          idempotencyKey: 'prop',
          entryDate: '2026-11-05',
          sourceType: 'ar_invoice',
          lines: j.lines,
        });
        const ar = j.lines.filter((l) => 'role' in l.account && l.account.role === 'AR_CONTROL');
        expect(ar).toHaveLength(1);
        expect(ar[0]?.debit).toBe(j.total);
        const revenue = j.lines.filter((l) => 'id' in l.account && ACCOUNTS.includes(l.account.id));
        expect(sum(revenue.map((l) => l.credit)).toNumericString()).toBe(j.netTotal);
        expect(sum(revenue.map((l) => l.taxAmount)).toNumericString()).toBe(j.taxTotal);
        const tax = j.lines.filter((l) => 'id' in l.account && l.account.id === GST.collectedAccountId);
        expect(sum(tax.map((l) => l.credit)).toNumericString()).toBe(j.taxTotal);
        const rounding = j.lines.filter((l) => 'role' in l.account && l.account.role === 'ROUNDING');
        const residue = Money.of(j.residue, 'AUD');
        if (residue.isZero()) expect(rounding).toHaveLength(0);
        else
          expect(rounding[0]?.[residue.isPositive() ? 'debit' : 'credit']).toBe(
            residue.abs().toNumericString(),
          );
      }),
    );
  });
});
