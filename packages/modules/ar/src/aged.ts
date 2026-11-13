/**
 * Aged receivables, the Account write-back snapshot and customer statements (T-0049, design §8.1
 * AR statements/ageing, §5.4 write-back, UC-12, DL-0287). Reads only.
 *
 * Ageing: every AR open item dated on or before the as-at date, open amount as at that date
 * (original less allocations dated on or before it, the same rule as subledgerReconciliation),
 * bucketed by days past its due date: current (not yet due), 1–30, 31–60, 61–90, 90+. Credits
 * (unapplied receipts, credit notes) are never overdue: they sit in `current`, reducing the
 * balance but not the overdue amount. The buckets sum to the AR control balance at the date.
 * Money is decimal strings; no floating point.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const;
type Bucket = (typeof BUCKETS)[number];

export type AgedRow = {
  readonly partyId: string;
  readonly partyName: string;
  readonly total: string;
} & Readonly<Record<Bucket, string>>;

export interface AgedReceivables {
  readonly asOf: string;
  readonly rows: readonly AgedRow[];
  readonly totals: Readonly<Record<Bucket | 'total', string>>;
}

const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bucketOf(daysPastDue: number): Bucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1to30';
  if (daysPastDue <= 60) return 'days31to60';
  if (daysPastDue <= 90) return 'days61to90';
  return 'days90plus';
}

async function openItems(trx: Trx, companyId: string, asOf: string, partyId?: string) {
  return (
    await sql<{ party_id: string; party_name: string; days: number; open: string }>`
      WITH items AS (
        SELECT s.* FROM app.subledger_entry s
         WHERE s.company_id = ${companyId} AND s.control_role = 'AR_CONTROL'
           AND s.document_date <= ${asOf}::date
           ${partyId ? sql`AND s.party_id = ${partyId}::uuid` : sql``}),
      released AS (
        SELECT i.id, sum(sign(i.base_original_amount) *
                 CASE WHEN a.from_entry_id = i.id THEN a.from_base_amount ELSE a.to_base_amount END) AS r
          FROM items i
          JOIN app.allocation a ON (a.from_entry_id = i.id OR a.to_entry_id = i.id)
                               AND a.allocation_date <= ${asOf}::date
         GROUP BY i.id)
      SELECT i.party_id::text, p.legal_name AS party_name, (${asOf}::date - i.due_date) AS days,
             (i.base_original_amount - coalesce(r.r, 0))::text AS open
        FROM items i
        JOIN app.party p ON p.tenant_id = i.tenant_id AND p.id = i.party_id
        LEFT JOIN released r ON r.id = i.id
       WHERE i.base_original_amount - coalesce(r.r, 0) <> 0
       ORDER BY p.legal_name, i.party_id, i.due_date`.execute(trx)
  ).rows;
}

/** Aged receivables as at `asOf`, one row per customer with an open balance. */
export async function agedReceivables(
  trx: Trx,
  q: { companyId: string; asOf: string },
): Promise<AgedReceivables> {
  if (!DATE_RE.test(q.asOf)) throw new RangeError('asOf is YYYY-MM-DD');
  const companyId = q.companyId.toLowerCase();
  const zero = () =>
    Object.fromEntries([...BUCKETS, 'total'].map((b) => [b, new Decimal(0)])) as Record<
      Bucket | 'total',
      Decimal
    >;
  const parties = new Map<string, { name: string; sums: Record<Bucket | 'total', Decimal> }>();
  const totals = zero();
  for (const item of await openItems(trx, companyId, q.asOf)) {
    const p = parties.get(item.party_id) ?? { name: item.party_name, sums: zero() };
    const b = new Decimal(item.open).isNegative() ? 'current' : bucketOf(item.days);
    p.sums[b] = p.sums[b].plus(item.open);
    p.sums.total = p.sums.total.plus(item.open);
    totals[b] = totals[b].plus(item.open);
    totals.total = totals.total.plus(item.open);
    parties.set(item.party_id, p);
  }
  const fmt = (s: Record<Bucket | 'total', Decimal>) =>
    Object.fromEntries(Object.entries(s).map(([k, v]) => [k, numeric(v)])) as Record<
      Bucket | 'total',
      string
    >;
  return {
    asOf: q.asOf,
    rows: [...parties].map(([partyId, p]) => ({ partyId, partyName: p.name, ...fmt(p.sums) })),
    totals: fmt(totals),
  };
}

