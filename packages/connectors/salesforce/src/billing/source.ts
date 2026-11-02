/**
 * Closed Won / Order activated → draft invoice (T-0069, UC-01 main flow 1–6, A2–A4, A6; design
 * §4.3, §5.5, §5.6; RQ-0106; migration 0052; DL-0289).
 *
 * The inbound mapping (apply.ts) mirrors Opportunity / Order and their line items into
 * app.salesforce_billing_source(_line) — inside the processed-change row's savepoint, so the
 * idempotency key (record Id + commit number + sequence number) and CDC/poll convergence are the
 * same as for parties. After each applied change of a source or one of its lines,
 * `evaluateBillingSource` checks the mirror (billing-source.ts) and, when the configured trigger
 * object is won / activated and its lines are complete and it has no invoice yet:
 *   1. resolves the issue date with the tenant lock-date policy (`resolvePostingDate`,
 *      `ar_invoice`): reject → PERIOD_LOCKED issue (Sync issues); first open date → moved, noted;
 *   2. resolves the Account → customer party and each Product2 → product;
 *   3. issues under the tenant's billing format for the line source (STANDARD first);
 *   4. calls @ledgerforce/ar `createDraftInvoice` with source key `salesforce:<Object>:<Id>` —
 *      AR resolves profiles (PROFILE_GAP warning), applies auto-approval (`ar_settings`) and posts
 *      only through the posting engine;
 *   5. links the invoice to the source (set once) and announces it for the write-back
 *      (`invoice.drafted` / `invoice.posted`, payload contract v1 → LF_Invoice_Status__c).
 * A source that cannot be invoiced is an issue for the Sync issues inbox, never a crash; the
 * issue rolls the change back so a retry re-applies it once the cause is fixed.
 */
import {
  createDraftInvoice,
  InvoiceError,
  type DocumentOutbox,
  type InvoiceView,
} from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import { PeriodLockedError, resolvePostingDate, type PostOptions } from '@ledgerforce/ledger';
import { sql, type Transaction } from 'kysely';
import {
  billingReadiness,
  DEFAULT_BILLING_SETTINGS,
  invoiceLineFor,
  LINE_ENTITY,
  LINE_SOURCE,
  type BillingEntity,
  type BillingReadiness,
  type BillingSettings,
  type SourceHeader,
  type SourceLine,
} from './billing-source.ts';

type Trx = Transaction<Database>;

/** Production wires @ledgerforce/outbox `enqueue` (same transaction) and the engine's outbox. */
export interface BillingDeps {
  readonly outbox: DocumentOutbox;
  readonly posting?: PostOptions;
}

export const INVOICE_DRAFTED_TOPIC = 'invoice.drafted';
export const INVOICE_POSTED_TOPIC = 'invoice.posted';

export const sourceKeyOf = (entity: BillingEntity, recordId: string) =>
  `salesforce:${entity}:${recordId}`;

export type BillingOutcome =
  | { kind: 'drafted' | 'posted'; invoiceId: string; invoice: InvoiceView }
  | { kind: 'exists'; invoiceId: string }
  | { kind: 'waiting'; readiness: BillingReadiness | { ready: false; reason: 'NO_SOURCE' } }
  | { kind: 'issue'; code: string; message: string };

export async function getSalesforceBillingSettings(
  trx: Trx,
  companyId: string,
): Promise<BillingSettings & { billingFormatId: string | null }> {
  const { rows } = await sql<{
    invoice_trigger: BillingSettings['invoiceTrigger'];
    won_stages: string[];
    billing_format_id: string | null;
  }>`
    SELECT invoice_trigger, won_stages, billing_format_id::text
      FROM app.salesforce_billing_settings WHERE company_id = ${companyId}`.execute(trx);
  const r = rows[0];
  if (!r) return { ...DEFAULT_BILLING_SETTINGS, billingFormatId: null };
  return {
    invoiceTrigger: r.invoice_trigger,
    wonStages: r.won_stages,
    billingFormatId: r.billing_format_id,
  };
}

/** Per-company invoice trigger (§11.2 open: opportunity | order), won stages, billing format. */
export async function setSalesforceBillingSettings(
  trx: Trx,
  companyId: string,
  s: Partial<BillingSettings> & { billingFormatId?: string | null },
): Promise<void> {
  const cur = await getSalesforceBillingSettings(trx, companyId);
  const next = {
    trigger: s.invoiceTrigger ?? cur.invoiceTrigger,
    stages: [...(s.wonStages ?? cur.wonStages)],
    format: s.billingFormatId !== undefined ? s.billingFormatId : cur.billingFormatId,
  };
  if (next.stages.length === 0) throw new RangeError('at least one won stage is required');
  await sql`
    INSERT INTO app.salesforce_billing_settings (company_id, invoice_trigger, won_stages, billing_format_id)
    VALUES (${companyId}, ${next.trigger}, ${next.stages}::text[], ${next.format}::uuid)
    ON CONFLICT (tenant_id, company_id) DO UPDATE
       SET invoice_trigger = EXCLUDED.invoice_trigger, won_stages = EXCLUDED.won_stages,
           billing_format_id = EXCLUDED.billing_format_id, updated_at = clock_timestamp()`.execute(
    trx,
  );
}

