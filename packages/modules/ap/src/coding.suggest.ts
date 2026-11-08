/**
 * Suggested coding for a supplier bill line (T-0050, UC-05 step 2, RQ-0106 F2, DL-0291).
 *
 * Pure and deterministic — the same inputs in any order give the same suggestion:
 *  1. Supplier history: lines of the supplier's posted bills, the most recent HISTORY_WINDOW bills
 *     (bill date desc, bill number desc). A line with a product looks only at history lines of
 *     that product. The most frequent (account, tax code) pair wins; a tie goes to the most
 *     recently used pair (bill date, bill number, line number), then account id and tax code.
 *  2. Product profile: the posting-profile resolver's account and tax code for the purchase
 *     (computed by the caller; taxCode null after a TAX_CODE_CONFLICT, DL-0260).
 *  3. Otherwise null. A suggestion is only ever offered, never applied silently.
 */

/** How many of the supplier's most recent posted bills the history looks at. */
export const HISTORY_WINDOW = 5;

export interface CodingHistoryLine {
  billId: string;
  billNo: string;
  /** YYYY-MM-DD */
  billDate: string;
  lineNo: number;
  productId: string | null;
  accountId: string;
  taxCode: string;
}

export interface ProfileCoding {
  accountId: string;
  /** null when the resolver could not choose one (TAX_CODE_CONFLICT / NO_TAX_CODE). */
  taxCode: string | null;
  basis: string;
}

export type CodingSource = 'supplier_history' | 'product_profile';

export interface CodingSuggestion {
  accountId: string;
  taxCode: string | null;
  source: CodingSource;
  /** Why, in words, for the clerk. */
  basis: string;
}

export interface SuggestCodingInput {
  history: readonly CodingHistoryLine[];
  productId?: string | null | undefined;
  profile?: ProfileCoding | null | undefined;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Recency order of bills: later date first, then higher bill number, then id (total order). */
const billRecency = (a: CodingHistoryLine, b: CodingHistoryLine): number =>
  cmp(b.billDate, a.billDate) || cmp(b.billNo, a.billNo) || cmp(a.billId, b.billId);

/** Recency order of lines: bill recency, then the later line on the same bill first. */
const lineRecency = (a: CodingHistoryLine, b: CodingHistoryLine): number =>
  billRecency(a, b) || b.lineNo - a.lineNo;

export function suggestCoding(input: SuggestCodingInput): CodingSuggestion | null {
  const product = input.productId ?? null;
  const relevant = input.history.filter((l) => product === null || l.productId === product);
  if (relevant.length > 0) {
    const bills = new Map<string, CodingHistoryLine>();
    for (const l of [...relevant].sort(billRecency)) if (!bills.has(l.billId)) bills.set(l.billId, l);
    const window = new Set([...bills.keys()].slice(0, HISTORY_WINDOW));
    const lines = relevant.filter((l) => window.has(l.billId)).sort(lineRecency);
    const pairs = new Map<string, { line: CodingHistoryLine; count: number; rank: number }>();
    lines.forEach((l, rank) => {
      const key = JSON.stringify([l.accountId, l.taxCode]);
      const p = pairs.get(key);
      if (p) p.count += 1;
      else pairs.set(key, { line: l, count: 1, rank });
    });
    const best = [...pairs.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.rank - b.rank ||
        cmp(a.line.accountId, b.line.accountId) ||
        cmp(a.line.taxCode, b.line.taxCode),
    )[0];
    if (best) {
      return {
        accountId: best.line.accountId,
        taxCode: best.line.taxCode,
        source: 'supplier_history',
        basis: `${String(best.count)} of ${String(lines.length)} lines on the last ${String(window.size)} posted bills`,
      };
    }
  }
  if (input.profile) {
    return {
      accountId: input.profile.accountId,
      taxCode: input.profile.taxCode,
      source: 'product_profile',
      basis: input.profile.basis,
    };
  }
  return null;
}
