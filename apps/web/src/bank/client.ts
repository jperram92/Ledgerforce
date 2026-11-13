/**
 * Bank reconciliation API client (T-0088) over the T-0149 routes under `/bank-rec`. Same origin,
 * session cookie; failures are AdminApiError (status + error code + the API's message). Money
 * stays a decimal string end to end; account numbers arrive masked ("***678").
 */
import type { AppEnv } from '../env.tsx';
import { AdminApiError } from '../admin/client.ts';
import type { Preview } from '../gl/client.ts';

export interface BankAccount {
  id: string;
  name: string;
  bsb: string;
  account_name: string;
  /** Always "***" and the last 3 characters (design §6.6). */
  account_number: string;
  currency: string;
  status: string;
}

export interface Statement {
  id: string;
  file_name: string | null;
  format: 'csv' | 'ofx' | 'camt053';
  period_start: string | null;
  period_end: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  lines_total: number;
  lines_unmatched: number;
  imported_at: string;
  reconciliation_id: string | null;
}

export interface ImportResult {
  outcome: 'imported' | 'duplicate_file' | 'duplicate_lines';
  statement_id: string;
  lines_in_file: number;
  lines_created: number;
  lines_duplicate: number;
  message: string;
  replayed: boolean;
}

export interface MatchingRun {
  lines_considered: number;
  auto_matched: number;
  suggested: number;
}

export interface Suggestion {
  id: string;
  kind: 'candidate' | 'rule';
  source_kind: string | null;
  journal_entry_id: string | null;
  entry_no: string | null;
  rule_id: string | null;
  rule_name: string | null;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
}

export interface StatementLine {
  id: string;
  statement_id: string;
  line_no: number;
  posted_on: string;
  amount: string;
  description: string;
  reference: string | null;
  status: 'unmatched' | 'matched' | 'excluded';
  match: {
    id: string;
    journal_entry_id: string;
    entry_no: string | null;
    method: string;
    source_kind: string;
  } | null;
  suggestions: Suggestion[];
}

export interface CounterLineInput {
  account_id: string;
  amount: string;
  memo?: string;
}

export interface TransactionInput {
  lines?: CounterLineInput[];
  from_suggestion_id?: string;
  memo?: string;
}

export interface TransactionResult {
  match_id: string;
  manual_journal_id: string;
  entry_id: string;
  entry_no: string;
  replayed: boolean;
}

/** The posting engine's preview of a transaction from a line: same shape as a journal preview. */
export type TransactionPreview = Preview;

export interface Report {
  statement_id: string;
  bank_account_id: string;
  currency: string;
  as_of: string;
  start_date: string;
  statement_closing_balance: string;
  book_balance: string;
  unreconciled_lines: {
    id: string;
    posted_on: string;
    description: string;
    reference: string | null;
    status: string;
    amount: string;
  }[];
  unreconciled_lines_total: string;
  unreconciled_book_items: {
    entry_id: string;
    entry_no: string | null;
    entry_date: string;
    source_type: string;
    memo: string | null;
    amount: string;
  }[];
  unreconciled_book_total: string;
  adjusted_statement_balance: string;
  difference: string;
  balanced: boolean;
  unreconciled_count: number;
  reconciliation_id: string | null;
}

export interface BankClient {
  accounts(companyId: string): Promise<{ accounts: BankAccount[] }>;
  statements(companyId: string, accountId: string): Promise<{ statements: Statement[] }>;
  importStatement(
    companyId: string,
    accountId: string,
    file: { name: string; base64: string },
    key: string,
  ): Promise<ImportResult>;
  runMatching(companyId: string, accountId: string, key: string): Promise<MatchingRun>;
  lines(
    companyId: string,
    accountId: string,
    statementId: string,
  ): Promise<{ lines: StatementLine[] }>;
  createTransaction(
    companyId: string,
    lineId: string,
    input: TransactionInput,
    key: string,
  ): Promise<TransactionResult>;
  /** The journal createTransaction would post for the same input (T-0150). Writes nothing. */
  previewTransaction(
    companyId: string,
    lineId: string,
    input: TransactionInput,
  ): Promise<TransactionPreview>;
  unmatch(companyId: string, lineId: string, key: string): Promise<unknown>;
  report(companyId: string, statementId: string, closingBalance?: string): Promise<Report>;
  complete(
    companyId: string,
    statementId: string,
    closingBalance: string | undefined,
    key: string,
  ): Promise<{ reconciliation_id: string; report: Report; replayed: boolean }>;
}

export function createBankClient(env: Pick<AppEnv, 'apiBase' | 'fetch'>): BankClient {
  async function send<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined) headers['idempotency-key'] = key;
    const res = await env.fetch(`${env.apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new AdminApiError(res.status, data);
    return data as T;
  }
  const seg = encodeURIComponent;
  const co = (companyId: string) => `company_id=${seg(companyId)}`;
  return {
    accounts: (companyId) => send('GET', `/bank-rec/accounts?${co(companyId)}`),
    statements: (companyId, accountId) =>
      send('GET', `/bank-rec/accounts/${seg(accountId)}/statements?${co(companyId)}`),
    importStatement: (companyId, accountId, file, key) =>
      send(
        'POST',
        `/bank-rec/accounts/${seg(accountId)}/statements`,
        { company_id: companyId, file_name: file.name, content_base64: file.base64 },
        key,
      ),
    runMatching: (companyId, accountId, key) =>
      send(
        'POST',
        `/bank-rec/accounts/${seg(accountId)}/matching-runs`,
        { company_id: companyId },
        key,
      ),
    lines: (companyId, accountId, statementId) =>
      send(
        'GET',
        `/bank-rec/accounts/${seg(accountId)}/lines?${co(companyId)}&statement_id=${seg(statementId)}`,
      ),
    createTransaction: (companyId, lineId, input, key) =>
      send(
        'POST',
        `/bank-rec/lines/${seg(lineId)}/transaction`,
        { company_id: companyId, ...input },
        key,
      ),
    previewTransaction: (companyId, lineId, input) =>
      send('POST', `/bank-rec/lines/${seg(lineId)}/transaction/preview`, {
        company_id: companyId,
        ...input,
      }),
    unmatch: (companyId, lineId, key) =>
      send('POST', `/bank-rec/lines/${seg(lineId)}/unmatch`, { company_id: companyId }, key),
    report: (companyId, statementId, closingBalance) =>
      send(
        'GET',
        `/bank-rec/statements/${seg(statementId)}/report?${co(companyId)}${
          closingBalance ? `&closing_balance=${seg(closingBalance)}` : ''
        }`,
      ),
    complete: (companyId, statementId, closingBalance, key) =>
      send(
        'POST',
        `/bank-rec/statements/${seg(statementId)}/reconciliation`,
        {
          company_id: companyId,
          ...(closingBalance ? { closing_balance: closingBalance } : {}),
        },
        key,
      ),
  };
}
