/**
 * Re-push of stale write-backs — the outbound half of the nightly reconciliation (T-0070,
 * SS-PLAT-26, design §5.3–§5.6, RQ-0110 findings 5–6, migration 0053).
 *
 * Per Salesforce record and LedgerForce-owned field, Salesforce should hold the value of the
 * newest write-back event (outbox order: created_at, then id) that names the field (contract v1:
 * current state; an absent key is not written, null clears). It does only if that event was
 * delivered and no older event naming the field was delivered by the outbox *after* it (a
 * backed-off retry of an old event overwrites a newer value). Anything else is stale.
 *
 * Stale records are re-pushed per record with their merged newest values — never an old event
 * replayed over a newer one. An undelivered event is then settled: its `salesforce.writeback`
 * inbox row is written (so a late outbox retry or a one-click retry skips it instead of rolling
 * Salesforce back) once every record it names is current, and the event is recorded in
 * app.salesforce_writeback_reconciled so the next run does not mistake that inbox row for an
 * out-of-order delivery. HTTP calls never run inside a database transaction.
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely } from 'kysely';
import { planBatches, type SfValue, type WriteBackRecord } from '../writeback/batch.ts';
import { sendCollection, type RestSession } from '../writeback/collections.ts';
import { mapToRecords, parseWriteBackPayload, WRITEBACK_TOPICS } from '../writeback/mapping.ts';
import { SALESFORCE_WRITEBACK_HANDLER, type RecordFailure } from '../writeback/writeback.ts';

export interface WriteBackEventRow {
  id: string;
  createdAt: Date;
  payload: Record<string, unknown>;
  /** The `salesforce.writeback` inbox row's processed_at; null = not delivered. */
  deliveredAt: Date | null;
  /** The inbox row was written by a reconciliation (the event never wrote its own values). */
  reconciled?: boolean;
}

export interface RepushPlan {
  /** Stale records with the merged newest value of every field the window names. */
  records: WriteBackRecord[];
  /** `recordKey` of each record, same order. */
  keys: string[];
  /** Undelivered events and the stale records that must succeed before they are settled. */
  cover: { eventId: string; keys: string[] }[];
  /** Events whose payload breaks the contract (the outbox dead-letters them too). */
  unmappable: { eventId: string; error: string }[];
}

export const recordKey = (r: { op: string; sobject: string; key: string }): string =>
  `${r.op}|${r.sobject}|${r.key}`;

interface FieldState {
  value: SfValue;
  eventId: string;
  deliveredAt: Date | null;
}
interface RecordState {
  base: WriteBackRecord;
  fields: Map<string, FieldState>;
  /** Latest outbox (not reconciliation) delivery per field. */
  lastWrite: Map<string, number>;
}

/** Decide which records are stale and which undelivered events they settle (pure). */
export function planRepush(events: readonly WriteBackEventRow[]): RepushPlan {
  const ordered = [...events].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const state = new Map<string, RecordState>();
  const pending: { eventId: string; keys: string[] }[] = [];
  const unmappable: RepushPlan['unmappable'] = [];
  for (const e of ordered) {
    let records: WriteBackRecord[];
    try {
      records = mapToRecords(parseWriteBackPayload(e.payload));
    } catch (err) {
      unmappable.push({ eventId: e.id, error: (err as Error).message });
      continue;
    }
    const keys: string[] = [];
    for (const r of records) {
      const key = recordKey(r);
      if (!keys.includes(key)) keys.push(key);
      const s = state.get(key) ?? { base: r, fields: new Map(), lastWrite: new Map() };
      state.set(key, s);
      for (const [field, value] of Object.entries(r.fields)) {
        s.fields.set(field, { value, eventId: e.id, deliveredAt: e.deliveredAt });
        if (e.deliveredAt && !e.reconciled) {
          const t = e.deliveredAt.getTime();
          s.lastWrite.set(field, Math.max(t, s.lastWrite.get(field) ?? t));
        }
      }
    }
    if (e.deliveredAt === null) pending.push({ eventId: e.id, keys });
  }
  const stale = new Set<string>();
  for (const [key, s] of state) {
    for (const [field, newest] of s.fields) {
      const written = s.lastWrite.get(field);
      if (
        newest.deliveredAt === null ||
        (written !== undefined && written > newest.deliveredAt.getTime())
      ) {
        stale.add(key);
        break;
      }
    }
  }
  const keys = [...state.keys()].filter((k) => stale.has(k));
  const records = keys.map((k) => {
    const s = state.get(k) as RecordState;
    const fields: Record<string, SfValue> = {};
    for (const [f, v] of s.fields) fields[f] = v.value;
    return { ...s.base, fields };
  });
  return {
    records,
    keys,
    cover: pending.map((p) => ({ eventId: p.eventId, keys: p.keys.filter((k) => stale.has(k)) })),
    unmappable,
  };
}

