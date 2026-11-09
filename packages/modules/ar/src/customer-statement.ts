/**
 * Customer statement document model (T-0049, RQ-0122 finding 5, DL-0362). Pure shaping, no I/O;
 * rendering to PDF and emailing are T-0041 / T-0042.
 *
 * One section per transaction currency the party has AR items in (currency-code order):
 *   opening balance  Σ original amounts of items dated before `from`
 *   lines            one per item dated in [from, to], oldest first, debit / credit and a running
 *                    balance
 *   allocations      dated in [from, to], for information (both sides belong to the party, so they
 *                    do not move its balance)
 *   closing balance  opening + Σ lines
 *   subledger        Σ open amounts of the party's items as at `to`; `reconciled` when it equals
 *                    the closing balance (it always should: allocations net to zero per party and
 *                    currency)
 *   ageing           of the open items as at `to`, with unallocated credits listed apart.
 */
import { Money } from '@ledgerforce/shared/money';
import { ageOpenItems, type AgedLine, type AgeingInput, type AgeingTotals } from './ageing.ts';

const X = 'XXX';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type StatementLineKind = 'invoice' | 'credit_note' | 'receipt' | 'other';

/** Subledger source type → statement line kind. */
export const STATEMENT_KIND_BY_SOURCE: Readonly<Record<string, StatementLineKind>> = Object.freeze({
  ar_invoice: 'invoice',
  ar_credit_note: 'credit_note',
  ar_receipt: 'receipt',
});

export interface StatementItem {
  itemId: string;
  entryId: string;
  sourceType: string;
  documentId: string | null;
  reference: string | null;
  documentDate: string;
  dueDate: string;
  currency: string;
  /** Signed, transaction currency (debit +, credit −). */
  originalAmount: string;
  /** Signed open amount as at the statement end date, transaction currency. */
  openAmountAsOf: string;
}

export interface StatementAllocationInput {
  allocationId: string;
  allocationDate: string;
  /** Negative for a reversal (unallocation). */
  amount: string;
  currency: string;
  fromItemId: string;
  toItemId: string;
  reversalOfId: string | null;
}

export interface StatementLine {
  itemId: string;
  date: string;
  kind: StatementLineKind;
  sourceType: string;
  reference: string | null;
  dueDate: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface StatementAllocation {
  allocationId: string;
  date: string;
  amount: string;
  fromReference: string | null;
  toReference: string | null;
  reversal: boolean;
}

export interface StatementSection {
  currency: string;
  openingBalance: string;
  lines: StatementLine[];
  allocations: StatementAllocation[];
  closingBalance: string;
  subledgerBalance: string;
  reconciled: boolean;
  ageing: AgeingTotals;
  openItems: AgedLine[];
  unallocatedCredits: AgeingInput[];
}

export interface StatementBody {
  from: string;
  to: string;
  sections: StatementSection[];
}

const validDate = (s: string) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function shapeStatement(
  items: readonly StatementItem[],
  allocations: readonly StatementAllocationInput[],
  range: { from: string; to: string },
): StatementBody {
  const { from, to } = range;
  if (!validDate(from) || !validDate(to) || from > to) {
    throw new RangeError(`statement range ${from} … ${to} is not a valid date range`);
  }
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const currencies = [...new Set(items.map((i) => i.currency))].sort();
  const sections = currencies.map((currency): StatementSection => {
    const mine = items
      .filter((i) => i.currency === currency)
      .sort(
        (a, b) =>
          a.documentDate.localeCompare(b.documentDate) ||
          a.entryId.localeCompare(b.entryId) ||
          a.itemId.localeCompare(b.itemId),
      );
    let opening = Money.zero(X);
    let subledger = Money.zero(X);
    let running = Money.zero(X);
    const lines: StatementLine[] = [];
    for (const i of mine) {
      if (i.documentDate > to) {
        throw new RangeError(`item ${i.itemId} is dated ${i.documentDate}, after ${to}`);
      }
      const amount = Money.of(i.originalAmount, X);
      subledger = subledger.add(Money.of(i.openAmountAsOf, X));
      if (i.documentDate < from) {
        opening = opening.add(amount);
        continue;
      }
      if (lines.length === 0) running = opening;
      running = running.add(amount);
      lines.push({
        itemId: i.itemId,
        date: i.documentDate,
        kind: STATEMENT_KIND_BY_SOURCE[i.sourceType] ?? 'other',
        sourceType: i.sourceType,
        reference: i.reference,
        dueDate: i.dueDate,
        debit: (amount.isPositive() ? amount : Money.zero(X)).toNumericString(),
        credit: (amount.isNegative() ? amount.negate() : Money.zero(X)).toNumericString(),
        balance: running.toNumericString(),
      });
    }
    const closing = lines.length === 0 ? opening : running;
    const ageing = ageOpenItems(
      mine.map((i) => ({
        itemId: i.itemId,
        partyId: null,
        partyName: null,
        sourceType: i.sourceType,
        documentId: i.documentId,
        reference: i.reference,
        documentDate: i.documentDate,
        dueDate: i.dueDate,
        currency: i.currency,
        amount: i.openAmountAsOf,
      })),
      to,
    );
    const party = ageing.parties[0];
    return {
      currency,
      openingBalance: opening.toNumericString(),
      lines,
      allocations: allocations
        .filter(
          (a) => a.currency === currency && a.allocationDate >= from && a.allocationDate <= to,
        )
        .sort((a, b) => a.allocationDate.localeCompare(b.allocationDate))
        .map((a) => ({
          allocationId: a.allocationId,
          date: a.allocationDate,
          amount: Money.of(a.amount, X).toNumericString(),
          fromReference: byId.get(a.fromItemId)?.reference ?? null,
          toReference: byId.get(a.toItemId)?.reference ?? null,
          reversal: a.reversalOfId !== null,
        })),
      closingBalance: closing.toNumericString(),
      subledgerBalance: subledger.toNumericString(),
      reconciled: closing.equals(subledger),
      ageing: ageing.totals,
      openItems: party?.items ?? [],
      unallocatedCredits: party?.credits ?? [],
    };
  });
  return { from, to, sections };
}