export interface AccountWriteBack {
  readonly sfId: string;
  readonly balanceDue: string;
  readonly overdueAmount: string;
  readonly creditStatus: 'current' | 'overdue' | 'on_hold';
  readonly lastPaymentDate: string | null;
}

/**
 * The `accounts` row of the Salesforce write-back snapshot (design §5.4, contract v1) for a party,
 * computed from the same ageing as the aged-AR report (SS-UC12-05): balance due = all open items,
 * overdue = open items past their due date, last payment = latest receipt on or before `asOf`.
 */
export async function accountWriteBack(
  trx: Trx,
  q: { companyId: string; partyId: string; asOf: string },
): Promise<AccountWriteBack> {
  const companyId = q.companyId.toLowerCase();
  const party = await trx
    .selectFrom('app.party')
    .select('salesforce_account_id')
    .where('company_id', '=', companyId)
    .where('id', '=', q.partyId)
    .executeTakeFirst();
  if (!party?.salesforce_account_id)
    throw new RangeError(`party ${q.partyId} is not linked to a Salesforce Account`);
  let balance = new Decimal(0);
  let overdue = new Decimal(0);
  for (const item of await openItems(trx, companyId, q.asOf, q.partyId)) {
    balance = balance.plus(item.open);
    if (item.days > 0 && !new Decimal(item.open).isNegative()) overdue = overdue.plus(item.open);
  }
  const last = (
    await sql<{ d: string | null }>`
      SELECT to_char(max(receipt_date), 'YYYY-MM-DD') AS d FROM app.customer_receipt
       WHERE company_id = ${companyId} AND party_id = ${q.partyId}::uuid AND receipt_date <= ${q.asOf}::date`.execute(
      trx,
    )
  ).rows[0]?.d;
  return {
    sfId: party.salesforce_account_id,
    balanceDue: numeric(balance),
    overdueAmount: numeric(overdue),
    creditStatus: overdue.gt(0) ? 'overdue' : 'current',
    lastPaymentDate: last ?? null,
  };
}

export interface OpportunityWriteBack {
  readonly sfId: string;
  /** Net cash paid against the Opportunity's invoices (NUMERIC text). */
  readonly amountPaid: string;
}

/** Sources whose allocation to an invoice is cash received for it. */
const CASH_IN = [
  'ar_receipt',
  'payments_stripe_charge',
  'ar_prepayment',
  'ar_prepayment_application',
];

/**
 * The `opportunities` row of the Salesforce write-back snapshot (design §5.4, contract v1) with
 * Opportunity.LF_Amount_Paid__c (SS-UC11-05, GP-006): the net amount paid on the given invoices of
 * the Opportunity = cash allocated to them (receipts, Stripe charges, prepayments) − refunds paid
 * out of their credit notes. A credit note alone does not change it (no cash moved); its refund
 * does. Allocations net with their reversals (negative rows). Current state, not a delta.
 * Invoices are passed in: the invoice → Opportunity link arrives with T-0069 and the producer that
 * emits this snapshot on an event is T-0110 (DL-0305).
 */
