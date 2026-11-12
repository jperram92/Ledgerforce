/**
 * Polling fallback per object and reconciliation replay (T-0066, design §5.3, RQ-0103,
 * migration 0051).
 *
 * `pollObject` reads one object's SystemModstamp delta through queryAll — from the stored
 * watermark minus the overlap window — and feeds every row to the T-0065 mapping
 * (`applyInboundChange`) as a snapshot change, so polling, reconciliation and CDC converge on one
 * state with one idempotency log. Each page is applied in its own tenant transaction together
 * with the watermark advance (the highest SystemModstamp of the page, Salesforce's clock), so a
 * failure loses at most the page in flight and the next run resumes from the last committed page.
 * HTTP calls never run inside a database transaction.
 *
 * `runPollingCycle` is the scheduler: it polls the company's objects in `polling` mode whose
 * `next_poll_at` has come, one after another; one object's failure does not stop the others.
 * `reconcileInbound` replays every mapped object whatever its mode (source `reconcile`) — the
 * inbound half of the nightly reconciliation (SS-PLAT-26; re-push of stale write-backs is T-0070).
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { applyInboundChange } from '../inbound/apply.ts';
import { INBOUND_FIELD_MAP, type InboundChangeType } from '../inbound/inbound-map.ts';
import type { InboundIssueSink } from '../inbound/issues.ts';
import { deltaSoql, parseModstamp, pollFields, polledChange } from './delta.ts';
import { describeFields, queryAllPages, type QuerySession } from './query-client.ts';

type Trx = Transaction<Database>;

export type SyncMode = 'cdc' | 'polling';

export interface SyncObject {
  entity: string;
  mode: SyncMode;
  pollIntervalSeconds: number;
  overlapSeconds: number;
  /** Highest SystemModstamp read and committed; null = never read. */
  watermark: Date | null;
  nextPollAt: Date | null;
  lastPolledAt: Date | null;
  lastPollSource: string | null;
  lastPollRecords: number | null;
  lastPollError: string | null;
  /** Salesforce time up to which deletions were checked for purges (T-0070); null = never. */
  deletesCheckedUntil: Date | null;
}

/** Choose CDC or polling for an object (setup); omitted settings keep their current value. */
export async function configureSyncObject(
  trx: Trx,
  companyId: string,
  entity: string,
  opts: { mode: SyncMode; pollIntervalSeconds?: number; overlapSeconds?: number },
): Promise<void> {
  const interval = opts.pollIntervalSeconds ?? null;
  const overlap = opts.overlapSeconds ?? null;
  await sql`
    INSERT INTO app.salesforce_sync_object
           (company_id, entity_name, mode, poll_interval_seconds, overlap_seconds)
    VALUES (${companyId}, ${entity}, ${opts.mode}, coalesce(${interval}::integer, 900),
            coalesce(${overlap}::integer, 300))
    ON CONFLICT (tenant_id, company_id, entity_name) DO UPDATE
       SET mode = EXCLUDED.mode,
           poll_interval_seconds = coalesce(${interval}::integer,
                                            app.salesforce_sync_object.poll_interval_seconds),
           overlap_seconds = coalesce(${overlap}::integer, app.salesforce_sync_object.overlap_seconds)`.execute(
    trx,
  );
}

export async function getSyncObject(
  trx: Trx,
  companyId: string,
  entity: string,
): Promise<SyncObject | null> {
  const { rows } = await sql<{
    mode: SyncMode;
    poll_interval_seconds: number;
    overlap_seconds: number;
    watermark: Date | null;
    next_poll_at: Date | null;
    last_polled_at: Date | null;
    last_poll_source: string | null;
    last_poll_records: number | null;
    last_poll_error: string | null;
    deletes_checked_until: Date | null;
  }>`SELECT mode, poll_interval_seconds, overlap_seconds, watermark, next_poll_at, last_polled_at,
            last_poll_source, last_poll_records, last_poll_error, deletes_checked_until
       FROM app.salesforce_sync_object
      WHERE company_id = ${companyId} AND entity_name = ${entity}`.execute(trx);
  const r = rows[0];
  if (!r) return null;
  return {
    entity,
    mode: r.mode,
    pollIntervalSeconds: r.poll_interval_seconds,
    overlapSeconds: r.overlap_seconds,
    watermark: r.watermark,
    nextPollAt: r.next_poll_at,
    lastPolledAt: r.last_polled_at,
    lastPollSource: r.last_poll_source,
    lastPollRecords: r.last_poll_records,
    lastPollError: r.last_poll_error,
    deletesCheckedUntil: r.deletes_checked_until,
  };
}

export interface PollContext {
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  session: QuerySession;
  reportIssue: InboundIssueSink;
  now?: () => Date;
}

export interface PollOptions extends PollContext {
  entity: string;
  /** `poll:<Object>` by default; `reconcile` for the nightly replay. */
  source?: string;
  /** The object's queryable fields (describe); fetched when omitted (one API call). */
  fields?: ReadonlySet<string>;
}

export interface PollReport {
  entity: string;
  source: string;
  since: Date;
  pages: number;
  records: number;
  applied: number;
  archived: number;
  ignored: number;
  duplicates: number;
  issues: number;
  watermark: Date | null;
}

