/**
 * Reports API client (T-0089): trial balance, profit and loss, balance sheet, general-ledger detail
 * (apps/api ReportsController, T-0077/T-0089) and aged receivables / payables. Same origin, session
 * cookie; failures are AdminApiError (status + error code). Money stays the API's decimal string:
 * the screens format it for reading and never add it up.
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';

export interface ReportCompany {
  id: string;
  name: string;
  base_currency: string;
}

export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  debit: string;
  credit: string;
}

export interface TrialBalance {
  currency: string;
  from: string | null;
  to: string;
  rows: TrialBalanceRow[];
  total_debit: string;
  total_credit: string;
  nets_to_zero: boolean;
}

export interface StatementLine {
  account_id: string;
  code: string;
  name: string;
  amount: string;
  /** Worked out by the report (retained / current-year earnings), not a posted balance. */
  computed: boolean;
}

export interface StatementSection {
  type: string;
  total: string;
  groups: { subtype: string; total: string; lines: StatementLine[] }[];
}

export interface ProfitAndLoss {
  currency: string;
  from: string;
  to: string;
  revenue: StatementSection;
  expenses: StatementSection;
  net_profit: string;
}

export interface BalanceSheet {
  currency: string;
  as_at: string;
  fiscal_year: { label: string; start: string; end: string };
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  total_liabilities_and_equity: string;
  prior_years_earnings: string;
  current_year_earnings: string;
  balanced: boolean;
}

export interface GlDetailLine {
  entry_id: string;
  entry_no: string | null;
  line_no: number;
  date: string;
  source_type: string;
  memo: string | null;
  party_id: string | null;
  party_name: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface GlDetailAccount {
  account_id: string;
  code: string;
  name: string;
  type: string;
  opening: string;
  lines: GlDetailLine[];
  total_debit: string;
  total_credit: string;
  closing: string;
}

export interface GlDetail {
  currency: string;
  from: string | null;
  to: string;
  accounts: GlDetailAccount[];
  total_debit: string;
  total_credit: string;
}

export const AGE_BUCKETS = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'days90plus',
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export type AgedRow = { partyId: string; partyName: string; total: string } & Record<
  AgeBucket,
  string
>;

export interface Aged {
  asOf: string;
  rows: AgedRow[];
  totals: Record<AgeBucket | 'total', string>;
}

export interface RangeQuery {
  from?: string | null | undefined;
  to: string;
}

export interface GlDetailQuery extends RangeQuery {
  accountId?: string | undefined;
  partyId?: string | undefined;
}

export interface ReportsClient {
  companies(): Promise<ReportCompany[]>;
  trialBalance(companyId: string, q: RangeQuery): Promise<TrialBalance>;
  profitAndLoss(companyId: string, q: { from: string; to: string }): Promise<ProfitAndLoss>;
  balanceSheet(companyId: string, asAt: string): Promise<BalanceSheet>;
  glDetail(companyId: string, q: GlDetailQuery): Promise<GlDetail>;
  agedReceivables(companyId: string, asOf: string): Promise<Aged>;
  agedPayables(companyId: string, asOf: string): Promise<Aged>;
}

/** `?company_id=…&from=…` in the given order, leaving out empty values. */
export function query(pairs: [string, string | null | undefined][]): string {
  const p = new URLSearchParams();
  for (const [k, v] of pairs) if (v) p.append(k, v);
  return `?${p.toString()}`;
}

export function createReportsClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): ReportsClient {
  async function get<T>(path: string): Promise<T> {
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  return {
    companies: () => get('/companies'),
    trialBalance: (co, q) =>
      get(
        `/gl/trial-balance${query([
          ['company_id', co],
          ['from', q.from],
          ['to', q.to],
        ])}`,
      ),
    profitAndLoss: (co, q) =>
      get(
        `/gl/profit-and-loss${query([
          ['company_id', co],
          ['from', q.from],
          ['to', q.to],
        ])}`,
      ),
    balanceSheet: (co, asAt) =>
      get(
        `/gl/balance-sheet${query([
          ['company_id', co],
          ['as_at', asAt],
        ])}`,
      ),
    glDetail: (co, q) =>
      get(
        `/gl/detail${query([
          ['company_id', co],
          ['from', q.from],
          ['to', q.to],
          ['account_id', q.accountId],
          ['party_id', q.partyId],
        ])}`,
      ),
    agedReceivables: (co, asOf) =>
      get(
        `/ar/aged-receivables${query([
          ['company_id', co],
          ['as_of', asOf],
        ])}`,
      ),
    agedPayables: (co, asOf) =>
      get(
        `/ap/aged-payables${query([
          ['company_id', co],
          ['as_of', asOf],
        ])}`,
      ),
  };
}
