/**
 * SS-UC01-11 — Tax-inclusive rounding follows company setting (T-0034, golden layer).
 *
 * ┌─ DRAFT GOLDEN ──────────────────────────────────────────────────────────────────────────┐
 * │ GP-018a / GP-018b in Docs/accounting/postings.md are **Status: Draft** (not Approved).  │
 * │ Per DL-0242 this self-contained test transcribes the Draft tables below so the engine   │
 * │ can be built ahead of the golden_postings gate. It does NOT count as golden evidence:   │
 * │ the `golden` verify gate stays PENDING and T-0034 stops at `verifying` until a human    │
 * │ approves GP-018 (and answers postings.md Q8). The T-0031 golden runner, reading the     │
 * │ Approved file directly, supersedes this transcription; do not edit the values here     │
 * │ to match code — if code and Draft differ, the Draft (or an approved change) wins.       │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Scenario (postings.md GP-018): INV-000160, three Subscription add-on lines each $3.35
 * GST-inclusive (document total $10.05). postings.md labels the tax code "GST-INC": in this
 * engine that is code GST (10%) with amountsAre = 'inclusive' (DL-0245). Accounts are the
 * posting-key placeholders the golden file uses (system roles, product profile, tax code);
 * the ledger reference numbers (1200, 4100, 2200, 8900) are illustrative in the Draft and are
 * resolved through system roles at posting time, so they are not asserted here.
 *
 * Layer note: this asserts the in-memory journal the tax engine builds for the document. Posting
 * it through packages/ledger (with product profiles from T-0038/T-0039) is T-0040's golden test.
 */
import { Money } from '@ledgerforce/shared';
import { describe, expect, it } from 'vitest';
import { calculateTax } from '../gst.engine.ts';
import { draftTaxedDocumentLines, type DraftJournalLine } from '../tax-journal.ts';
import type { TaxRounding } from '@ledgerforce/db';

const n = (s: string) => Money.of(s, 'AUD').toNumericString();
const row = (
  account: string,
  debit: string,
  credit: string,
  taxCode: string | null,
  taxAmount: string | null,
): DraftJournalLine => ({
  account,
  debit: n(debit),
  credit: n(credit),
  taxCode,
  taxAmount: taxAmount === null ? null : n(taxAmount),
});

/** DRAFT GP-018a — tax_rounding = per_line (AU default). Transcribed 2026-11-08. */
const GP_018A_DRAFT: DraftJournalLine[] = [
  row('system:AR_CONTROL', '10.05', '0', null, null),
  row('product:SUBSCRIPTION.revenue', '0', '9.15', 'GST', '0.90'),
  row('tax:GST.collected', '0', '0.90', 'GST', null),
];

/** DRAFT GP-018b — tax_rounding = per_document. Transcribed 2026-11-08. */
const GP_018B_DRAFT: DraftJournalLine[] = [
  row('system:AR_CONTROL', '10.05', '0', null, null),
  row('system:ROUNDING', '0.01', '0', null, null),
  row('product:SUBSCRIPTION.revenue', '0', '9.15', 'GST', '0.91'),
  row('tax:GST.collected', '0', '0.91', 'GST', null),
];

function journalFor(rounding: TaxRounding): DraftJournalLine[] {
  const calc = calculateTax({
    currency: 'AUD',
    amountsAre: 'inclusive',
    rounding,
    lines: Array.from({ length: 3 }, () => ({ amount: '3.35', taxCode: 'GST', rate: '0.10' })),
  });
  return draftTaxedDocumentLines(calc, {
    side: 'sale',
    lineAccounts: Array.from({ length: 3 }, () => 'product:SUBSCRIPTION.revenue'),
  });
}

const totals = (lines: DraftJournalLine[]) =>
  lines.reduce(
    (t, l) => ({ dr: t.dr.add(Money.of(l.debit, 'AUD')), cr: t.cr.add(Money.of(l.credit, 'AUD')) }),
    { dr: Money.zero('AUD'), cr: Money.zero('AUD') },
  );

describe('SS-UC01-11: Tax-inclusive rounding follows company setting [DRAFT GP-018 — not Approved]', () => {
  it('per_line produces the Draft GP-018a journal (no ROUNDING line), balanced at 10.05', () => {
    const j = journalFor('per_line');
    expect(j).toEqual(GP_018A_DRAFT);
    const t = totals(j);
    expect([t.dr.toNumericString(), t.cr.toNumericString()]).toEqual([n('10.05'), n('10.05')]);
  });

  it('per_document produces the Draft GP-018b journal (0.01 debit to ROUNDING), balanced at 10.06', () => {
    const j = journalFor('per_document');
    expect(j).toEqual(GP_018B_DRAFT);
    const t = totals(j);
    expect([t.dr.toNumericString(), t.cr.toNumericString()]).toEqual([n('10.06'), n('10.06')]);
  });
});
