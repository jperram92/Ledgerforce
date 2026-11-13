/**
 * Batch billing run — selection and preview (T-0043, UC-02, design §4.3 "Batch billing run",
 * DL-0271).
 *
 * Selection: pending billing lines with a bill date in the period, for parties with an active
 * customer role, grouped one invoice per account (the BATCH format's grouping), lines in bill-date
 * order. Preview: each group is priced exactly as approval prices an invoice
 * (priceInvoiceLines — posting-profile matrix, tax codes in force, company GST rounding), and
 * every reason approval would refuse is a warning instead (PROFILE_GAP, NO_BILLING_TO,
 * CREDIT_HOLD). The batch and its items are stored so approval (T-0044) posts what was
 * previewed; nothing is written to the ledger and no invoice or number is created. A repeated
 * request with the same idempotency key returns the stored preview.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  approveInvoice,
  createDraftInvoice,
  creditHold,
  InvoiceError,
  priceInvoiceLines,
  type DocumentOutbox,
  type InvoiceDeps,
  type LineRow,
} from './invoices.ts';

type Trx = Transaction<Database>;

export type BatchErrorCode = 'INVALID_BATCH' | 'NOTHING_TO_BILL' | 'BATCH_STATE';

export class BatchError extends Error {
  readonly code: BatchErrorCode;
  constructor(code: BatchErrorCode, message: string) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
  }
}

export interface BatchWarning {
  readonly code: 'PROFILE_GAP' | 'NO_BILLING_TO' | 'CREDIT_HOLD';
  /** Billing-line position in the item (1-based) for line warnings; 0 for the whole invoice. */
  readonly line: number;
  readonly message: string;
}

export interface BatchItem {
  readonly itemNo: number;
  readonly partyId: string;
  readonly partyName: string;
  readonly lineCount: number;
  /** NUMERIC(19,4) text; null when a line cannot be priced. */
  readonly net: string | null;
  readonly tax: string | null;
  readonly gross: string | null;
  readonly warnings: readonly BatchWarning[];
}

export type BatchStatus = 'preview' | 'approved' | 'posted' | 'cancelled';

export interface BatchPreview {
  readonly batchId: string;
  readonly replayed: boolean;
  /** preview → approved → posted (T-0044); read by the batch screen (T-0084). */
  readonly status: BatchStatus;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly issueDate: string;
  readonly items: readonly BatchItem[];
  readonly totals: {
    readonly invoices: number;
    /** Items without warnings: they will post on approval. */
    readonly ready: number;
    readonly net: string;
    readonly tax: string;
    readonly gross: string;
  };
}

