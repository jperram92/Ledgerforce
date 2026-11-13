/**
 * General ledger detail (T-0077, design §8.1, DL-0313): for a date range or a fiscal period,
 * optionally narrowed to accounts, dimension values and a party, each account's opening balance
 * (matching lines before `from`), its posted lines in date order with a running balance, and its
 * closing balance. Balances are debit-positive (a credit balance is negative), base currency.
 * Unfiltered, an account's closing balance equals its trial-balance net at `to`, so the detail
 * reconciles to the TB and, for AR/AP control accounts, to the aged reports.
 * Ledger figures come only from packages/ledger's read API (ledgerDetail); money is Money
 * (decimal.js), never a JS number.
 */
import type { AccountType, Database } from '@ledgerforce/db';
import { ledgerDetail } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared';
import { sql, type Transaction } from 'kysely';
import { baseCurrency, checkDate, checkRange, ReportError, UUID_RE } from './reports.ts';

type Trx = Transaction<Database>;

export interface GlDetailQuery {
  companyId: string;
  /** A fiscal period of the company; instead of from/to. */
  periodId?: string;
  /** YYYY-MM-DD inclusive; omitted = from the first posting. */
  from?: string | null;
  /** YYYY-MM-DD inclusive; required unless periodId is given. */
  to?: string;
  accountIds?: readonly string[];
  dimensionValueIds?: readonly string[];
  partyId?: string | null;
}

export interface GlDetailLine {
  entryId: string;
  entryNo: string | null;
  lineNo: number;
  date: string;
  sourceType: string;
  memo: string | null;
  partyId: string | null;
  partyName: string | null;
  debit: Money;
  credit: Money;
  /** Running balance after this line, debit-positive. */
  balance: Money;
  txnCurrency: string;
  txnAmount: string;
}

export interface GlDetailAccount {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  opening: Money;
  lines: GlDetailLine[];
  totalDebit: Money;
  totalCredit: Money;
  closing: Money;
}

export interface GlDetailReport {
  companyId: string;
  currency: string;
  from: string | null;
  to: string;
  periodId: string | null;
  accountIds: string[];
  dimensionValueIds: string[];
  partyId: string | null;
  accounts: GlDetailAccount[];
  totalDebit: Money;
  totalCredit: Money;
}

function uuids(ids: readonly string[] | undefined, field: string): string[] {
  return (ids ?? []).map((id) => {
    if (!UUID_RE.test(id))
      throw new ReportError('INVALID_FILTER', `${field}: "${id}" is not a uuid`);
    return id.toLowerCase();
  });
}

async function periodRange(trx: Trx, companyId: string, periodId: string) {
  const p = UUID_RE.test(periodId)
    ? (
        await sql<{ start: string; end: string }>`
          SELECT start_date::text AS start, end_date::text AS end FROM app.fiscal_period
           WHERE company_id = ${companyId.toLowerCase()} AND id = ${periodId.toLowerCase()}`.execute(
          trx,
        )
      ).rows[0]
    : undefined;
  if (!p) throw new ReportError('UNKNOWN_PERIOD', `no period ${periodId} in this company`);
  return p;
}

export async function glDetailReport(trx: Trx, q: GlDetailQuery): Promise<GlDetailReport> {
  const accountIds = uuids(q.accountIds, 'accountIds');
  const dimensionValueIds = uuids(q.dimensionValueIds, 'dimensionValueIds');
  const partyId = q.partyId ? (uuids([q.partyId], 'partyId')[0] ?? null) : null;
  let from = q.from ?? null;
  let to = q.to;
  if (q.periodId !== undefined) {
    if (q.from != null || q.to !== undefined)
      throw new ReportError('INVALID_RANGE', 'give either periodId or from/to, not both');
    const p = await periodRange(trx, q.companyId, q.periodId);
    from = p.start;
    to = p.end;
  }
  if (to === undefined) throw new ReportError('INVALID_RANGE', 'to (or periodId) is required');
  checkDate(to, 'to');
  checkRange(from, to);
  const currency = await baseCurrency(trx, q.companyId);
  const detail = await ledgerDetail(trx, {
    companyId: q.companyId,
    from,
    to,
    accountIds,
    dimensionValueIds,
    partyId,
  });
  const m = (s: string) => Money.of(s, currency);
  let totalDebit = Money.zero(currency);
  let totalCredit = Money.zero(currency);
  const byAccount = new Map<string, typeof detail.lines>();
  for (const l of detail.lines)
    byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);
  const accounts = detail.accounts.map((a): GlDetailAccount => {
    const opening = m(a.openingDebit).sub(m(a.openingCredit));
    let balance = opening;
    let debit = Money.zero(currency);
    let credit = Money.zero(currency);
    const lines = (byAccount.get(a.accountId) ?? []).map((l): GlDetailLine => {
      debit = debit.add(m(l.debit));
      credit = credit.add(m(l.credit));
      balance = balance.add(m(l.debit)).sub(m(l.credit));
      return {
        entryId: l.entryId,
        entryNo: l.entryNo,
        lineNo: l.lineNo,
        date: l.entryDate,
        sourceType: l.sourceType,
        memo: l.memo,
        partyId: l.partyId,
        partyName: l.partyName,
        debit: m(l.debit),
        credit: m(l.credit),
        balance,
        txnCurrency: l.txnCurrency,
        txnAmount: l.txnAmount,
      };
    });
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
    return {
      accountId: a.accountId,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      opening,
      lines,
      totalDebit: debit,
      totalCredit: credit,
      closing: balance,
    };
  });
  return {
    companyId: q.companyId,
    currency,
    from,
    to,
    periodId: q.periodId ?? null,
    accountIds,
    dimensionValueIds,
    partyId,
    accounts,
    totalDebit,
    totalCredit,
  };
}
