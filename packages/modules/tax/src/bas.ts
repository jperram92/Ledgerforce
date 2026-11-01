/**
 * BAS label query (T-0035, design §3.6, RQ-0097, DL-0264): G1, G2, G3, G4, G10, G11, the
 * worksheet labels G13/G14, 1A, 1B, W1 and W2 for a company and period, on the accruals or the
 * cash basis. Reads posted journal lines and their tax codes; writes nothing. (The BAS report
 * screen and lodgement presentation are Phase 1.)
 *
 * Per line with a tax code (RQ-0097 conclusion):
 * - A line on the GST collected / GST paid account is the **tax line**; any other coded line is a
 *   **base line**. Base lines on revenue accounts are sales (credit − debit), on any other
 *   account purchases (debit − credit); their G labels get net + GST, 1A/1B the GST.
 * - `adjustment` codes (GST-ADJ): on the accruals basis the tax line is the adjustment — a debit
 *   is a decreasing adjustment (1B), a credit an increasing one (1A). On the cash basis there is no
 *   adjustment (the GST was never reported); a recovery received in cash is a sale (G1/1A,
 *   GP-026).
 * - W labels: W1 counts debits (gross wages), W2 credits (tax withheld) of lines coded BAS-W1/W2.
 *
 * Accruals: lines of entries dated in the period. Cash: a document with AR/AP open items counts
 * in proportion to the cash settled in the period (allocations from receipts, refunds, card
 * charges and supplier payments) over its original amount; a document without open items counts
 * on its entry date. Results are cents (half-up) as NUMERIC(19,4) text. No floating point.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

export const BAS_LABELS = [
  'G1',
  'G2',
  'G3',
  'G4',
  'G10',
  'G11',
  'G13',
  'G14',
  '1A',
  '1B',
  'W1',
  'W2',
] as const;
export type BasLabel = (typeof BAS_LABELS)[number];
export type GstBasis = 'accrual' | 'cash';

export interface BasQuery {
  readonly companyId: string;
  readonly basis: GstBasis;
  /** Inclusive YYYY-MM-DD. */
  readonly from: string;
  readonly to: string;
}

/** Source types whose allocations are cash settlement for the cash basis (RQ-0097). */
export const CASH_SETTLEMENT_SOURCE_TYPES: readonly string[] = [
  'ar_receipt',
  'ar_refund',
  'payments_stripe_charge',
  'ap_payment',
];

