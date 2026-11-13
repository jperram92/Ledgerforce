/**
 * Nightly reconciliation with Salesforce (T-0070, SS-PLAT-26, design §5.3, RQ-0103, RQ-0110,
 * migration 0053). One run per company, in order:
 *  1. inbound replay — every mapped object's SystemModstamp delta from its watermark (T-0066
 *     `pollObject`, source `reconcile`): changes CDC missed are replayed once;
 *  2. purge detection — records deleted and purged from the Recycle Bin are archived;
 *  3. write-back re-push — stale LedgerForce-owned values are re-pushed per record.
 * A step's failure (or one object's) does not stop the others; the run is logged with its counts
 * and a secret-free error, and a failed run is retried within the hour.
 *
 * Scheduling is data (`app.salesforce_reconciliation.next_run_at`), not pg-boss cron: lf_app's
 * pg-boss runs with `schedule: false` (packages/outbox AGENTS.md, DL-0298). The worker calls
 * `runNightlyReconciliation` on its tick; the claim is one UPDATE, so two workers never run the
 * same company at once. The local clock only decides when to run; every watermark is Salesforce's
 * clock (inbound) or the database's (outbox).
 */
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { INBOUND_FIELD_MAP } from '../inbound/inbound-map.ts';
import type { InboundIssueSink } from '../inbound/issues.ts';
import { pollObject, type PollReport } from '../polling/poller.ts';
import type { QuerySession } from '../polling/query-client.ts';
import type { RestSession } from '../writeback/collections.ts';
import { detectPurges, type PurgeReport } from './purges.ts';
import { repushStaleWriteBacks, type RepushReport } from './stale-writebacks.ts';

type Trx = Transaction<Database>;

/** A failed run is retried after at most this long. */
export const RETRY_FAILED_RUN_SECONDS = 3600;

export interface ReconciliationSchedule {
  intervalSeconds: number;
  nextRunAt: Date | null;
  writebackCheckedUntil: Date | null;
  lastStartedAt: Date | null;
}

/** Set the schedule (setup); omitted settings keep their value. `nextRunAt` null = due now. */
export async function configureReconciliation(
  trx: Trx,
  companyId: string,
  opts: { intervalSeconds?: number; nextRunAt?: Date | null } = {},
): Promise<void> {
  const interval = opts.intervalSeconds ?? null;
  const setNext = opts.nextRunAt !== undefined;
  const next = opts.nextRunAt ?? null;
  await sql`
    INSERT INTO app.salesforce_reconciliation (company_id, interval_seconds, next_run_at)
    VALUES (${companyId}, coalesce(${interval}::integer, 86400), ${next})
    ON CONFLICT (tenant_id, company_id) DO UPDATE
       SET interval_seconds = coalesce(${interval}::integer,
                                       app.salesforce_reconciliation.interval_seconds),
           next_run_at = CASE WHEN ${setNext} THEN ${next}::timestamptz
                              ELSE app.salesforce_reconciliation.next_run_at END`.execute(trx);
}

export async function getReconciliation(
  trx: Trx,
  companyId: string,
): Promise<ReconciliationSchedule | null> {
  const { rows } = await sql<{
    interval_seconds: number;
    next_run_at: Date | null;
    writeback_checked_until: Date | null;
    last_started_at: Date | null;
  }>`SELECT interval_seconds, next_run_at, writeback_checked_until, last_started_at
       FROM app.salesforce_reconciliation WHERE company_id = ${companyId}`.execute(trx);
  const r = rows[0];
  return r
    ? {
        intervalSeconds: r.interval_seconds,
        nextRunAt: r.next_run_at,
        writebackCheckedUntil: r.writeback_checked_until,
        lastStartedAt: r.last_started_at,
      }
    : null;
}

export interface ReconciliationRun {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  outcome: 'succeeded' | 'failed';
  report: Record<string, unknown>;
  error: string | null;
}

export async function listReconciliationRuns(
  trx: Trx,
  companyId: string,
): Promise<ReconciliationRun[]> {
  const { rows } = await sql<{
    id: string;
    started_at: Date;
    finished_at: Date;
    outcome: 'succeeded' | 'failed';
    report: Record<string, unknown>;
    error: string | null;
  }>`SELECT id, started_at, finished_at, outcome, report, error
       FROM app.salesforce_reconciliation_run
      WHERE company_id = ${companyId}
      ORDER BY started_at, id`.execute(trx);
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.outcome,
    report: r.report,
    error: r.error,
  }));
}

export interface NightlyContext {
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  /** Session for the REST query and Get Deleted resources. */
  query: QuerySession;
  /** Session for sObject Collections (write-back). */
  rest: RestSession;
  reportIssue: InboundIssueSink;
  now?: () => Date;
  /** Run even if not due (an operator's "reconcile now"). */
  force?: boolean;
  /** Write-back events younger than this are left to the outbox; default 3,600 s. */
  graceSeconds?: number;
}

export interface NightlyReport {
  runId: string;
  outcome: 'succeeded' | 'failed';
  inbound: PollReport[];
  purges: PurgeReport[];
  writeBack: Omit<RepushReport, 'failures' | 'checkedAt'> | null;
  errors: string[];
}

