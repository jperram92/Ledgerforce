/**
 * Aged receivables and customer statements (T-0049, design §3.3, §8.1; RQ-0122; DL-0360…DL-0363).
 * Read-only: open items and allocations come from packages/ledger's read API (openItemsAsOf,
 * allocationsBetween, subledgerReconciliation); this module reads only the company, the party and
 * its own AR document tables (for document numbers). Nothing is written.
 *
 * - agedReceivables: every customer's open AR items as at a date, aged by due date in base
 *   currency, credits apart, with the reconciliation to the AR control account.
 * - customerReceivableTotals: one party's balance due (net) and overdue amount as at a date —
 *   the values T-0110's write-back sends to Account.LF_Balance_Due__c / LF_Overdue_Amount__c.
 * - customerStatement: one party's statement for a date range (customer-statement.ts).
 */
import type { Database } from '@ledgerforce/db';
import {
  allocationsBetween,
  openItemsAsOf,
  subledgerReconciliation,
  type OpenItemAsOf,
} from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { sql, type Transaction } from 'kysely';
import { ageOpenItems, type Ageing, type AgeingInput } from './ageing.ts';
import { shapeStatement, type StatementBody } from './customer-statement.ts';

type Trx = Transaction<Database>;

export type AgedReceivablesErrorCode = 'INVALID_RANGE' | 'UNKNOWN_COMPANY' | 'UNKNOWN_PARTY';

export class AgedReceivablesError extends DomainError {
  declare readonly code: AgedReceivablesErrorCode;
}

const X = 'XXX';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const lc = (s: string) => s.toLowerCase();

function safeDate(s: unknown, what: string): string {
  const t = typeof s === 'string' && DATE_RE.test(s) ? Date.parse(`${s}T00:00:00Z`) : Number.NaN;
  if (typeof s !== 'string' || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
    throw new AgedReceivablesError('INVALID_RANGE', `${what} ${JSON.stringify(s)} is not a date`);
  }
  return s;
}

async function companyCurrency(trx: Trx, companyId: string): Promise<string> {
  const r = UUID_RE.test(companyId)
    ? await sql<{ base_currency: string }>`
        SELECT base_currency FROM app.company WHERE id = ${lc(companyId)}`.execute(trx)
    : { rows: [] };
  const c = r.rows[0];
  if (!c) throw new AgedReceivablesError('UNKNOWN_COMPANY', `no company ${companyId}`);
  return c.base_currency;
}

async function partyName(trx: Trx, companyId: string, partyId: string): Promise<string> {
  const r = UUID_RE.test(partyId)
    ? await sql<{ name: string }>`
        SELECT coalesce(trading_name, legal_name) AS name FROM app.party
         WHERE company_id = ${lc(companyId)} AND id = ${lc(partyId)}`.execute(trx)
    : { rows: [] };
  const p = r.rows[0];
  if (!p)
    throw new AgedReceivablesError('UNKNOWN_PARTY', `no party ${partyId} in company ${companyId}`);
  return p.name;
}

/**
 * Document numbers by journal entry id, from the AR document tables (invoice no, credit-note no,
 * receipt reference). Items of other sources fall back to the subledger document id.
 */
async function referencesOf(
  trx: Trx,
  companyId: string,
  entryIds: readonly string[],
): Promise<Map<string, string>> {
  if (entryIds.length === 0) return new Map();
  const ids = sql.val([...new Set(entryIds)]);
  const r = await sql<{ entry_id: string; ref: string | null }>`
    SELECT journal_entry_id::text AS entry_id, invoice_no AS ref FROM app.sales_invoice
     WHERE company_id = ${companyId} AND journal_entry_id = ANY(${ids}::uuid[])
    UNION ALL
    SELECT journal_entry_id::text, credit_note_no FROM app.credit_note
     WHERE company_id = ${companyId} AND journal_entry_id = ANY(${ids}::uuid[])
    UNION ALL
    SELECT journal_entry_id::text, coalesce(reference, 'Receipt ' || to_char(receipt_date, 'YYYY-MM-DD'))
      FROM app.ar_receipt
     WHERE company_id = ${companyId} AND journal_entry_id = ANY(${ids}::uuid[])`.execute(trx);
  const out = new Map<string, string>();
  for (const row of r.rows) if (row.ref !== null) out.set(row.entry_id, row.ref);
  return out;
}

async function partyNames(
  trx: Trx,
  companyId: string,
  partyIds: readonly string[],
): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map();
  const r = await sql<{ id: string; name: string }>`
    SELECT id::text, coalesce(trading_name, legal_name) AS name FROM app.party
     WHERE company_id = ${companyId} AND id = ANY(${sql.val([...new Set(partyIds)])}::uuid[])`.execute(
    trx,
  );
  return new Map(r.rows.map((x) => [x.id, x.name]));
}

const toAgeingInput = (
  i: OpenItemAsOf,
  refs: Map<string, string>,
  names: Map<string, string>,
): AgeingInput => ({
  itemId: i.id,
  partyId: i.partyId,
  partyName: i.partyId === null ? null : (names.get(i.partyId) ?? null),
  sourceType: i.sourceType,
  documentId: i.documentId,
  reference: refs.get(i.entryId) ?? i.documentId,
  documentDate: i.documentDate,
  dueDate: i.dueDate,
  currency: i.currency,
  amount: i.baseOpenAmountAsOf,
});

