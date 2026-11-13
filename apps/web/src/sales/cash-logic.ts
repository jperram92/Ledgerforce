/**
 * Display helpers for the AR cash screens (T-0085): plain words for API codes and the form value
 * of an amount. No accounting here: amounts stay strings, the API decides what is allowed.
 */
import type { InvoiceRow } from './client.ts';

export type PaymentStatus = 'unpaid' | 'partially_paid' | 'paid';

export const PAYMENT_WORD: Record<PaymentStatus, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Partly paid',
  paid: 'Paid',
};

/** The credit-note reason codes of @ledgerforce/ar (CREDIT_NOTE_REASONS) in plain words (P12). */
export const CREDIT_REASONS = [
  { code: 'price_concession', label: 'Price reduced' },
  { code: 'return', label: 'Goods returned' },
  { code: 'scope_reduction', label: 'Less work than invoiced' },
  { code: 'billing_error', label: 'Invoiced in error' },
  { code: 'goodwill', label: 'Goodwill' },
] as const;

/**
 * NUMERIC text from the API as the value of an amount field: trailing zero places beyond cents
 * are dropped as text ("1375.0000" → "1375.00"). Anything finer than cents is left as it is, so the
 * API refuses it instead of the browser rounding money.
 */
export function amountInput(numeric: string): string {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(numeric);
  if (!m) return numeric;
  const whole = m[1] ?? '';
  const places = (m[2] ?? '').padEnd(2, '0');
  const cents = places.slice(0, 2);
  const rest = places.slice(2);
  return /^0*$/.test(rest) ? `${whole}.${cents}` : numeric;
}

/** The customer's posted, numbered invoices: the ones a receipt can be allocated to. */
export const invoicesFor = (invoices: readonly InvoiceRow[], partyId: string): InvoiceRow[] =>
  invoices.filter((i) => i.party_id === partyId && i.status === 'posted' && i.invoice_no !== null);
