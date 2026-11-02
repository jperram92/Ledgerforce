/**
 * Mirror an inbound Opportunity / Order / line item change into app.salesforce_billing_source(_line)
 * (T-0069, migration 0052, RQ-0106), then evaluate the source for an invoice. Called by the
 * inbound mapping (apply.ts) inside the processed-change savepoint. Body semantics are those of
 * planChange (RQ-0101): only keys present in `plan.values` change; null clears.
 *
 * RQ-0106 findings 2–3: a StageName change without IsWon resets is_won to unknown, a Status
 * change without StatusCode resets status_code — derived flags are never left stale.
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { InboundChange, InboundValue, PlannedChange } from '../inbound/inbound-map.ts';
import type { BillingEntity } from './billing-source.ts';
import {
  evaluateBillingSource,
  sfDate,
  sfNumber,
  type BillingDeps,
  type BillingOutcome,
} from './source.ts';

type Trx = Transaction<Database>;

export interface MirrorResult {
  outcome: 'applied' | 'archived' | 'ignored' | 'issue';
  targetId: string | null;
  applied: string[];
  issue?: { code: string; message: string };
  billing?: BillingOutcome;
}

const PARENT: Readonly<Record<string, BillingEntity>> = Object.freeze({
  OpportunityLineItem: 'Opportunity',
  OrderItem: 'Order',
});

const str = (v: InboundValue | undefined): string | null => (typeof v === 'string' ? v : null);

/** Column ← target key, with its conversion. */
const HEADER_COLUMNS: Readonly<Record<string, [string, (v: InboundValue) => unknown]>> = {
  name: ['name', (v) => str(v)?.slice(0, 255) ?? null],
  account: ['account_record_id', str],
  stage: ['stage_name', str],
  is_won: [
    'is_won',
    (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null),
  ],
  status: ['status', str],
  status_code: ['status_code', str],
  date: ['source_date', (v) => sfDate(str(v))],
  amount: ['amount', (v) => sfNumber(str(v))],
  currency: ['currency', str],
};
const LINE_COLUMNS: Readonly<Record<string, [string, (v: InboundValue) => unknown]>> = {
  parent: ['parent_record_id', str],
  product: ['product2_record_id', str],
  quantity: ['quantity', (v) => sfNumber(str(v))],
  unit_price: ['unit_price', (v) => sfNumber(str(v))],
  total_price: ['total_price', (v) => sfNumber(str(v))],
  description: ['description', (v) => str(v)?.slice(0, 4000) ?? null],
};

function columns(
  plan: PlannedChange,
  map: Readonly<Record<string, [string, (v: InboundValue) => unknown]>>,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, v] of plan.values) {
    const col = map[key];
    if (col) out.set(col[0], col[1](v));
  }
  if (plan.values.has('stage') && !plan.values.has('is_won')) out.set('is_won', null);
  if (plan.values.has('status') && !plan.values.has('status_code')) out.set('status_code', null);
  return out;
}

async function upsert(
  trx: Trx,
  table: 'app.salesforce_billing_source' | 'app.salesforce_billing_source_line',
  companyId: string,
  c: InboundChange,
  cols: Map<string, unknown>,
): Promise<string> {
  if (c.changeType === 'DELETE') cols.set('archived', true);
  else if (c.changeType === 'UNDELETE' || c.changeType === 'CREATE') cols.set('archived', false);
  const names = [...cols.keys()];
  const values = names.map((n) => sql`${cols.get(n)}`);
  const { rows } = await sql<{ id: string }>`
    INSERT INTO ${sql.table(table)} (company_id, entity_name, record_id
      ${names.length ? sql`, ${sql.join(names.map((n) => sql.ref(n)))}` : sql``})
    VALUES (${companyId}, ${c.entityName}, ${c.recordId}
      ${names.length ? sql`, ${sql.join(values)}` : sql``})
    ON CONFLICT (tenant_id, company_id, entity_name, record_id) DO UPDATE
       SET ${sql.join([
         ...names.map((n) => sql`${sql.ref(n)} = EXCLUDED.${sql.ref(n)}`),
         sql`updated_at = clock_timestamp()`,
       ])}
    RETURNING id::text`.execute(trx);
  return rows[0]?.id ?? '';
}

/** Mirror the change; then, with billing deps, evaluate its source for an invoice. */
export async function mirrorBillingChange(
  trx: Trx,
  companyId: string,
  c: InboundChange,
  plan: PlannedChange,
  deps: BillingDeps | undefined,
): Promise<MirrorResult> {
  const isLine = c.entityName in PARENT;
  if (!isLine && c.changeType === 'DELETE') {
    const exists = await sql`
      SELECT 1 FROM app.salesforce_billing_source
       WHERE company_id = ${companyId} AND entity_name = ${c.entityName} AND record_id = ${c.recordId}`
      .execute(trx)
      .then((r) => r.rows.length > 0);
    if (!exists) return { outcome: 'ignored', targetId: null, applied: [] };
  }
  const cols = columns(plan, isLine ? LINE_COLUMNS : HEADER_COLUMNS);
  const id = await upsert(
    trx,
    isLine ? 'app.salesforce_billing_source_line' : 'app.salesforce_billing_source',
    companyId,
    c,
    cols,
  );
  const applied = [...plan.values.keys(), ...(c.changeType === 'DELETE' ? ['archived'] : [])];
  const outcome = c.changeType === 'DELETE' ? 'archived' : 'applied';

  let parent: { entity: BillingEntity; recordId: string } | null = null;
  if (isLine) {
    const p = await sql<{ parent_record_id: string | null }>`
      SELECT parent_record_id FROM app.salesforce_billing_source_line WHERE id = ${id}::uuid`
      .execute(trx)
      .then((r) => r.rows[0]?.parent_record_id ?? null);
    if (p) parent = { entity: PARENT[c.entityName] as BillingEntity, recordId: p };
  } else {
    parent = { entity: c.entityName as BillingEntity, recordId: c.recordId };
  }
  if (!deps || !parent) return { outcome, targetId: id, applied };

  const billing = await evaluateBillingSource(trx, companyId, parent.entity, parent.recordId, deps);
  if (billing.kind === 'issue') {
    return {
      outcome: 'issue',
      targetId: null,
      applied: [],
      issue: { code: billing.code, message: billing.message },
      billing,
    };
  }
  return { outcome, targetId: id, applied, billing };
}
