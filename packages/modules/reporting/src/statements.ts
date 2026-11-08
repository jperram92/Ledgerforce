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

const money = (text: string, currency: string): Money => Money.fromNumeric(text, currency);

/** Net balance on the debit side (debit − credit). */
const netDebit = (r: AccountMovementRow, currency: string): Money =>
  money(r.debit, currency).sub(money(r.credit, currency));

const isProfitAndLoss = (r: AccountMovementRow): boolean =>
  r.type === 'revenue' || r.type === 'expense';

/** Σ (credit − debit) of the revenue and expense rows: profit, negative for a loss. */
export function profitOf(currency: string, rows: readonly AccountMovementRow[]): Money {
  return rows
    .filter(isProfitAndLoss)
    .reduce((sum, r) => sum.sub(netDebit(r, currency)), Money.zero(currency));
}

type SectionLine = StatementLine & { subtype: string };

/**
 * One section: lines grouped by subtype; groups ordered by their lowest account code and lines
 * by code, so the chart's numbering (data, not code) decides the layout.
 */
function section(
  type: AccountType,
  currency: string,
  lines: readonly SectionLine[],
): StatementSection {
  const sorted = [...lines].sort((a, b) => a.code.localeCompare(b.code));
  const groups: StatementGroup[] = [];
  for (const { subtype, ...line } of sorted) {
    let g = groups.find((x) => x.subtype === subtype);
    if (!g) {
      g = { subtype, lines: [], total: Money.zero(currency) };
      groups.push(g);
    }
    g.lines.push(line);
    g.total = g.total.add(line.amount);
  }
  const total = groups.reduce((sum, g) => sum.add(g.total), Money.zero(currency));
  return { type, groups, total };
}

/** Rows of one type as lines: assets and expenses debit-positive, the rest credit-positive. */
function linesOf(
  type: AccountType,
  currency: string,
  rows: readonly AccountMovementRow[],
): SectionLine[] {
  const debitPositive = type === 'asset' || type === 'expense';
  return rows
    .filter((r) => r.type === type)
    .map((r) => {
      const net = netDebit(r, currency);
      return {
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        subtype: r.subtype,
        amount: debitPositive ? net : net.negate(),
      };
    });
}

export function shapeTrialBalance(
  currency: string,
  rows: readonly AccountMovementRow[],
): TrialBalance {
  const zero = Money.zero(currency);
  const out: TrialBalanceRow[] = [...rows]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => {
      const net = netDebit(r, currency);
      return {
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        debit: net.isPositive() ? net : zero,
        credit: net.isNegative() ? net.negate() : zero,
      };
    });
  const totalDebit = out.reduce((s, r) => s.add(r.debit), zero);
  const totalCredit = out.reduce((s, r) => s.add(r.credit), zero);
  return {
    currency,
    rows: out,
    totalDebit,
    totalCredit,
    netsToZero: totalDebit.equals(totalCredit),
  };
}

export function shapeProfitAndLoss(
  currency: string,
  rows: readonly AccountMovementRow[],
): ProfitAndLoss {
  const revenue = section('revenue', currency, linesOf('revenue', currency, rows));
  const expenses = section('expense', currency, linesOf('expense', currency, rows));
  return { currency, revenue, expenses, netProfit: revenue.total.sub(expenses.total) };
}

export function shapeBalanceSheet(input: BalanceSheetInput): BalanceSheet {
  const { currency, toDate, beforeYear, retainedEarnings: re, currentYearEarnings: cye } = input;
  const priorYearsEarnings = profitOf(currency, beforeYear);
  const currentYearEarnings = profitOf(currency, toDate).sub(priorYearsEarnings);
  const equityLines = linesOf('equity', currency, toDate);
  const posted = (id: string): Money =>
    equityLines.find((l) => l.accountId === id)?.amount ?? Money.zero(currency);
  const computed = (a: EarningsAccount, add: Money): SectionLine => ({
    accountId: a.accountId,
    code: a.code,
    name: a.name,
    subtype: a.subtype,
    amount: posted(a.accountId).add(add),
    computed: true,
  });
  const assets = section('asset', currency, linesOf('asset', currency, toDate));
  const liabilities = section('liability', currency, linesOf('liability', currency, toDate));
  const equity = section('equity', currency, [
    ...equityLines.filter((l) => l.accountId !== re.accountId && l.accountId !== cye.accountId),
    computed(re, priorYearsEarnings),
    computed(cye, currentYearEarnings),
  ]);
  const totalLiabilitiesAndEquity = liabilities.total.add(equity.total);
  return {
    currency,
    assets,
    liabilities,
    equity,
    totalLiabilitiesAndEquity,
    priorYearsEarnings,
    currentYearEarnings,
    balanced: assets.total.equals(totalLiabilitiesAndEquity),
  };
}
