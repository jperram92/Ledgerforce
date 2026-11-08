/**
 * Credit-note builder invariants (T-0045; packages/ledger AGENTS.md property layer, default
 * numRuns):
 * - INV-balance / INV-ar-control: every built credit note passes the engine's command checks and
 *   its single AR control line is a credit of the document total; tax amounts are non-negative.
 * - Mirror: a full credit of any invoice (same lines, same rounding) nets the invoice journal to
 *   zero on every account, tax code and tax amount — the credit note is the invoice's exact mirror.
 */
import { checkCommand, type PostingLineInput } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCreditNoteJournal } from './credit-note-journal.ts';
import { buildInvoiceJournal } from './invoice-journal.ts';

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
const ACCOUNTS = ['01900000-0000-7000-8000-00000000a411', '01900000-0000-7000-8000-00000000a412'];
const AR = '01900000-0000-7000-8000-00000000a120';
const PARTY = '01900000-0000-7000-8000-00000000b001';

/** Cents as a plain decimal string, by string slicing (no number arithmetic on money). */
const cents = fc.integer({ min: 1, max: 99_999_999 }).map((c) => {
  const s = String(c).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
});

const doc = fc.record({
  amountsAre: fc.constantFrom('exclusive' as const, 'inclusive' as const),
  rounding: fc.constantFrom('per_line' as const, 'per_document' as const),
  lines: fc.array(
    fc.record({
      amount: cents,
      accountId: fc.constantFrom(...ACCOUNTS),
      taxCode: fc.constantFrom(GST, FRE),
    }),
    { minLength: 1, maxLength: 10 },
  ),
});

const keyOf = (l: PostingLineInput) =>
  JSON.stringify([
    'role' in l.account ? (l.account.role === 'AR_CONTROL' ? AR : l.account.role) : l.account.id,
    l.taxCodeId ?? null,
  ]);

describe('credit-note journal invariants (fast-check, default runs)', () => {
  it('INV-balance / INV-ar-control: balanced, AR credit = total, non-negative tax amounts', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const j = buildCreditNoteJournal({
          partyId: PARTY,
          controlAccountId: AR,
          currency: 'AUD',
          dueDate: '2026-11-20',
          ...d,
        });
        checkCommand({
          companyId: '01900000-0000-7000-8000-00000000f001',
          idempotencyKey: 'prop',
          entryDate: '2026-11-20',
          sourceType: 'ar_credit_note',
          lines: j.lines,
        });
        const ar = j.lines.filter((l) => 'id' in l.account && l.account.id === AR);
        expect(ar).toHaveLength(1);
        expect(ar[0]?.credit).toBe(j.total);
        for (const l of j.lines) {
          if (l.taxAmount !== undefined)
            expect(Money.of(l.taxAmount, 'AUD').isNegative()).toBe(false);
        }
      }),
    );
  });

  it('a full credit mirrors the invoice: invoice + credit note net to zero per account and tax code', () => {
    fc.assert(
      fc.property(doc, (d) => {
        const inv = buildInvoiceJournal({
          companyId: '01900000-0000-7000-8000-00000000f001',
          invoiceId: '01900000-0000-7000-8000-00000000e001',
          partyId: PARTY,
          controlRole: 'AR_CONTROL',
          currency: 'AUD',
          dueDate: '2026-11-19',
          ...d,
        });
        const cn = buildCreditNoteJournal({
          partyId: PARTY,
          controlAccountId: AR,
          currency: 'AUD',
          dueDate: '2026-11-20',
          ...d,
        });
        expect(cn.total).toBe(inv.total);
        const net = new Map<string, { amt: Money; tax: Money }>();
        const add = (l: PostingLineInput) => {
          const k = keyOf(l);
          const v = net.get(k) ?? { amt: Money.zero('AUD'), tax: Money.zero('AUD') };
          const signed = Money.of(l.debit ?? '0', 'AUD').sub(Money.of(l.credit ?? '0', 'AUD'));
          const tax = Money.of(l.taxAmount ?? '0', 'AUD');
          // Tax amounts are unsigned; the side carries the direction (credit on the invoice).
          const taxSigned = l.debit !== undefined ? tax : tax.negate();
          v.amt = v.amt.add(signed);
          v.tax = v.tax.add(taxSigned);
          net.set(k, v);
        };
        inv.lines.forEach(add);
        cn.lines.forEach(add);
        for (const [k, v] of net) {
          expect([k, v.amt.toNumericString(), v.tax.toNumericString()]).toEqual([
            k,
            '0.0000',
            '0.0000',
          ]);
        }
      }),
    );
  });
});