/** Change type of the record's newest applied change (to recognise an undelete). */
async function lastAppliedChangeType(
  trx: Trx,
  companyId: string,
  entity: string,
  recordId: string,
): Promise<InboundChangeType | null> {
  const { rows } = await sql<{ change_type: InboundChangeType }>`
    SELECT change_type FROM app.salesforce_inbound_change
     WHERE company_id = ${companyId} AND entity_name = ${entity} AND record_id = ${recordId}
       AND outcome IN ('applied', 'archived')
     ORDER BY commit_timestamp DESC, processed_at DESC LIMIT 1`.execute(trx);
  return rows[0]?.change_type ?? null;
}

export async function pollObject(o: PollOptions): Promise<PollReport> {
  const now = (o.now ?? (() => new Date()))();
  const source = o.source ?? `poll:${o.entity}`;
  const tenant = <R>(fn: (trx: Trx) => Promise<R>) => withTenant(o.db, o.tenantId, fn);
  const cfg = await tenant(async (trx) => {
    await sql`INSERT INTO app.salesforce_sync_object (company_id, entity_name)
              VALUES (${o.companyId}, ${o.entity}) ON CONFLICT DO NOTHING`.execute(trx);
    return getSyncObject(trx, o.companyId, o.entity);
  });
  if (!cfg) throw new Error(`sync object ${o.entity} could not be created`);
  const since = cfg.watermark
    ? new Date(cfg.watermark.getTime() - cfg.overlapSeconds * 1000)
    : new Date(0);
  const report: PollReport = {
    entity: o.entity,
    source,
    since,
    pages: 0,
    records: 0,
    applied: 0,
    archived: 0,
    ignored: 0,
    duplicates: 0,
    issues: 0,
    watermark: cfg.watermark,
  };
  const finish = (error: string | null) =>
    tenant((trx) =>
      sql`UPDATE app.salesforce_sync_object
             SET last_polled_at = ${now}, last_poll_source = ${source},
                 last_poll_records = ${report.records}, last_poll_error = ${error},
                 next_poll_at = ${now}::timestamptz + make_interval(secs => poll_interval_seconds)
           WHERE company_id = ${o.companyId} AND entity_name = ${o.entity}`.execute(trx),
    );
  try {
    const fields = pollFields(o.entity, o.fields ?? (await describeFields(o.session, o.entity)));
    if (fields.length === 0) throw new RangeError(`${o.entity} has no inbound-mapped fields`);
    for await (const page of queryAllPages(o.session, deltaSoql(o.entity, fields, since))) {
      await tenant(async (trx) => {
        let high: Date | null = null;
        for (const row of page) {
          const recordId = typeof row['Id'] === 'string' ? row['Id'] : '';
          const c = polledChange(source, o.entity, row, {
            lastAppliedChangeType: await lastAppliedChangeType(
              trx,
              o.companyId,
              o.entity,
              recordId,
            ),
          });
          const r = await applyInboundChange(
            trx,
            { companyId: o.companyId, reportIssue: o.reportIssue },
            c,
          );
          if (r.outcome === 'applied') report.applied += 1;
          else if (r.outcome === 'archived') report.archived += 1;
          else if (r.outcome === 'ignored') report.ignored += 1;
          else if (r.outcome === 'duplicate') report.duplicates += 1;
          else report.issues += 1;
          const stamp = parseModstamp(row['SystemModstamp']);
          if (!high || stamp > high) high = stamp;
        }
        if (high) {
          await sql`UPDATE app.salesforce_sync_object
                       SET watermark = greatest(coalesce(watermark, ${high}), ${high})
                     WHERE company_id = ${o.companyId} AND entity_name = ${o.entity}`.execute(trx);
          if (!report.watermark || high > report.watermark) report.watermark = high;
        }
      });
      report.pages += 1;
      report.records += page.length;
    }
  } catch (e) {
    await finish((e as Error).message.slice(0, 1000));
    throw e;
  }
  await finish(null);
  return report;
}

/** The scheduler: poll every object in `polling` mode that is due. */
export async function runPollingCycle(
  ctx: PollContext,
): Promise<{ polled: PollReport[]; failed: { entity: string; error: string }[] }> {
  const now = (ctx.now ?? (() => new Date()))();
  const due = await withTenant(ctx.db, ctx.tenantId, (trx) =>
    sql<{ entity_name: string }>`
      SELECT entity_name FROM app.salesforce_sync_object
       WHERE company_id = ${ctx.companyId} AND mode = 'polling'
         AND (next_poll_at IS NULL OR next_poll_at <= ${now})
       ORDER BY entity_name`.execute(trx),
  );
  const polled: PollReport[] = [];
  const failed: { entity: string; error: string }[] = [];
  for (const { entity_name: entity } of due.rows) {
    try {
      polled.push(await pollObject({ ...ctx, now: () => now, entity }));
    } catch (e) {
      failed.push({ entity, error: (e as Error).message });
    }
  }
  return { polled, failed };
}

/**
 * Inbound replay of the nightly reconciliation: every mapped object (or `entities`), whatever its
 * mode, from its watermark. Throws an AggregateError after trying all objects if any failed.
 */
export async function reconcileInbound(
  ctx: PollContext & { entities?: readonly string[] },
): Promise<PollReport[]> {
  const reports: PollReport[] = [];
  const errors: Error[] = [];
  for (const entity of ctx.entities ?? INBOUND_FIELD_MAP.map((m) => m.entity)) {
    try {
      reports.push(await pollObject({ ...ctx, entity, source: 'reconcile' }));
    } catch (e) {
      errors.push(e as Error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'inbound reconciliation failed');
  return reports;
}