/** Secret-free one-line description (connector errors are classified, without bodies). */
function describe(step: string, e: unknown): string {
  const err = e as { kind?: unknown; name?: unknown; message?: unknown };
  const kind =
    typeof err.kind === 'string' ? err.kind : typeof err.name === 'string' ? err.name : 'Error';
  const msg = typeof err.message === 'string' ? err.message : String(e);
  return `${step}: ${kind}: ${msg}`.slice(0, 300);
}

/** Run the reconciliation if it is due; null when it is not. */
export async function runNightlyReconciliation(ctx: NightlyContext): Promise<NightlyReport | null> {
  const now = (ctx.now ?? (() => new Date()))();
  const tenant = <R>(fn: (trx: Trx) => Promise<R>) => withTenant(ctx.db, ctx.tenantId, fn);
  const claim = await tenant(async (trx) => {
    await sql`INSERT INTO app.salesforce_reconciliation (company_id) VALUES (${ctx.companyId})
              ON CONFLICT DO NOTHING`.execute(trx);
    const { rows } = await sql<{ started_at: Date; writeback_checked_until: Date | null }>`
      UPDATE app.salesforce_reconciliation
         SET next_run_at = ${now}::timestamptz + make_interval(secs => interval_seconds),
             last_started_at = ${now}
       WHERE company_id = ${ctx.companyId}
         AND (${ctx.force === true} OR next_run_at IS NULL OR next_run_at <= ${now})
      RETURNING clock_timestamp() AS started_at, writeback_checked_until`.execute(trx);
    return rows[0] ?? null;
  });
  if (!claim) return null;

  const poll = {
    db: ctx.db,
    tenantId: ctx.tenantId,
    companyId: ctx.companyId,
    session: ctx.query,
    reportIssue: ctx.reportIssue,
    now: () => now,
  };
  const errors: string[] = [];
  const inbound: PollReport[] = [];
  for (const { entity } of INBOUND_FIELD_MAP) {
    try {
      inbound.push(await pollObject({ ...poll, entity, source: 'reconcile' }));
    } catch (e) {
      errors.push(describe(`inbound ${entity}`, e));
    }
  }
  // Purges after the replay: an undelete or a late soft delete is applied first.
  const purges = await detectPurges(poll);
  for (const f of purges.failed) errors.push(describe(`purges ${f.entity}`, f.error));

  let writeBack: NightlyReport['writeBack'] = null;
  try {
    const { failures, checkedAt, ...counts } = await repushStaleWriteBacks({
      db: ctx.db,
      tenantId: ctx.tenantId,
      companyId: ctx.companyId,
      session: ctx.rest,
      since: claim.writeback_checked_until,
      ...(ctx.graceSeconds === undefined ? {} : { graceSeconds: ctx.graceSeconds }),
    });
    writeBack = counts;
    for (const f of failures.slice(0, 5)) {
      errors.push(
        `write-back: ${f.sobject} ${f.key} ${f.errors.map((e) => e.statusCode).join(',')}`.slice(
          0,
          300,
        ),
      );
    }
    if (failures.length === 0) {
      await tenant((trx) =>
        sql`UPDATE app.salesforce_reconciliation
               SET writeback_checked_until = greatest(coalesce(writeback_checked_until, ${checkedAt}),
                                                      ${checkedAt})
             WHERE company_id = ${ctx.companyId}`.execute(trx),
      );
    }
  } catch (e) {
    errors.push(describe('write-back', e));
  }

  const outcome = errors.length === 0 ? 'succeeded' : 'failed';
  const report = {
    inbound: inbound.map((r) => ({
      entity: r.entity,
      records: r.records,
      applied: r.applied,
      archived: r.archived,
      ignored: r.ignored,
      duplicates: r.duplicates,
      issues: r.issues,
    })),
    purges: purges.reports.map((p) => ({
      entity: p.entity,
      fullCompare: p.fullCompare,
      listed: p.listed,
      archived: p.archived,
      issues: p.issues,
    })),
    writeBack,
  };
  const runId = await tenant(async (trx) => {
    if (outcome === 'failed') {
      await sql`UPDATE app.salesforce_reconciliation
                   SET next_run_at = least(next_run_at,
                                           ${now}::timestamptz + make_interval(secs => ${RETRY_FAILED_RUN_SECONDS}))
                 WHERE company_id = ${ctx.companyId}`.execute(trx);
    }
    const { rows } = await sql<{ id: string }>`
      INSERT INTO app.salesforce_reconciliation_run (company_id, started_at, outcome, report, error)
      VALUES (${ctx.companyId}, ${claim.started_at}, ${outcome}, ${JSON.stringify(report)}::jsonb,
              ${outcome === 'failed' ? errors.join('; ').slice(0, 1000) : null})
      RETURNING id`.execute(trx);
    const id = rows[0]?.id;
    if (!id) throw new Error('reconciliation run was not recorded');
    return id;
  });
  return { runId, outcome, inbound, purges: purges.reports, writeBack, errors };
}