interface Row {
  debit: string;
  credit: string;
  tax_amount: string | null;
  account_type: string;
  is_tax_account: boolean;
  kind: string;
  sales_labels: string[];
  purchase_labels: string[];
  /** Share of the line attributable to the period (1 on accruals). */
  fraction: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function basLabels(
  trx: Transaction<Database>,
  q: BasQuery,
): Promise<Record<BasLabel, string>> {
  if (q.basis !== 'accrual' && q.basis !== 'cash') {
    throw new RangeError(`unknown GST basis ${String(q.basis)}`);
  }
  if (!DATE_RE.test(q.from) || !DATE_RE.test(q.to) || q.from > q.to) {
    throw new RangeError(`invalid period ${q.from}..${q.to}`);
  }
  const company = q.companyId.toLowerCase();
  const rows = (
    q.basis === 'accrual'
      ? await sql<Row>`
          ${coded(company)}
          SELECT c.*, '1'::text AS fraction FROM coded c
           WHERE c.entry_date BETWEEN ${q.from}::date AND ${q.to}::date`.execute(trx)
      : await sql<Row>`
          ${coded(company)},
          cash_entries AS (
            SELECT id FROM app.journal_entry
             WHERE company_id = ${company}
               AND source_type = ANY(${sql.val([...CASH_SETTLEMENT_SOURCE_TYPES])}::text[])),
          items AS (
            SELECT s.id, s.entry_id, abs(s.base_original_amount) AS original
              FROM app.subledger_entry s WHERE s.company_id = ${company}),
          released AS (
            SELECT i.entry_id, sum(
                     CASE WHEN a.to_entry_id = i.id AND o.entry_id IN (SELECT id FROM cash_entries)
                            THEN abs(a.to_base_amount)
                          WHEN a.from_entry_id = i.id AND o.entry_id IN (SELECT id FROM cash_entries)
                            THEN abs(a.from_base_amount)
                          ELSE 0 END) AS amount
              FROM items i
              JOIN app.allocation a
                ON (a.to_entry_id = i.id OR a.from_entry_id = i.id)
               AND a.allocation_date BETWEEN ${q.from}::date AND ${q.to}::date
              JOIN app.subledger_entry o
                ON o.id = CASE WHEN a.to_entry_id = i.id THEN a.from_entry_id ELSE a.to_entry_id END
             GROUP BY i.entry_id),
          originals AS (
            SELECT entry_id, sum(original) AS amount FROM items GROUP BY entry_id)
          SELECT c.*,
                 (CASE WHEN o.entry_id IS NULL
                         THEN CASE WHEN c.entry_date BETWEEN ${q.from}::date AND ${q.to}::date
                                   THEN 1 ELSE 0 END
                       ELSE coalesce(r.amount, 0) / nullif(o.amount, 0) END)::text AS fraction
            FROM coded c
            LEFT JOIN originals o ON o.entry_id = c.entry_id
            LEFT JOIN released r ON r.entry_id = c.entry_id
           WHERE o.entry_id IS NOT NULL AND r.amount > 0
              OR o.entry_id IS NULL AND c.entry_date BETWEEN ${q.from}::date AND ${q.to}::date`.execute(
          trx,
        )
  ).rows;

  const totals = new Map<BasLabel, Decimal>(BAS_LABELS.map((l) => [l, new Decimal(0)]));
  const add = (label: string, v: Decimal) => {
    const cur = totals.get(label as BasLabel);
    if (cur !== undefined) totals.set(label as BasLabel, cur.plus(v));
  };
  for (const r of rows) {
    const fraction = new Decimal(r.fraction);
    if (fraction.isZero()) continue;
    const debit = new Decimal(r.debit);
    const credit = new Decimal(r.credit);
    const share = (v: Decimal) => v.times(fraction);

    for (const label of [...r.sales_labels, ...r.purchase_labels]) {
      if (label === 'W1') add(label, share(debit.minus(credit)));
      if (label === 'W2') add(label, share(credit.minus(debit)));
    }

    if (r.kind === 'adjustment') {
      if (q.basis === 'accrual' && r.is_tax_account) {
        if (debit.gt(0)) for (const l of r.purchase_labels) add(l, debit);
        if (credit.gt(0)) for (const l of r.sales_labels) add(l, credit);
      }
      if (q.basis === 'cash' && !r.is_tax_account) {
        // A recovery received in cash (GP-026): the GST is attributable on receipt, as a sale.
        const net = credit.minus(debit);
        const tax = signed(r.tax_amount, net);
        add('G1', share(net.plus(tax)));
        add('1A', share(tax));
      }
      continue;
    }
    if (r.is_tax_account) continue;

    const sale = r.account_type === 'revenue';
    const net = sale ? credit.minus(debit) : debit.minus(credit);
    const tax = signed(r.tax_amount, net);
    for (const label of sale ? r.sales_labels : r.purchase_labels) {
      if (label.startsWith('W')) continue;
      add(label, share(label === '1A' || label === '1B' ? tax : net.plus(tax)));
    }
  }

  return Object.fromEntries(
    BAS_LABELS.map((l) => [
      l,
      Money.of(
        (totals.get(l) ?? new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
        'AUD',
      ).toNumericString(),
    ]),
  ) as Record<BasLabel, string>;
}

/** The line's tax amount (stored unsigned) with the sign of its net amount. */
function signed(taxAmount: string | null, net: Decimal): Decimal {
  const tax = new Decimal(taxAmount ?? '0');
  return net.isNegative() ? tax.negated() : tax;
}

/** CTE `coded`: posted (non-draft) lines with a tax code, with their entry, account and code. */
function coded(company: string) {
  return sql`
    WITH tax_accounts AS (
      SELECT account_id FROM app.account_system_role
       WHERE company_id = ${company} AND role IN ('GST_COLLECTED', 'GST_PAID')),
    coded AS (
      SELECT l.entry_id, e.entry_date, l.debit::text AS debit, l.credit::text AS credit,
             l.tax_amount::text AS tax_amount, a.type AS account_type,
             (l.account_id IN (SELECT account_id FROM tax_accounts)) AS is_tax_account,
             t.kind, t.sales_labels, t.purchase_labels
        FROM app.journal_line l
        JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        JOIN app.account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        JOIN app.tax_code t ON t.tenant_id = l.tenant_id AND t.id = l.tax_code_id
       WHERE l.company_id = ${company} AND e.status <> 'draft')`;
}