export interface AgedReceivablesReconciliation {
  /** AR control balance as at the date (Σ debit − credit, base currency). */
  controlBalance: string;
  /** Σ base open amounts of AR items as at the date (= the ageing total). */
  subledgerBalance: string;
  /** Realised FX on allocations not yet posted (DL-0187), a reconciling item. */
  unpostedFxDifference: string;
  /** subledger − (control + unposted FX); zero when reconciled. */
  difference: string;
  reconciled: boolean;
}

export interface AgedReceivablesReport extends Ageing {
  companyId: string;
  /** Base currency: every amount in the report. */
  currency: string;
  reconciliation: AgedReceivablesReconciliation;
}

/** Aged receivables as at `asOf` (inclusive), by due date, base currency (AC-1). */
export async function agedReceivables(
  trx: Trx,
  q: { companyId: string; asOf: string },
): Promise<AgedReceivablesReport> {
  const asOf = safeDate(q.asOf, 'asOf');
  const currency = await companyCurrency(trx, q.companyId);
  const companyId = lc(q.companyId);
  const items = await openItemsAsOf(trx, {
    companyId,
    asOf,
    controlRole: 'AR_CONTROL',
    openOnly: true,
  });
  const refs = await referencesOf(
    trx,
    companyId,
    items.map((i) => i.entryId),
  );
  const names = await partyNames(
    trx,
    companyId,
    items.flatMap((i) => (i.partyId === null ? [] : [i.partyId])),
  );
  const ageing = ageOpenItems(
    items
      .filter((i) => !Money.of(i.baseOpenAmountAsOf, X).isZero())
      .map((i) => toAgeingInput(i, refs, names)),
    asOf,
  );
  const rec = (await subledgerReconciliation(trx, { companyId, asOf })).find(
    (r) => r.controlRole === 'AR_CONTROL',
  );
  if (!rec) throw new Error('aged receivables: no AR_CONTROL reconciliation row');
  const m = (s: string) => Money.of(s, X).toNumericString();
  return {
    companyId,
    currency,
    ...ageing,
    reconciliation: {
      controlBalance: m(rec.controlBalance),
      subledgerBalance: m(rec.subledgerBalance),
      unpostedFxDifference: m(rec.unpostedFxDifference),
      difference: m(rec.difference),
      reconciled:
        rec.reconciled &&
        Money.of(rec.subledgerBalance, X).equals(Money.of(ageing.totals.total, X)),
    },
  };
}

export interface CustomerReceivableTotals {
  partyId: string;
  asOf: string;
  currency: string;
  /** Net receivable (Σ buckets + unallocated credits); negative when the party is in credit. */
  balanceDue: string;
  /** Σ of the 1–30 … 90+ buckets. */
  overdueAmount: string;
}

/** One party's aged totals as at `asOf` (SS-UC12-05; the write-back producer is T-0110). */
export async function customerReceivableTotals(
  trx: Trx,
  q: { companyId: string; partyId: string; asOf: string },
): Promise<CustomerReceivableTotals> {
  const asOf = safeDate(q.asOf, 'asOf');
  const currency = await companyCurrency(trx, q.companyId);
  const companyId = lc(q.companyId);
  await partyName(trx, companyId, q.partyId);
  const partyId = lc(q.partyId);
  const items = await openItemsAsOf(trx, {
    companyId,
    asOf,
    controlRole: 'AR_CONTROL',
    partyId,
    openOnly: true,
  });
  const a = ageOpenItems(
    items.map((i) => toAgeingInput(i, new Map(), new Map())),
    asOf,
  );
  return {
    partyId,
    asOf,
    currency,
    balanceDue: a.totals.total,
    overdueAmount: a.totals.overdue,
  };
}

export interface CustomerStatement extends StatementBody {
  companyId: string;
  party: { id: string; name: string };
}

/** A party's statement for [from, to], one section per transaction currency (DL-0362). */
export async function customerStatement(
  trx: Trx,
  q: { companyId: string; partyId: string; from: string; to: string },
): Promise<CustomerStatement> {
  const from = safeDate(q.from, 'from');
  const to = safeDate(q.to, 'to');
  if (from > to) throw new AgedReceivablesError('INVALID_RANGE', `from ${from} is after to ${to}`);
  await companyCurrency(trx, q.companyId);
  const companyId = lc(q.companyId);
  const name = await partyName(trx, companyId, q.partyId);
  const partyId = lc(q.partyId);
  const items = await openItemsAsOf(trx, {
    companyId,
    asOf: to,
    controlRole: 'AR_CONTROL',
    partyId,
  });
  const allocations = await allocationsBetween(trx, {
    companyId,
    from,
    to,
    controlRole: 'AR_CONTROL',
    partyId,
  });
  const refs = await referencesOf(
    trx,
    companyId,
    items.map((i) => i.entryId),
  );
  const body = shapeStatement(
    items.map((i) => ({
      itemId: i.id,
      entryId: i.entryId,
      sourceType: i.sourceType,
      documentId: i.documentId,
      reference: refs.get(i.entryId) ?? i.documentId,
      documentDate: i.documentDate,
      dueDate: i.dueDate,
      currency: i.currency,
      originalAmount: i.originalAmount,
      openAmountAsOf: i.openAmountAsOf,
    })),
    allocations.map((a) => ({
      allocationId: a.allocationId,
      allocationDate: a.allocationDate,
      amount: a.amount,
      currency: a.currency,
      fromItemId: a.fromEntryId,
      toItemId: a.toEntryId,
      reversalOfId: a.reversalOfId,
    })),
    { from, to },
  );
  return { companyId, party: { id: partyId, name }, ...body };
}