/** A Salesforce date value: 'YYYY-MM-DD…' or epoch days (Avro `date`, RQ-0106 S7). */
export function sfDate(v: string | null): string | null {
  if (v === null) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (/^-?\d+$/.test(v)) return new Date(Number(v) * 86_400_000).toISOString().slice(0, 10);
  throw new RangeError(`not a date: ${v}`);
}

/** A Salesforce number value (decimal string from the boundary conversion), or null. */
export function sfNumber(v: string | null): string | null {
  if (v === null) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new RangeError(`not a decimal number: ${v}`);
  return v;
}

const header = (
  r: Record<string, unknown>,
): SourceHeader & { id: string; invoiceId: string | null; name: string | null } => ({
  id: r['id'] as string,
  entityName: r['entity_name'] as BillingEntity,
  recordId: r['record_id'] as string,
  accountRecordId: r['account_record_id'] as string | null,
  stageName: r['stage_name'] as string | null,
  isWon: r['is_won'] as boolean | null,
  status: r['status'] as string | null,
  statusCode: r['status_code'] as string | null,
  sourceDate: r['source_date'] as string | null,
  amount: r['amount'] as string | null,
  archived: r['archived'] as boolean,
  invoiceId: r['invoice_id'] as string | null,
  name: r['name'] as string | null,
});

const issue = (code: string, message: string): BillingOutcome => ({ kind: 'issue', code, message });