export interface BillingLineInput {
  readonly partyId: string;
  readonly productId?: string;
  readonly productProfileId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxCode?: string;
  readonly billDate: string;
  readonly sourceRef?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^\d{1,15}(\.\d{1,4})?$/;
const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

/** Record a billable line (the MVP line source of the BATCH format). */
export async function addBillingLine(
  trx: Trx,
  companyId: string,
  l: BillingLineInput,
): Promise<string> {
  if (!DATE_RE.test(l.billDate)) throw new BatchError('INVALID_BATCH', 'bill date is YYYY-MM-DD');
  if (
    !DECIMAL_RE.test(l.quantity) ||
    new Decimal(l.quantity).isZero() ||
    !DECIMAL_RE.test(l.unitPrice)
  ) {
    throw new BatchError('INVALID_BATCH', 'quantity > 0 and unit price ≥ 0, ≤ 4 decimals');
  }
  const r = await trx
    .insertInto('app.billing_line')
    .values({
      company_id: companyId,
      party_id: l.partyId,
      product_id: l.productId ?? null,
      product_profile_id: l.productProfileId,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      tax_code: l.taxCode ?? null,
      bill_date: l.billDate,
      source_ref: l.sourceRef ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

interface SelectedLine {
  id: string;
  party_id: string;
  party_name: string;
  product_profile_id: string;
  quantity: string;
  unit_price: string;
  tax_code: string | null;
}

export async function previewBatch(
  trx: Trx,
  q: {
    companyId: string;
    periodFrom: string;
    periodTo: string;
    /** Invoice date of the batch; default the period end. */
    issueDate?: string;
    idempotencyKey: string;
    createdBy?: string;
  },
): Promise<BatchPreview> {
  const companyId = q.companyId.toLowerCase();
  if (!DATE_RE.test(q.periodFrom) || !DATE_RE.test(q.periodTo) || q.periodFrom > q.periodTo) {
    throw new BatchError('INVALID_BATCH', `invalid period ${q.periodFrom}..${q.periodTo}`);
  }
  if (q.idempotencyKey.length < 1 || q.idempotencyKey.length > 200) {
    throw new BatchError('INVALID_BATCH', 'idempotency key must be 1..200 characters');
  }
  const issueDate = q.issueDate ?? q.periodTo;
  if (!DATE_RE.test(issueDate)) throw new BatchError('INVALID_BATCH', 'issue date is YYYY-MM-DD');

  const existing = await trx
    .selectFrom('app.billing_batch')
    .select('id')
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', q.idempotencyKey)
    .executeTakeFirst();
  if (existing) return loadBatchPreview(trx, companyId, existing.id, true);

  const selected = (
    await sql<SelectedLine>`
      SELECT l.id::text, l.party_id::text, p.legal_name AS party_name, l.product_profile_id::text,
             l.quantity::text, l.unit_price::text, l.tax_code
        FROM app.billing_line l
        JOIN app.party p ON p.tenant_id = l.tenant_id AND p.id = l.party_id
        JOIN app.party_role r ON r.tenant_id = l.tenant_id AND r.party_id = l.party_id AND r.role = 'customer'
       WHERE l.company_id = ${companyId} AND l.status = 'pending'
         AND l.bill_date BETWEEN ${q.periodFrom}::date AND ${q.periodTo}::date
         AND p.status = 'active' AND r.active
       ORDER BY p.legal_name, l.party_id, l.bill_date, l.id`.execute(trx)
  ).rows;
  if (selected.length === 0) {
    throw new BatchError(
      'NOTHING_TO_BILL',
      `no billable lines between ${q.periodFrom} and ${q.periodTo}`,
    );
  }
  const groups = new Map<string, SelectedLine[]>();
  for (const l of selected) groups.set(l.party_id, [...(groups.get(l.party_id) ?? []), l]);

  const items: BatchItem[] = [];
  const lineIds: string[][] = [];
  for (const [partyId, lines] of groups) {
    const rows: LineRow[] = lines.map((l, i) => ({
      line_no: i + 1,
      product_profile_id: l.product_profile_id,
      amount: numeric(
        new Decimal(l.quantity).times(l.unit_price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      ),
      tax_code: l.tax_code,
    }));
    const { priced, warnings: gaps } = await priceInvoiceLines(
      trx,
      companyId,
      { party_id: partyId, issue_date: issueDate, pricing: 'exclusive' },
      rows,
    );
    const warnings: BatchWarning[] = gaps.map((g) => ({
      code: 'PROFILE_GAP',
      line: g.line,
      message: g.message,
    }));
    const billing = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM app.party_contact_role r
        JOIN app.party_contact c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
       WHERE r.company_id = ${companyId} AND r.party_id = ${partyId}::uuid AND r.role = 'billing_to'
         AND r.active AND c.status = 'active' AND c.email IS NOT NULL`.execute(trx);
    if ((billing.rows[0]?.n ?? 0) === 0) {
      warnings.push({
        code: 'NO_BILLING_TO',
        line: 0,
        message: 'the customer has no active Billing To contact with an email address',
      });
    }
    if (priced) {
      try {
        await creditHold(trx, companyId, partyId, priced.gross);
      } catch (e) {
        if (!(e instanceof InvoiceError)) throw e;
        warnings.push({ code: 'CREDIT_HOLD', line: 0, message: e.message });
      }
    }
    items.push({
      itemNo: items.length + 1,
      partyId,
      partyName: lines[0]?.party_name ?? '',
      lineCount: lines.length,
      net: priced?.net ?? null,
      tax: priced?.tax ?? null,
      gross: priced?.gross ?? null,
      warnings,
    });
    lineIds.push(lines.map((l) => l.id));
  }

  const sum = (k: 'net' | 'tax' | 'gross') =>
    numeric(items.reduce((s, i) => (i[k] === null ? s : s.plus(i[k])), new Decimal(0)));
  const totals = {
    invoices: items.length,
    ready: items.filter((i) => i.warnings.length === 0).length,
    net: sum('net'),
    tax: sum('tax'),
    gross: sum('gross'),
  };
  const batch = await trx
    .insertInto('app.billing_batch')
    .values({
      company_id: companyId,
      period_from: q.periodFrom,
      period_to: q.periodTo,
      issue_date: issueDate,
      idempotency_key: q.idempotencyKey,
      invoice_count: totals.invoices,
      ready_count: totals.ready,
      net_total: totals.net,
      tax_total: totals.tax,
      gross_total: totals.gross,
      created_by: q.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('app.billing_batch_item')
    .values(
      items.map((i, k) => ({
        company_id: companyId,
        batch_id: batch.id,
        item_no: i.itemNo,
        party_id: i.partyId,
        line_ids: lineIds[k] ?? [],
        net: i.net,
        tax: i.tax,
        gross: i.gross,
        warnings: JSON.stringify(i.warnings),
      })),
    )
    .execute();
  return {
    batchId: batch.id,
    replayed: false,
    status: 'preview',
    periodFrom: q.periodFrom,
    periodTo: q.periodTo,
    issueDate,
    items,
    totals,
  };
}

/** A stored batch preview (also the replay of previewBatch). */
export async function loadBatchPreview(
  trx: Trx,
  companyId: string,
  batchId: string,
  replayed = false,
): Promise<BatchPreview> {
  const b = (
    await sql<{
      id: string;
      status: BatchStatus;
      period_from: string;
      period_to: string;
      issue_date: string;
      invoice_count: number;
      ready_count: number;
      net_total: string;
      tax_total: string;
      gross_total: string;
    }>`
      SELECT id::text, status, to_char(period_from, 'YYYY-MM-DD') AS period_from,
             to_char(period_to, 'YYYY-MM-DD') AS period_to, to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
             invoice_count, ready_count, net_total::text, tax_total::text, gross_total::text
        FROM app.billing_batch WHERE company_id = ${companyId} AND id = ${batchId}::uuid`.execute(
      trx,
    )
  ).rows[0];
  if (!b) throw new BatchError('INVALID_BATCH', `batch ${batchId} is not in company ${companyId}`);
  const items = (
    await sql<{
      item_no: number;
      party_id: string;
      party_name: string;
      line_count: number;
      net: string | null;
      tax: string | null;
      gross: string | null;
      warnings: BatchWarning[];
    }>`
      SELECT i.item_no, i.party_id::text, p.legal_name AS party_name, cardinality(i.line_ids) AS line_count,
             i.net::text, i.tax::text, i.gross::text, i.warnings
        FROM app.billing_batch_item i
        JOIN app.party p ON p.tenant_id = i.tenant_id AND p.id = i.party_id
       WHERE i.batch_id = ${batchId}::uuid ORDER BY i.item_no`.execute(trx)
  ).rows;
  return {
    batchId: b.id,
    replayed,
    status: b.status,
    periodFrom: b.period_from,
    periodTo: b.period_to,
    issueDate: b.issue_date,
    items: items.map((i) => ({
      itemNo: i.item_no,
      partyId: i.party_id,
      partyName: i.party_name,
      lineCount: i.line_count,
      net: i.net,
      tax: i.tax,
      gross: i.gross,
      warnings: i.warnings,
    })),
    totals: {
      invoices: b.invoice_count,
      ready: b.ready_count,
      net: b.net_total,
      tax: b.tax_total,
      gross: b.gross_total,
    },
  };
}

/** Outbox topic written when a batch is approved; the worker then runs the batch (T-0120). */
export const BATCH_APPROVED = 'ar.batch.approved';

/**
 * Approve a previewed batch (UC-02 step 3). With `deps.outbox`, the same transaction publishes
 * `ar.batch.approved`, and the worker then runs the job (runBatch) that posts it (T-0120).
 */
export async function approveBatch(
  trx: Trx,
  c: { companyId: string; batchId: string; approvedBy: string },
  deps: { outbox?: DocumentOutbox } = {},
): Promise<void> {
  const r = await trx
    .updateTable('app.billing_batch')
    .set({
      status: 'approved',
      approved_by: c.approvedBy,
      approved_at: sql<Date>`clock_timestamp()`,
    })
    .where('company_id', '=', c.companyId.toLowerCase())
    .where('id', '=', c.batchId)
    .where('status', '=', 'preview')
    .executeTakeFirst();
  if (r.numUpdatedRows !== 1n) {
    throw new BatchError('BATCH_STATE', `batch ${c.batchId} is not a preview awaiting approval`);
  }
  await deps.outbox?.publish(trx, {
    companyId: c.companyId.toLowerCase(),
    topic: BATCH_APPROVED,
    aggregateType: 'billing_batch',
    aggregateId: c.batchId,
    payload: { batchId: c.batchId, approvedBy: c.approvedBy },
  });
}

export interface BatchRunResult {
  readonly posted: number;
  readonly failed: number;
  /** Items still to post (a run stopped by `limit` or a crash). */
  readonly remaining: number;
  readonly status: 'approved' | 'posted';
}

const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ERROR';
};

/**
 * The batch job (UC-02 steps 4–5): posts each previewed item in its own tenant transaction —
 * draft invoice from the item's billing lines, approval through the posting engine, lines marked
 * invoiced. A failure rolls back only that item (no invoice, no number consumed) and is recorded
 * in the exception list. Items are keyed `batch:<id>:<item>` (sales_invoice.source_key) and
 * skipped once posted, so a re-run after a crash continues without duplicates. `limit` bounds a
 * run (tests use it to stop a job half way).
 */
export async function runBatch(
  db: Kysely<Database>,
  tenantId: string,
  c: { companyId: string; batchId: string; limit?: number },
  deps: InvoiceDeps,
): Promise<BatchRunResult> {
  const companyId = c.companyId.toLowerCase();
  const batch = await withTenant(db, tenantId, (trx) =>
    sql<{ status: string; issue_date: string }>`
      SELECT status, to_char(issue_date, 'YYYY-MM-DD') AS issue_date FROM app.billing_batch
       WHERE company_id = ${companyId} AND id = ${c.batchId}::uuid`.execute(trx),
  ).then((r) => r.rows[0]);
  if (!batch)
    throw new BatchError('INVALID_BATCH', `batch ${c.batchId} is not in company ${companyId}`);
  if (batch.status !== 'approved' && batch.status !== 'posted') {
    throw new BatchError('BATCH_STATE', `batch ${c.batchId} is ${batch.status}; approve it first`);
  }
  const todo = await withTenant(db, tenantId, (trx) =>
    trx
      .selectFrom('app.billing_batch_item')
      .select(['item_no', 'party_id', 'line_ids'])
      .where('batch_id', '=', c.batchId)
      .where('status', '=', 'preview')
      .orderBy('item_no')
      .execute(),
  );
  let posted = 0;
  let failed = 0;
  for (const item of todo.slice(0, c.limit ?? todo.length)) {
    try {
      await withTenant(db, tenantId, async (trx) => {
        const lock = await sql<{ status: string }>`
          SELECT status FROM app.billing_batch_item
           WHERE batch_id = ${c.batchId}::uuid AND item_no = ${item.item_no} FOR UPDATE`.execute(
          trx,
        );
        if (lock.rows[0]?.status !== 'preview') return;
        const lines = await trx
          .selectFrom('app.billing_line')
          .select([
            'id',
            'product_id',
            'product_profile_id',
            'description',
            'quantity',
            'unit_price',
            'tax_code',
          ])
          .where(
            'id',
            'in',
            item.line_ids.length > 0 ? item.line_ids : ['00000000-0000-0000-0000-000000000000'],
          )
          .where('status', '=', 'pending')
          .orderBy('bill_date')
          .orderBy('id')
          .execute();
        if (lines.length !== item.line_ids.length) {
          throw new BatchError('BATCH_STATE', 'a billing line of this item is no longer pending');
        }
        const draft = await createDraftInvoice(
          trx,
          {
            companyId,
            partyId: item.party_id,
            issueDate: batch.issue_date,
            sourceKey: `batch:${c.batchId}:${String(item.item_no)}`,
            lines: lines.map((l) => ({
              ...(l.product_id ? { productId: l.product_id } : {}),
              productProfileId: l.product_profile_id,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unit_price,
              ...(l.tax_code ? { taxCode: l.tax_code } : {}),
            })),
          },
          deps,
        );
        const invoice =
          draft.status === 'posted'
            ? draft
            : await approveInvoice(trx, { companyId, invoiceId: draft.invoiceId }, deps);
        await trx
          .updateTable('app.billing_line')
          .set({ status: 'invoiced', invoice_id: invoice.invoiceId })
          .where('id', 'in', item.line_ids)
          .execute();
        await trx
          .updateTable('app.billing_batch_item')
          .set({
            status: 'posted',
            invoice_id: invoice.invoiceId,
            attempts: sql<number>`attempts + 1`,
          })
          .where('batch_id', '=', c.batchId)
          .where('item_no', '=', item.item_no)
          .execute();
      });
      posted += 1;
    } catch (e) {
      await withTenant(db, tenantId, (trx) =>
        trx
          .updateTable('app.billing_batch_item')
          .set({
            status: 'failed',
            failure_code: errorCode(e),
            failure_message: ((e as Error).message ?? String(e)).slice(0, 2000),
            attempts: sql<number>`attempts + 1`,
          })
          .where('batch_id', '=', c.batchId)
          .where('item_no', '=', item.item_no)
          .execute(),
      );
      failed += 1;
    }
  }
  return withTenant(db, tenantId, async (trx) => {
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM app.billing_batch_item
       WHERE batch_id = ${c.batchId}::uuid AND status = 'preview'`.execute(trx);
    const remaining = left.rows[0]?.n ?? 0;
    if (remaining === 0) {
      await trx
        .updateTable('app.billing_batch')
        .set({ status: 'posted' })
        .where('id', '=', c.batchId)
        .where('status', '=', 'approved')
        .execute();
    }
    return { posted, failed, remaining, status: remaining === 0 ? 'posted' : 'approved' };
  });
}

export interface BatchSummaryRow {
  readonly itemNo: number;
  readonly partyId: string;
  readonly partyName: string;
  readonly status: 'preview' | 'posted' | 'failed';
  readonly invoiceNo: string | null;
  readonly entryNo: string | null;
  readonly gross: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

/** Batch summary journal report (UC-02 step 6): one row per item, posted totals. */
export async function batchSummary(
  trx: Trx,
  companyId: string,
  batchId: string,
): Promise<{ rows: BatchSummaryRow[]; totals: { posted: number; failed: number; gross: string } }> {
  const rows = (
    await sql<{
      item_no: number;
      party_id: string;
      party_name: string;
      status: 'preview' | 'posted' | 'failed';
      invoice_no: string | null;
      entry_no: string | null;
      gross: string | null;
      failure_code: string | null;
      failure_message: string | null;
    }>`
      SELECT i.item_no, i.party_id::text, p.legal_name AS party_name, i.status, s.invoice_no,
             e.entry_no, s.gross_total::text AS gross, i.failure_code, i.failure_message
        FROM app.billing_batch_item i
        JOIN app.party p ON p.tenant_id = i.tenant_id AND p.id = i.party_id
        LEFT JOIN app.sales_invoice s ON s.tenant_id = i.tenant_id AND s.id = i.invoice_id
        LEFT JOIN app.journal_entry e ON e.tenant_id = s.tenant_id AND e.id = s.entry_id
       WHERE i.company_id = ${companyId.toLowerCase()} AND i.batch_id = ${batchId}::uuid
       ORDER BY i.item_no`.execute(trx)
  ).rows;
  const out = rows.map((r) => ({
    itemNo: r.item_no,
    partyId: r.party_id,
    partyName: r.party_name,
    status: r.status,
    invoiceNo: r.invoice_no,
    entryNo: r.entry_no,
    gross: r.gross,
    failureCode: r.failure_code,
    failureMessage: r.failure_message,
  }));
  return {
    rows: out,
    totals: {
      posted: out.filter((r) => r.status === 'posted').length,
      failed: out.filter((r) => r.status === 'failed').length,
      gross: numeric(
        out.reduce(
          (s, r) => (r.status === 'posted' && r.gross ? s.plus(r.gross) : s),
          new Decimal(0),
        ),
      ),
    },
  };
}