export async function opportunityWriteBack(
  trx: Trx,
  q: { companyId: string; sfId: string; invoiceIds: readonly string[] },
): Promise<OpportunityWriteBack> {
  const companyId = q.companyId.toLowerCase();
  const ids = [...new Set(q.invoiceIds.map((i) => i.toLowerCase()))];
  const found = await trx
    .selectFrom('app.sales_invoice')
    .select('id')
    .where('company_id', '=', companyId)
    .where('id', 'in', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'])
    .execute();
  if (found.length !== ids.length)
    throw new RangeError(`not every invoice of Opportunity ${q.sfId} is in company ${companyId}`);
  const r = (
    await sql<{ paid: string; refunded: string }>`
      WITH inv AS (
        SELECT s.id FROM app.sales_invoice i
          JOIN app.subledger_entry s ON s.tenant_id = i.tenant_id AND s.entry_id = i.entry_id
                                    AND s.control_role = 'AR_CONTROL'
         WHERE i.company_id = ${companyId} AND i.id = ANY(${ids}::uuid[])),
      cn AS (
        SELECT s.id FROM app.credit_note c
          JOIN app.subledger_entry s ON s.tenant_id = c.tenant_id AND s.entry_id = c.entry_id
                                    AND s.control_role = 'AR_CONTROL'
         WHERE c.company_id = ${companyId} AND c.invoice_id = ANY(${ids}::uuid[])),
      pairs AS (
        SELECT a.amount,
               CASE WHEN a.to_entry_id IN (SELECT id FROM inv) OR a.to_entry_id IN (SELECT id FROM cn)
                    THEN a.to_entry_id ELSE a.from_entry_id END AS doc,
               CASE WHEN a.to_entry_id IN (SELECT id FROM inv) OR a.to_entry_id IN (SELECT id FROM cn)
                    THEN a.from_entry_id ELSE a.to_entry_id END AS other
          FROM app.allocation a
         WHERE a.company_id = ${companyId}
           AND (a.to_entry_id IN (SELECT id FROM inv) OR a.from_entry_id IN (SELECT id FROM inv)
             OR a.to_entry_id IN (SELECT id FROM cn) OR a.from_entry_id IN (SELECT id FROM cn)))
      SELECT
        coalesce(sum(p.amount) FILTER (WHERE p.doc IN (SELECT id FROM inv)
                                         AND o.source_type = ANY(${CASH_IN}::text[])), 0)::text AS paid,
        coalesce(sum(p.amount) FILTER (WHERE p.doc IN (SELECT id FROM cn)
                                         AND o.source_type = 'ar_refund'), 0)::text AS refunded
        FROM pairs p JOIN app.subledger_entry o ON o.id = p.other`.execute(trx)
  ).rows[0];
  return {
    sfId: q.sfId,
    amountPaid: numeric(new Decimal(r?.paid ?? '0').minus(r?.refunded ?? '0')),
  };
}

export interface StatementLine {
  readonly date: string;
  readonly kind:
    'invoice' | 'credit_note' | 'receipt' | 'prepayment' | 'write_off' | 'reversal' | 'adjustment';
  readonly reference: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly balance: string;
}

export interface CustomerStatement {
  readonly partyId: string;
  readonly partyName: string;
  readonly from: string;
  readonly to: string;
  readonly openingBalance: string;
  readonly lines: readonly StatementLine[];
  readonly closingBalance: string;
}

const KIND: Record<string, StatementLine['kind']> = {
  ar_invoice: 'invoice',
  ar_credit_note: 'credit_note',
  ar_receipt: 'receipt',
  payments_stripe_charge: 'receipt',
  ar_refund: 'receipt',
  ar_prepayment_application: 'prepayment',
  ar_write_off: 'write_off',
  ledger_reversal: 'reversal',
};

/** A customer's statement for a period: opening balance, AR movements, closing balance. */
export async function customerStatement(
  trx: Trx,
  q: { companyId: string; partyId: string; from: string; to: string },
): Promise<CustomerStatement> {
  if (!DATE_RE.test(q.from) || !DATE_RE.test(q.to) || q.from > q.to)
    throw new RangeError('invalid period');
  const companyId = q.companyId.toLowerCase();
  const party = await trx
    .selectFrom('app.party')
    .select('legal_name')
    .where('company_id', '=', companyId)
    .where('id', '=', q.partyId)
    .executeTakeFirstOrThrow();
  const ar = sql`(SELECT account_id FROM app.account_system_role WHERE company_id = ${companyId} AND role = 'AR_CONTROL')`;
  const opening =
    (
      await sql<{ b: string }>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM app.journal_line l
        JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       WHERE l.company_id = ${companyId} AND l.party_id = ${q.partyId}::uuid AND l.account_id IN ${ar}
         AND e.status <> 'draft' AND e.entry_date < ${q.from}::date`.execute(trx)
    ).rows[0]?.b ?? '0';
  const moves = (
    await sql<{
      date: string;
      source_type: string;
      entry_no: string | null;
      debit: string;
      credit: string;
    }>`
      SELECT to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.source_type, e.entry_no,
             sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
        FROM app.journal_line l
        JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       WHERE l.company_id = ${companyId} AND l.party_id = ${q.partyId}::uuid AND l.account_id IN ${ar}
         AND e.status <> 'draft' AND e.entry_date BETWEEN ${q.from}::date AND ${q.to}::date
       GROUP BY e.id, e.entry_date, e.source_type, e.entry_no
       ORDER BY e.entry_date, e.entry_no`.execute(trx)
  ).rows;
  let running = new Decimal(opening);
  const lines = moves.map((m) => {
    running = running.plus(m.debit).minus(m.credit);
    return {
      date: m.date,
      kind: KIND[m.source_type] ?? 'adjustment',
      reference: m.entry_no,
      debit: numeric(m.debit),
      credit: numeric(m.credit),
      balance: numeric(running),
    };
  });
  return {
    partyId: q.partyId,
    partyName: party.legal_name,
    from: q.from,
    to: q.to,
    openingBalance: numeric(opening),
    lines,
    closingBalance: numeric(running),
  };
}
