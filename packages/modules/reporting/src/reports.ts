/**
 * Reports read from the ledger (design §8.1, §3.3, §3.5; RQ-0037): trial balance, profit and
 * loss, balance sheet, and the close checklist's trial-balance review (UC-10, SS-UC10-08).
 * Ledger figures come only from packages/ledger's read API (accountMovements); this module
 * reads the company, chart, system roles and periods, and never touches ledger tables.
 */
import type { Database } from '@ledgerforce/db';
import { accountMovements } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';
import {
  shapeBalanceSheet,
  shapeProfitAndLoss,
  shapeTrialBalance,
  type BalanceSheet,
  type EarningsAccount,
  type ProfitAndLoss,
  type TrialBalance,
} from './statements.ts';

type Trx = Transaction<Database>;

export type ReportErrorCode =
  'INVALID_RANGE' | 'UNKNOWN_COMPANY' | 'NO_FISCAL_YEAR' | 'UNKNOWN_PERIOD' | 'UNBOUND_ROLE';

export class ReportError extends Error {
  readonly code: ReportErrorCode;
  constructor(code: ReportErrorCode, message: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date written YYYY-MM-DD (2026-02-30 rolls over in Date, so it is refused). */
function checkDate(value: string, field: string): string {
  const d = DATE_RE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ReportError('INVALID_RANGE', `${field} must be a date YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

function checkRange(from: string | null, to: string): void {
  checkDate(to, 'to');
  if (from !== null && checkDate(from, 'from') > to) {
    throw new ReportError('INVALID_RANGE', `from ${from} is after to ${to}`);
  }
}

/** The company's base currency (design §3.1); reports are in base currency. */
async function baseCurrency(trx: Trx, companyId: string): Promise<string> {
  const c = UUID_RE.test(companyId)
    ? await trx
        .selectFrom('app.company')
        .select('base_currency')
        .where('id', '=', companyId.toLowerCase())
        .executeTakeFirst()
    : undefined;
  if (!c) throw new ReportError('UNKNOWN_COMPANY', `no company ${companyId}`);
  return c.base_currency;
}

/** The accounts bound to the given system roles, in the order asked. */
async function roleAccounts<R extends string>(
  trx: Trx,
  companyId: string,
  roles: readonly R[],
): Promise<(EarningsAccount & { role: R })[]> {
  const rows = await trx
    .selectFrom('app.account_system_role as r')
    .innerJoin('app.account as a', (j) =>
      j.onRef('a.tenant_id', '=', 'r.tenant_id').onRef('a.id', '=', 'r.account_id'),
    )
    .select(['r.role', 'a.id', 'a.code', 'a.name', 'a.subtype'])
    .where('r.company_id', '=', companyId.toLowerCase())
    .where('r.role', 'in', [...roles])
    .execute();
  return roles.map((role) => {
    const a = rows.find((r) => r.role === role);
    if (!a) throw new ReportError('UNBOUND_ROLE', `system role ${role} has no account`);
    return { role, accountId: a.id, code: a.code, name: a.name, subtype: a.subtype };
  });
}

/**
 * Trial balance for a date range (from omitted = from the first period): every account with
 * posted activity, its net balance on the debit or credit side, base currency.
 */
export async function trialBalanceReport(trx: Trx, q: RangeQuery): Promise<TrialBalanceReport> {
  const from = q.from ?? null;
  checkRange(from, q.to);
  const currency = await baseCurrency(trx, q.companyId);
  const dimensionValueIds = [...(q.dimensionValueIds ?? [])];
  const rows = await accountMovements(trx, {
    companyId: q.companyId,
    from,
    to: q.to,
    dimensionValueIds,
  });
  return {
    companyId: q.companyId,
    from,
    to: q.to,
    dimensionValueIds,
    ...shapeTrialBalance(currency, rows),
  };
}

/** Profit and loss for [from, to]: revenue then expenses by subtype; net profit. */
export async function profitAndLossReport(
  trx: Trx,
  q: RangeQuery & { from: string },
): Promise<ProfitAndLossReport> {
  checkRange(q.from, q.to);
  const currency = await baseCurrency(trx, q.companyId);
  const dimensionValueIds = [...(q.dimensionValueIds ?? [])];
  const rows = await accountMovements(trx, {
    companyId: q.companyId,
    from: q.from,
    to: q.to,
    dimensionValueIds,
  });
  return {
    companyId: q.companyId,
    from: q.from,
    to: q.to,
    dimensionValueIds,
    ...shapeProfitAndLoss(currency, rows),
  };
}

/**
 * Balance sheet at a date (design §3.5): retained earnings = posted + all P&L before the fiscal
 * year holding the date; current-year earnings = P&L from the year start to the date.
 */
export async function balanceSheetReport(
  trx: Trx,
  q: { companyId: string; asAt: string },
): Promise<BalanceSheetReport> {
  checkDate(q.asAt, 'asAt');
  const currency = await baseCurrency(trx, q.companyId);
  const fy = await sql<{ label: string; start: string; end: string; dayBefore: string }>`
    SELECT label, start_date::text AS start, end_date::text AS end,
           (start_date - 1)::text AS "dayBefore"
      FROM app.fiscal_year
     WHERE company_id = ${q.companyId.toLowerCase()}
       AND ${q.asAt}::date BETWEEN start_date AND end_date`.execute(trx);
  const year = fy.rows[0];
  if (!year) throw new ReportError('NO_FISCAL_YEAR', `no fiscal year holds ${q.asAt}`);
  const [re, cye] = await roleAccounts(trx, q.companyId, [
    'RETAINED_EARNINGS',
    'CURRENT_YEAR_EARNINGS',
  ] as const);
  const toDate = await accountMovements(trx, { companyId: q.companyId, to: q.asAt });
  const beforeYear = await accountMovements(trx, { companyId: q.companyId, to: year.dayBefore });
  return {
    companyId: q.companyId,
    asAt: q.asAt,
    fiscalYear: { label: year.label, start: year.start, end: year.end },
    ...shapeBalanceSheet({
      currency,
      toDate,
      beforeYear,
      retainedEarnings: re as EarningsAccount,
      currentYearEarnings: cye as EarningsAccount,
    }),
  };
}

/**
 * The close checklist's TB review (UC-10 step "review TB", SS-UC10-08): the trial balance as at
 * the period end, whether it nets to zero, and the AR/AP control balances. The subledger side
 * is reported as not available until subledger_entry exists (T-0028, DL-0175).
 */
export async function trialBalanceReview(
  trx: Trx,
  q: { companyId: string; periodId: string },
): Promise<TrialBalanceReview> {
  const p = UUID_RE.test(q.periodId)
    ? await sql<{ id: string; name: string; start: string; end: string }>`
        SELECT id::text, name, start_date::text AS start, end_date::text AS end
          FROM app.fiscal_period
         WHERE company_id = ${q.companyId.toLowerCase()} AND id = ${q.periodId.toLowerCase()}`
        .execute(trx)
        .then((r) => r.rows[0])
    : undefined;
  if (!p) throw new ReportError('UNKNOWN_PERIOD', `no period ${q.periodId} in this company`);
  const trialBalance = await trialBalanceReport(trx, { companyId: q.companyId, to: p.end });
  const controls = await roleAccounts(trx, q.companyId, ['AR_CONTROL', 'AP_CONTROL'] as const);
  const currency = trialBalance.currency;
  return {
    companyId: q.companyId,
    period: p,
    trialBalance,
    netsToZero: trialBalance.netsToZero,
    controls: controls.map((c) => {
      const row = trialBalance.rows.find((r) => r.accountId === c.accountId);
      const debitNet = row ? row.debit.sub(row.credit) : Money.zero(currency);
      return {
        role: c.role,
        accountId: c.accountId,
        code: c.code,
        name: c.name,
        controlBalance: c.role === 'AR_CONTROL' ? debitNet : debitNet.negate(),
        subledgerBalance: null,
        status: 'subledger_not_available',
      };
    }),
  };
}
