/**
 * Journal lines for a supplier bill, built in memory (T-0050, design §3.8 row 6, GP-008,
 * RQ-0106 F3). Pure: the caller has resolved every line's account and tax code.
 *
 * Amounts come from the tax engine (calculateTax: company tax_rounding, bill amounts_are) and the
 * purchase-side grouping of draftTaxedDocumentLines (T-0034): document lines grouped by
 * (account, tax code), one tax line per code, sides mirrored for a purchase. The order is GP-008's:
 *   1. document lines — Dr net, the line's tax code and tax amount, the supplier
 *   2. tax lines      — Dr tax to the code's GST paid account, the tax code, no tax amount (F1)
 *   3. ROUNDING       — the per-document residue, if any (design §3.4)
 *   4. AP control     — Cr gross, the supplier and the due date (the AP open item, T-0028)
 * Tax amounts are non-negative because bill lines are positive; the side gives the direction.
 */
import type { AccountRef, PostingLineInput } from '@ledgerforce/ledger';
import type { TaxRounding } from '@ledgerforce/db';
import { calculateTax, draftTaxedDocumentLines, type AmountsAre } from '@ledgerforce/tax';
import { BillError } from './errors.ts';

export interface BillTaxCode {
  /** app.tax_code id of the version valid on the bill date. */
  id: string;
  rate: string;
  /** Account bound to the code's GST_PAID role; null if the code has none. */
  paidAccountId: string | null;
}

export interface BillJournalInput {
  currency: string;
  amountsAre: AmountsAre;
  rounding: TaxRounding;
  supplierId: string;
  dueDate: string;
  taxCodes: ReadonlyMap<string, BillTaxCode>;
  lines: readonly { accountId: string; taxCode: string; amount: string }[];
}

const ZERO = '0.0000';

export function buildBillLines(input: BillJournalInput): PostingLineInput[] {
  const code = (key: string): BillTaxCode => {
    const c = input.taxCodes.get(key);
    if (!c)
      throw new BillError('TAX_CODE_REQUIRED', `tax code ${key} has no version for this bill`);
    return c;
  };
  const calc = calculateTax({
    currency: input.currency,
    amountsAre: input.amountsAre,
    rounding: input.rounding,
    lines: input.lines.map((l) => ({
      amount: l.amount.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''),
      taxCode: l.taxCode,
      rate: code(l.taxCode).rate,
    })),
  });
  const draft = draftTaxedDocumentLines(calc, {
    side: 'purchase',
    lineAccounts: input.lines.map((l) => l.accountId),
  });

  const side = (d: { debit: string; credit: string }) =>
    d.debit !== ZERO ? { debit: d.debit } : { credit: d.credit };
  const docs: PostingLineInput[] = [];
  const taxes: PostingLineInput[] = [];
  const rounding: PostingLineInput[] = [];
  const control: PostingLineInput[] = [];
  for (const d of draft) {
    if (d.account === 'system:AP_CONTROL') {
      control.push({
        account: { role: 'AP_CONTROL' },
        ...side(d),
        partyId: input.supplierId,
        dueDate: input.dueDate,
      });
    } else if (d.account === 'system:ROUNDING') {
      rounding.push({ account: { role: 'ROUNDING' }, ...side(d) });
    } else if (d.account.startsWith('tax:')) {
      const c = code(d.taxCode ?? '');
      if (c.paidAccountId === null) {
        throw new BillError(
          'TAX_ACCOUNT_MISSING',
          `tax code ${d.taxCode ?? ''} has tax but no GST paid account (bind its GST_PAID role)`,
        );
      }
      taxes.push({ account: { id: c.paidAccountId }, ...side(d), taxCodeId: c.id });
    } else {
      const account: AccountRef = { id: d.account };
      docs.push({
        account,
        ...side(d),
        ...(d.taxCode === null ? {} : { taxCodeId: code(d.taxCode).id }),
        ...(d.taxAmount === null ? {} : { taxAmount: d.taxAmount }),
        partyId: input.supplierId,
      });
    }
  }
  return [...docs, ...taxes, ...rounding, ...control];
}
