/**
 * Opening balances screen wording (T-0177, design §4.1 step 9, GP-037, DL-0651). No accounting
 * here: the journal comes from the posting engine's preview (POST /setup/opening-balances/preview).
 * This file only picks which side of a line holds the amount (on the decimal string, never as a
 * number), says dates in words and words the API's refusals.
 */
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

/**
 * A 422 refusal from the opening-balance routes in plain words, naming the CSV line (`row`) or the
 * journal line (`line`); null for anything else (shown by the generic Refusal).
 */
export function obRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError) || error.status !== 422) return null;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : error.code;
  const row = error.body['row'];
  const line = error.body['line'];
  const where =
    typeof row === 'number'
      ? ` (line ${String(row)} of the file)`
      : typeof line === 'number'
        ? ` (journal line ${String(line)})`
        : '';
  return `LedgerForce did not accept the files: ${message}${where}.`;
}
