/**
 * Aged payables (T-0077, design §8.1 ageing, DL-0290) — the AP mirror of T-0049's aged receivables
 * (packages/modules/ar/src/aged.ts). Reads only.
 *
 * Every AP_CONTROL open item dated on or before the as-at date, at its open amount as at that date
 * (original less allocations dated on or before it, the same rule as subledgerReconciliation),
 * shown on the AP credit side (a bill is positive), bucketed by days past its due date: current
 * (not yet due), 1–30, 31–60, 61–90, 90+. Supplier debits (unapplied payments, debit notes) are
 * never overdue: they sit in `current`, reducing the balance owed. The buckets sum to the AP
 * control account's credit balance at the date. Money is decimal strings; no floating point.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

const BUCKETS = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const;
type Bucket = (typeof BUCKETS)[number];

export type AgedPayablesRow = {
  readonly partyId: string;
  readonly partyName: string;
  readonly total: string;
} & Readonly<Record<Bucket, string>>;

export interface AgedPayables {
  readonly asOf: string;
  readonly rows: readonly AgedPayablesRow[];
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

/** AP open items as at `asOf`; `owed` is credit-positive (the negated GL open amount). */
async function openItems(trx: Trx, companyId: string, asOf: string) {
  return (
    await sql<{ party_id: string; party_name: string; days: number; owed: string }>`
      WITH items AS (
        SELECT s.* FROM app.subledger_entry s
         WHERE s.company_id = ${companyId} AND s.control_role = 'AP_CONTROL'
           AND s.document_date <= ${asOf}::date),
      released AS (
        SELECT i.id, sum(sign(i.base_original_amount) *
                 CASE WHEN a.from_entry_id = i.id THEN a.from_base_amount ELSE a.to_base_amount END) AS r
          FROM items i
          JOIN app.allocation a ON (a.from_entry_id = i.id OR a.to_entry_id = i.id)
                               AND a.allocation_date <= ${asOf}::date
         GROUP BY i.id)
      SELECT i.party_id::text, p.legal_name AS party_name, (${asOf}::date - i.due_date) AS days,
             (-(i.base_original_amount - coalesce(r.r, 0)))::text AS owed
        FROM items i
        JOIN app.party p ON p.tenant_id = i.tenant_id AND p.id = i.party_id
        LEFT JOIN released r ON r.id = i.id
       WHERE i.base_original_amount - coalesce(r.r, 0) <> 0
       ORDER BY p.legal_name, i.party_id, i.due_date`.execute(trx)
  ).rows;
}

/** Aged payables as at `asOf`, one row per supplier with an open balance. */
export async function agedPayables(
  trx: Trx,
  q: { companyId: string; asOf: string },
): Promise<AgedPayables> {
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
    const b = new Decimal(item.owed).isNegative() ? 'current' : bucketOf(item.days);
    p.sums[b] = p.sums[b].plus(item.owed);
    p.sums.total = p.sums.total.plus(item.owed);
    totals[b] = totals[b].plus(item.owed);
    totals.total = totals.total.plus(item.owed);
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
