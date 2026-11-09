/**
 * Customer receipt allocation plan and invoice payment status (T-0046, RQ-0112 Q2/Q3). Pure:
 * shared by recordReceipt, allocateReceipt and previewReceipt (receipts.ts) so that the preview
 * shows exactly what the posting would do. Money with decimal.js (Money), never floats.
 */
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';

export type ReceiptErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_RECEIPT'
  | 'INVALID_AMOUNT'
  | 'NO_ALLOCATION'
  | 'UNKNOWN_INVOICE'
  | 'DUPLICATE_INVOICE'
  | 'INVOICE_NOT_POSTED'
  | 'PARTY_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DATE_BEFORE_INVOICE'
  | 'OVER_ALLOCATION'
  | 'EXCEEDS_RECEIPT'
  | 'UNKNOWN_BANK_ACCOUNT'
  | 'NOT_THIS_RECEIPT'
  | 'ALREADY_REVERSED'
  | 'DATE_BEFORE_ALLOCATION'
  | 'IDEMPOTENCY_CONFLICT';

/** A receipt or allocation refused. Nothing was written. Engine refusals stay PostingError. */
export class ReceiptError extends DomainError {
  declare readonly code: ReceiptErrorCode;
}

export const refuseReceipt = (code: ReceiptErrorCode, message: string): never => {
  throw new ReceiptError(code, message);
};

/** Derived from the invoice's AR open item; never stored (RQ-0112 finding 3). */
export type PaymentStatus = 'unpaid' | 'part_paid' | 'paid';

const X = 'XXX';
const CENTS_RE = /^\d+(\.\d{1,2})?$/;

export function paymentStatusOf(total: string, openAmount: string): PaymentStatus {
  const open = Money.of(openAmount, X);
  if (open.isZero()) return 'paid';
  return open.compare(Money.of(total, X)) === 0 ? 'unpaid' : 'part_paid';
}

/** A positive amount in cents, as NUMERIC(19,4) text; INVALID_AMOUNT otherwise. */
export function positiveCents(v: unknown, what: string): string {
  if (typeof v !== 'string' || !CENTS_RE.test(v) || Money.of(v, X).isZero()) {
    return refuseReceipt(
      'INVALID_AMOUNT',
      `${what}: ${JSON.stringify(v)} must be a positive amount in cents`,
    );
  }
  return Money.of(v, X).toNumericString();
}

export interface PlanInvoice {
  invoiceId: string;
  /** The invoice's original AR amount (NUMERIC text, > 0). */
  total: string;
  /** Its open amount now (NUMERIC text, 0..total). */
  openAmount: string;
}

export interface AllocationRequest {
  invoiceId: string;
  /** Plain decimal, > 0, at most cents. */
  amount: string;
}

export interface PlannedAllocation {
  invoiceId: string;
  amount: string;
  openBefore: string;
  openAfter: string;
  statusAfter: PaymentStatus;
}

export interface AllocationPlan {
  rows: PlannedAllocation[];
  allocated: string;
  /** What stays on the receipt as an unallocated customer credit (RQ-0112 finding 4). */
  unallocated: string;
}

/**
 * Check and price the allocations of `available` (the receipt's unallocated amount) to invoices:
 * at least one, each > 0 and ≤ the invoice's open amount, one per invoice, Σ ≤ available.
 */
export function planReceiptAllocations(p: {
  available: string;
  invoices: readonly PlanInvoice[];
  requests: readonly AllocationRequest[];
}): AllocationPlan {
  if (p.requests.length === 0) {
    refuseReceipt(
      'NO_ALLOCATION',
      'a receipt is allocated to at least one invoice; money received without an invoice is a prepayment (RQ-0095 Q7, T-0047)',
    );
  }
  const byId = new Map(p.invoices.map((i) => [i.invoiceId, i]));
  const seen = new Set<string>();
  let allocated = Money.of('0', X);
  const rows: PlannedAllocation[] = [];
  for (const r of p.requests) {
    const amount = positiveCents(r.amount, `allocation to invoice ${r.invoiceId}`);
    if (seen.has(r.invoiceId)) {
      refuseReceipt('DUPLICATE_INVOICE', `invoice ${r.invoiceId} is listed twice`);
    }
    seen.add(r.invoiceId);
    const inv = byId.get(r.invoiceId);
    if (inv === undefined) return refuseReceipt('UNKNOWN_INVOICE', `no invoice ${r.invoiceId}`);
    const open = Money.of(inv.openAmount, X);
    const a = Money.of(amount, X);
    if (a.compare(open) > 0) {
      refuseReceipt(
        'OVER_ALLOCATION',
        `${amount} exceeds the open amount ${open.toNumericString()} of invoice ${r.invoiceId}`,
      );
    }
    allocated = allocated.add(a);
    const after = open.sub(a);
    rows.push({
      invoiceId: r.invoiceId,
      amount,
      openBefore: open.toNumericString(),
      openAfter: after.toNumericString(),
      statusAfter: paymentStatusOf(inv.total, after.toNumericString()),
    });
  }
  const available = Money.of(p.available, X);
  if (allocated.compare(available) > 0) {
    refuseReceipt(
      'EXCEEDS_RECEIPT',
      `allocations of ${allocated.toNumericString()} exceed the ${available.toNumericString()} available on the receipt`,
    );
  }
  return {
    rows,
    allocated: allocated.toNumericString(),
    unallocated: available.sub(allocated).toNumericString(),
  };
}
