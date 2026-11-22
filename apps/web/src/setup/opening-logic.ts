/**
 * Opening balances screen wording (T-0177, design §4.1 step 9, GP-037, DL-0651). No accounting
 * here: the journal comes from the posting engine's preview (POST /setup/opening-balances/preview).
 * This file only picks which side of a line holds the amount (on the decimal string, never as a
 * number), says dates in words and words the API's refusals.
 * Foreign-currency items (T-0202, GP-043, RQ-0170, ADR-0088): the API names each line's currency,
 * currency amount and rate; this file only formats them for reading (decimal strings throughout).
 */
import { formatMoney } from '@ledgerforce/ui';
import { AdminApiError } from '../admin/client.ts';

/** A decimal string that is zero ("0", "0.0000", "-0.00"). */
const ZERO = /^[+-]?0*(\.0*)?$/;

/** The side of a preview line that holds the amount (the engine leaves the other at zero). */
export function sideOf(l: {
  debit: string;
  credit: string;
}): { debit: string } | { credit: string } {
  return ZERO.test(l.debit) ? { credit: l.credit } : { debit: l.debit };
}

/** YYYY-MM-DD in words ("31 Oct 2026"), read as a calendar day: no time-zone shift. */
export function balanceDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-AU', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
}

/** Who owes whom for an open item brought across. */
export function kindWord(kind: 'ar' | 'ap'): string {
  return kind === 'ar' ? 'Customer owes' : 'You owe';
}

/** The FX fields of a preview line (txn_*) or a posted item (currency_*), as the API sends them. */
export interface FxFields {
  txn_currency?: string | null;
  txn_amount?: string | null;
  currency?: string | null;
  currency_amount?: string | null;
  fx_rate?: string | null;
}

/**
 * "USD 1,000.00 @ 1.53846154" for an item in a foreign currency: the currency amount (its size, in
 * the currency's own minor unit) and the rate as the engine stores it (base per one unit,
 * NUMERIC(18,8) text). Null for a base-currency line, which has no rate to show.
 */
export function fxNote(l: FxFields, baseCurrency: string): string | null {
  const currency = l.txn_currency ?? l.currency ?? null;
  const amount = l.txn_amount ?? l.currency_amount ?? null;
  const rate = l.fx_rate ?? null;
  if (!currency || currency === baseCurrency || !amount || !rate) return null;
  const text = formatMoney(amount, { currency, sign: 'minus' }).text.replace(/^-/, '');
  return `${currency} ${text} @ ${rate}`;
}

/** The open-items CSV help: the columns, and the three optional foreign-currency ones (T-0126). */
export function itemColumnsHelp(baseCurrency: string): string {
  return (
    'Columns party, document_no, document_date, due_date, amount and gst_amount. ' +
    'For an item in another currency add the optional columns currency, currency_amount and fx_rate: ' +
    `amount stays the old system’s carrying amount in ${baseCurrency} at the balance date, ` +
    `fx_rate is ${baseCurrency} per one unit of the currency (leave it empty and LedgerForce works it out). ` +
    'If the balance date ends a reporting period, revalue foreign items in the old system first.'
  );
}

/** Plain words put before an engine message, by refusal code. */
const LEAD: Readonly<Record<string, string>> = {
  FX_MISMATCH: 'the exchange rate times the currency amount does not give the amount',
};

/**
 * A 422 refusal from the opening-balance routes in plain words, naming the CSV line (`row`) or the
 * journal line (`line`); null for anything else (shown by the generic Refusal).
 */
export function obRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError) || error.status !== 422) return null;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : error.code;
  const row = error.body['row'];
  const line = error.body['line'];
  const lead = LEAD[error.code];
  if (lead && typeof row === 'number')
    return `LedgerForce did not accept the files: on line ${String(row)} of the file, ${lead}. ${message}.`;
  const where =
    typeof row === 'number'
      ? ` (line ${String(row)} of the file)`
      : typeof line === 'number'
        ? ` (journal line ${String(line)})`
        : '';
  return `LedgerForce did not accept the files: ${message}${where}.`;
}
