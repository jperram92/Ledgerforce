import type { Money } from '@ledgerforce/shared/money';

export type StatementFormat = 'csv' | 'ofx' | 'camt053';

/**
 * One normalised statement line — the SS-UC08-01 contract every format produces (RQ-0019).
 * amount: + money into the bank account, − money out.
 */
export interface StatementLine {
  /** Posting date as the bank wrote it, "YYYY-MM-DD". */
  postedOn: string;
  amount: Money;
  /** Whitespace-collapsed; may be empty when the bank gives no text. */
  description: string;
  reference: string | null;
  /** The bank's own id for the transaction (OFX FITID, CAMT AcctSvcrRef, a CSV id column). */
  bankTxnId: string | null;
  /**
   * Only on a line split from a CAMT batch entry (RQ-0028): the entry's bank reference
   * (AcctSvcrRef, else NtryRef, or null) and this part's position among the entry's parts.
   * The parts of one entry add up exactly to its booked amount.
   */
  batch?: { entryRef: string | null; part: number; parts: number };
}

export interface ParsedStatement {
  format: StatementFormat;
  /** Currency the file declares, or null when it declares none (CSV). */
  currency: string | null;
  /** Account identifier the file declares (OFX ACCTID, CAMT Acct/Id), or null. */
  accountRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: Money | null;
  closingBalance: Money | null;
  /** In file order. */
  lines: StatementLine[];
}

export const LIMITS = { description: 2000, reference: 255, bankTxnId: 255, entryRef: 255 } as const;