export interface RepushReport {
  /** Write-back events read in the comparison window. */
  events: number;
  staleRecords: number;
  requests: number;
  pushed: number;
  failed: number;
  /** Undelivered events settled (inbox row written). */
  marked: number;
  unmappable: number;
  /** Database time the comparison started at (next run's `since`). */
  checkedAt: Date;
  failures: RecordFailure[];
}

export interface RepushOptions {
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  session: RestSession;
  /** Outbox deliveries before this database time were already checked (null = never). */
  since: Date | null;
  /** Events younger than this are left to the outbox (still retrying); default 3,600 s. */
  graceSeconds?: number;
}

interface EventSqlRow {
  id: string;
  created_at: Date;
  payload: Record<string, unknown>;
  processed_at: Date | null;
  reconciled: boolean;
}

/** Find stale write-backs, re-push them per record and settle the events they cover. */
export async function repushStaleWriteBacks(o: RepushOptions): Promise<RepushReport> {
  const grace = o.graceSeconds ?? 3600;
  const topics = [...WRITEBACK_TOPICS];
  const { checkedAt, rows } = await withTenant(o.db, o.tenantId, async (trx) => {
    const head = await sql<{ checked_at: Date; cutoff: Date; start: Date | null }>`
      WITH c AS (SELECT clock_timestamp() AS checked_at,
                        clock_timestamp() - make_interval(secs => ${grace}) AS cutoff)
      SELECT c.checked_at, c.cutoff,
             (SELECT min(e.created_at)
                FROM app.outbox_event e
                LEFT JOIN app.outbox_inbox i
                       ON i.event_id = e.id AND i.handler = ${SALESFORCE_WRITEBACK_HANDLER}
                LEFT JOIN app.salesforce_writeback_reconciled r ON r.event_id = e.id
               WHERE e.company_id = ${o.companyId} AND e.topic = ANY(${topics}::text[])
                 AND e.payload ? 'writeBack' AND e.created_at <= c.cutoff
                 AND (i.event_id IS NULL
                      OR (r.event_id IS NULL
                          AND i.processed_at > coalesce(${o.since}::timestamptz, '-infinity')))
             ) AS start
        FROM c`.execute(trx);
    const h = head.rows[0];
    if (!h) throw new Error('write-back reconciliation: no clock');
    if (!h.start) return { checkedAt: h.checked_at, rows: [] };
    const window = await sql<EventSqlRow>`
      SELECT e.id, e.created_at, e.payload, i.processed_at, (r.event_id IS NOT NULL) AS reconciled
        FROM app.outbox_event e
        LEFT JOIN app.outbox_inbox i
               ON i.event_id = e.id AND i.handler = ${SALESFORCE_WRITEBACK_HANDLER}
        LEFT JOIN app.salesforce_writeback_reconciled r ON r.event_id = e.id
       WHERE e.company_id = ${o.companyId} AND e.topic = ANY(${topics}::text[])
         AND e.payload ? 'writeBack' AND e.created_at >= ${h.start} AND e.created_at <= ${h.cutoff}
       ORDER BY e.created_at, e.id`.execute(trx);
    return { checkedAt: h.checked_at, rows: window.rows };
  });
  const plan = planRepush(
    rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      payload: r.payload,
      deliveredAt: r.processed_at,
      reconciled: r.reconciled,
    })),
  );
  const report: RepushReport = {
    events: rows.length,
    staleRecords: plan.records.length,
    requests: 0,
    pushed: 0,
    failed: 0,
    marked: 0,
    unmappable: plan.unmappable.length,
    checkedAt,
    failures: [],
  };
  const ok = new Set<string>();
  for (const request of planBatches(plan.records)) {
    const results = await sendCollection(o.session, request);
    report.requests += 1;
    results.forEach((r, i) => {
      const rec = request.records[i];
      if (!rec) return;
      if (r.success) {
        ok.add(recordKey({ op: request.op, ...rec }));
        report.pushed += 1;
      } else {
        report.failed += 1;
        report.failures.push({ ...rec, errors: r.errors });
      }
    });
  }
  const settled = plan.cover.filter((c) => c.keys.every((k) => ok.has(k)));
  if (settled.length > 0) {
    await withTenant(o.db, o.tenantId, async (trx) => {
      for (const c of settled) {
        const ins = await sql<{ event_id: string }>`
          INSERT INTO app.outbox_inbox (event_id, handler)
          VALUES (${c.eventId}, ${SALESFORCE_WRITEBACK_HANDLER})
          ON CONFLICT DO NOTHING RETURNING event_id`.execute(trx);
        // Delivered by the outbox meanwhile: that delivery is a real write, leave it as it is.
        if (ins.rows.length === 0) continue;
        await sql`INSERT INTO app.salesforce_writeback_reconciled (event_id, repushed)
                  VALUES (${c.eventId}, ${c.keys.length > 0})`.execute(trx);
        report.marked += 1;
      }
    });
  }
  return report;
}
