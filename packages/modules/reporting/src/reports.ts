/**
 * Reports read from the ledger (design §8.1, §3.3, §3.5; RQ-0037): trial balance, profit and
 * loss, balance sheet, and the close checklist's trial-balance review (UC-10, SS-UC10-08).
 * Ledger figures come only from packages/ledger's read API (accountMovements); this module
 * reads the company, chart, system roles and periods, and never touches ledger tables.
 */
import type { Database } from '@ledgerforce/db';
import type { Money } from '@ledgerforce/shared';
import type { Transaction } from 'kysely';
import type { BalanceSheet, ProfitAndLoss, TrialBalance } from './statements.ts';

type Trx = Transaction<Database>;

export type ReportErrorCode =
  | 'INVALID_RANGE'
  | 'UNKNOWN_COMPANY'
  | 'NO_FISCAL_YEAR'
  | 'UNKNOWN_PERIOD'
  | 'UNBOUND_ROLE';

export class ReportError extends Error {
  constructor(
    readonly code: ReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface RangeQuery {
  companyId: string;
  /** YYYY-MM-DD inclusive; null/omitted = from the first period (trial balance only). */
  from?: string | null;
  to: string;
  dimensionValueIds?: readonly string[];
}

export interface TrialBalanceReport extends TrialBalance {
  companyId: string;
  from: string | null;
  to: string;
  dimensionValueIds: string[];
}

export interface ProfitAndLossReport extends ProfitAndLoss {
  companyId: string;
  from: string;
  to: string;
  dimensionValueIds: string[];
}

export interface BalanceSheetReport extends BalanceSheet {
  companyId: string;
  asAt: string;
  fiscalYear: { label: string; start: string; end: string };
}

export interface ControlCheck {
  role: 'AR_CONTROL' | 'AP_CONTROL';
  accountId: string;
  code: string;
  name: string;
  /** Control account balance on its normal side (AR debit, AP credit) at the period end. */
  controlBalance: Money;
  /** Null until subledger_entry exists (T-0028); see DL-0175. */
  subledgerBalance: Money | null;
  status: 'subledger_not_available' | 'reconciled' | 'difference';
}

export interface TrialBalanceReview {
  companyId: string;
  period: { id: string; name: string; start: string; end: string };
  trialBalance: TrialBalanceReport;
  netsToZero: boolean;
  controls: ControlCheck[];
}

export async function trialBalanceReport(_trx: Trx, _q: RangeQuery): Promise<TrialBalanceReport> {
  throw new Error('trialBalanceReport: not implemented');
}

export async function profitAndLossReport(
  _trx: Trx,
  _q: RangeQuery & { from: string },
): Promise<ProfitAndLossReport> {
  throw new Error('profitAndLossReport: not implemented');
}

export async function balanceSheetReport(
  _trx: Trx,
  _q: { companyId: string; asAt: string },
): Promise<BalanceSheetReport> {
  throw new Error('balanceSheetReport: not implemented');
}

export async function trialBalanceReview(
  _trx: Trx,
  _q: { companyId: string; periodId: string },
): Promise<TrialBalanceReview> {
  throw new Error('trialBalanceReview: not implemented');
}