/** Draft the source's invoice when it is ready (see the module comment); idempotent per source. */
export async function evaluateBillingSource(
  trx: Trx,
  companyId: string,
  entity: BillingEntity,
  recordId: string,
  deps: BillingDeps,
): Promise<BillingOutcome> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT id::text, entity_name, record_id, account_record_id, name, stage_name, is_won, status,
           status_code, to_char(source_date, 'YYYY-MM-DD') AS source_date, amount::text, archived,
           invoice_id::text
      FROM app.salesforce_billing_source
     WHERE company_id = ${companyId} AND entity_name = ${entity} AND record_id = ${recordId}
       FOR UPDATE`.execute(trx);
  if (!rows[0]) return { kind: 'waiting', readiness: { ready: false, reason: 'NO_SOURCE' } };
  const h = header(rows[0]);
  if (h.invoiceId) return { kind: 'exists', invoiceId: h.invoiceId };

  const settings = await getSalesforceBillingSettings(trx, companyId);
  const lineRows = await sql<Record<string, unknown>>`
    SELECT l.record_id, l.product2_record_id, l.quantity::text, l.unit_price::text,
           l.total_price::text, l.description, l.archived, p.id::text AS product_id,
           p.name AS product_name
      FROM app.salesforce_billing_source_line l
      LEFT JOIN app.product p ON p.tenant_id = l.tenant_id AND p.company_id = l.company_id
                             AND p.salesforce_product2_id = l.product2_record_id
     WHERE l.company_id = ${companyId} AND l.entity_name = ${LINE_ENTITY[entity]}
       AND l.parent_record_id = ${recordId}
     ORDER BY l.created_at, l.record_id`.execute(trx);
  const lines = lineRows.rows.map((r) => ({
    line: {
      recordId: r['record_id'] as string,
      product2RecordId: r['product2_record_id'] as string | null,
      quantity: r['quantity'] as string | null,
      unitPrice: r['unit_price'] as string | null,
      totalPrice: r['total_price'] as string | null,
      description: r['description'] as string | null,
      productName: r['product_name'] as string | null,
      archived: r['archived'] as boolean,
    } satisfies SourceLine,
    productId: r['product_id'] as string | null,
  }));
  const readiness = billingReadiness(
    h,
    lines.map((l) => l.line),
    settings,
  );
  if (!readiness.ready) {
    if (readiness.reason === 'INCOMPLETE_SOURCE') {
      return issue(
        'INCOMPLETE_SOURCE',
        `${entity} ${recordId} is ready to invoice but LedgerForce lacks its ${readiness.missing.join(', ')}; a reconcile re-reads the record`,
      );
    }
    return { kind: 'waiting', readiness };
  }

  const party = await trx
    .selectFrom('app.party')
    .select('id')
    .where('company_id', '=', companyId)
    .where('salesforce_account_id', '=', h.accountRecordId ?? '')
    .executeTakeFirst();
  if (!party) {
    return issue(
      'UNKNOWN_ACCOUNT',
      `${entity} ${recordId}: Account ${h.accountRecordId ?? ''} is not a LedgerForce party yet`,
    );
  }
  const active = lines.filter((l) => !l.line.archived);
  const unknown = active
    .filter((l) => !l.productId)
    .map((l) => l.line.product2RecordId ?? '(none)');
  if (unknown.length > 0) {
    return issue(
      'UNKNOWN_PRODUCT',
      `${entity} ${recordId}: Product2 ${unknown.join(', ')} not a LedgerForce product yet`,
    );
  }

  let issueDate = h.sourceDate ?? '';
  let note: string | undefined;
  try {
    const d = await resolvePostingDate(trx, {
      companyId,
      entryDate: issueDate,
      sourceType: 'ar_invoice',
    });
    issueDate = d.entryDate;
    note = d.note;
  } catch (e) {
    if (e instanceof PeriodLockedError) return issue(e.code, e.message);
    throw e;
  }

  const format = await sql<{ id: string; tax_treatment: 'exclusive' | 'inclusive' }>`
    SELECT id::text, tax_treatment FROM app.billing_format
     WHERE company_id = ${companyId} AND status = 'active' AND posted
       AND (${settings.billingFormatId}::uuid IS NULL AND line_source = ${LINE_SOURCE[entity]}
            OR id = ${settings.billingFormatId}::uuid)
     ORDER BY (code = 'STANDARD') DESC, code LIMIT 1`
    .execute(trx)
    .then((r) => r.rows[0]);
  if (!format) {
    return issue(
      'NO_BILLING_FORMAT',
      `no active posted billing format with line source ${LINE_SOURCE[entity]} for ${entity} ${recordId}`,
    );
  }

  let view: InvoiceView;
  try {
    view = await createDraftInvoice(
      trx,
      {
        companyId,
        partyId: party.id,
        issueDate,
        pricing: format.tax_treatment,
        reference: `${entity} ${h.name ?? recordId}`.slice(0, 200),
        sourceKey: sourceKeyOf(entity, recordId),
        billingFormatId: format.id,
        ...(note ? { note: note.slice(0, 1000) } : {}),
        lines: active.map((l) => ({ productId: l.productId ?? '', ...invoiceLineFor(l.line) })),
      },
      { outbox: deps.outbox, ...(deps.posting ? { posting: deps.posting } : {}) },
    );
  } catch (e) {
    if (e instanceof InvoiceError) return issue(e.code, e.message);
    throw e;
  }
  await sql`
    UPDATE app.salesforce_billing_source SET invoice_id = ${view.invoiceId}::uuid
     WHERE id = ${h.id}::uuid`.execute(trx);
  await announce(trx, companyId, h, view, deps);
  return {
    kind: view.status === 'posted' ? 'posted' : 'drafted',
    invoiceId: view.invoiceId,
    invoice: view,
  };
}

/** Outbox event for the write-back (contract v1, writeback/mapping.ts): current state only. */
async function announce(
  trx: Trx,
  companyId: string,
  h: SourceHeader,
  view: InvoiceView,
  deps: BillingDeps,
): Promise<void> {
  const inv = await sql<{ issue_date: string; due_date: string }>`
    SELECT to_char(issue_date, 'YYYY-MM-DD') AS issue_date, to_char(due_date, 'YYYY-MM-DD') AS due_date
      FROM app.sales_invoice WHERE id = ${view.invoiceId}::uuid`
    .execute(trx)
    .then((r) => r.rows[0]);
  const posted = view.status === 'posted';
  const opportunity = h.entityName === 'Opportunity';
  await deps.outbox.publish(trx, {
    companyId,
    topic: posted ? INVOICE_POSTED_TOPIC : INVOICE_DRAFTED_TOPIC,
    aggregateType: 'sales_invoice',
    aggregateId: view.invoiceId,
    payload: {
      invoiceId: view.invoiceId,
      sourceKey: sourceKeyOf(h.entityName, h.recordId),
      writeBack: {
        version: 1,
        ...(posted && inv && view.gross
          ? {
              invoices: [
                {
                  id: view.invoiceId,
                  number: view.invoiceNo,
                  status: 'posted',
                  issueDate: inv.issue_date,
                  dueDate: inv.due_date,
                  total: view.gross,
                  amountDue: view.gross,
                  accountSfId: h.accountRecordId,
                  ...(opportunity ? { opportunitySfId: h.recordId } : {}),
                },
              ],
            }
          : {}),
        ...(opportunity
          ? {
              opportunities: [
                {
                  sfId: h.recordId,
                  invoiceStatus: view.status,
                  ...(posted && view.gross ? { amountInvoiced: view.gross } : {}),
                },
              ],
            }
          : {}),
      },
    },
  });
}
