/**
 * Financial statements shaped from posted account movements (design §8.1, §3.5; RQ-0037).
 * Pure functions: no database. Amounts arrive as NUMERIC text and stay exact in Money
 * (decimal.js); never JS numbers.
 *
 *  - Trial balance: each account's net balance on its debit or credit side; totals; netsToZero.
 *  - Profit and loss: revenue then expenses, grouped by subtype (chart-template order, unknown
 *    subtypes after, alphabetically); revenue credit-positive, expenses debit-positive.
 *  - Balance sheet: assets debit-positive, liabilities and equity credit-positive. Retained
 *    earnings line = its posted balance + P&L before the fiscal year; current-year earnings line
 *    = its posted balance + P&L for the fiscal year to date. Both are always shown.
 */
import type { AccountMovementRow } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared';

export type AccountType = AccountMovementRow['type'];

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  /** Net debit balance (0 when the account nets to credit). */
  debit: Money;
  /** Net credit balance (0 when the account nets to debit). */
  credit: Money;
}

export interface TrialBalance {
  currency: string;
  rows: TrialBalanceRow[];
  totalDebit: Money;
  totalCredit: Money;
  netsToZero: boolean;
}

export interface StatementLine {
  accountId: string;
  code: string;
  name: string;
  amount: Money;
  /** True for the lines the report computes (retained / current-year earnings). */
  computed?: boolean;
}

export interface StatementGroup {
  subtype: string;
  lines: StatementLine[];
  total: Money;
}

export interface StatementSection {
  type: AccountType;
  groups: StatementGroup[];
  total: Money;
}

export interface ProfitAndLoss {
  currency: string;
  revenue: StatementSection;
  expenses: StatementSection;
  netProfit: Money;
}

export interface EarningsAccount {
  accountId: string;
  code: string;
  name: string;
  subtype: string;
}

export interface BalanceSheetInput {
  currency: string;
  /** Movements of every account from the first period to the report date. */
  toDate: readonly AccountMovementRow[];
  /** Movements from the first period to the day before the fiscal year starts. */
  beforeYear: readonly AccountMovementRow[];
  retainedEarnings: EarningsAccount;
  currentYearEarnings: EarningsAccount;
}

export interface BalanceSheet {
  currency: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  totalLiabilitiesAndEquity: Money;
  /** P&L of all years before the fiscal year (included in the retained-earnings line). */
  priorYearsEarnings: Money;
  /** P&L of the fiscal year to the report date (the current-year-earnings line). */
  currentYearEarnings: Money;
  /** Assets = liabilities + equity. */
  balanced: boolean;
}

/** Subtype order of the AU templates; others follow alphabetically. */
export const SUBTYPE_ORDER: readonly string[] = [];

export function shapeTrialBalance(
  _currency: string,
  _rows: readonly AccountMovementRow[],
): TrialBalance {
  throw new Error('shapeTrialBalance: not implemented');
}

export function shapeProfitAndLoss(
  _currency: string,
  _rows: readonly AccountMovementRow[],
): ProfitAndLoss {
  throw new Error('shapeProfitAndLoss: not implemented');
}

export function shapeBalanceSheet(_input: BalanceSheetInput): BalanceSheet {
  throw new Error('shapeBalanceSheet: not implemented');
}
