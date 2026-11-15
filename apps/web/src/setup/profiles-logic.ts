/**
 * Posting-profile matrix wording (T-0188, design §4.4, ADR-0082, DL-0654). No accounting here: the
 * API resolves every cell with the posting rule (T-0187). This file only words the answer, and
 * says which override field fills which kind of gap.
 */
import { AdminApiError } from '../admin/client.ts';
import type { MatrixCell } from './client.ts';

export function gapSummary(gaps: number): string {
  if (gaps === 0) return 'No gaps: every combination has an account and a tax code.';
  if (gaps === 1) return '1 gap: a document that needs it cannot post.';
  return `${String(gaps)} gaps: a document that needs one of them cannot post.`;
}

/** The cell's state in one word (P12; the mockup's colours repeat it, never replace it). */
export function cellWord(c: MatrixCell): 'Default' | 'Override' | 'Gap' {
  if (c.gap) return 'Gap';
  return c.account_source === 'override' ? 'Override' : 'Default';
}

/**
 * The override field that fills this gap: the income account for a sale, the expense account
 * for a purchase, the tax code when two exemptions disagree (or a code is not in force); null
 * when an override cannot fill it (the profile's own control account or kind is wrong).
 */
export function fillField(
  c: MatrixCell,
): 'revenue_account_id' | 'expense_account_id' | 'tax_code' | null {
  if (!c.gap) return null;
  if (c.gap.reason === 'account')
    return c.purpose === 'sale' ? 'revenue_account_id' : 'expense_account_id';
  if (c.gap.reason === 'tax_code') return 'tax_code';
  return null;
}

/** A refusal of PUT /posting-profiles/overrides in plain words; null for anything else. */
export function fillRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError) || (error.status !== 422 && error.status !== 404))
    return null;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : error.code;
  return `LedgerForce did not accept this account: ${message}.`;
}
