/**
 * Scheduled daily jobs (T-0147, ADR-0062 option 1, accepted 2026-11-13, DL-0466; RQ-0144).
 *
 * Owner side, as lf_migrator, in the maintenance instance:
 * - `installDailySchedules` stores the daily pg-boss schedule (DAILY_FANOUT_CRON, UTC) and creates
 *   the queues.
 * - `fanOutDailyJobs` reads `app.active_tenant_ids()` (owner only) and sends one
 *   `ar.reminders.run` job per active tenant and UTC day. The job id is derived from tenant and
 *   day, so a second fan-out on the same day adds nothing.
 *
 * Application side, as lf_app, in the worker:
 * - `runTenantReminders` runs inside that tenant's transaction (RLS). It takes the run date in the
 *   tenant's report time zone and runs `runOverdueReminders` for each company. Runs are idempotent
 *   per invoice and step (app.ar_reminder primary key).
 *
 * The DAILY_FANOUT_CRON time (14:05 UTC) is 00:05 or 01:05 in Sydney, the default zone. A tenant
 * in another zone still gets one run a day, at that UTC time.
 */
import { createHash } from 'node:crypto';
import { runOverdueReminders, type DocumentOutbox } from '@ledgerforce/ar';
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { PgBoss } from 'pg-boss';

export const DAILY_FANOUT_QUEUE = 'daily.fanout';
export const AR_REMINDERS_QUEUE = 'ar.reminders.run';
export const DAILY_FANOUT_CRON = '5 14 * * *';
const DEFAULT_ZONE = 'Australia/Sydney';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The calendar date (YYYY-MM-DD) of `now` in an IANA time zone. Throws on an unknown zone. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface TenantJob {
  readonly tenantId: string;
}

export function parseTenantJob(data: unknown): TenantJob {
  const t =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)['tenantId']
      : null;
  if (typeof t !== 'string' || !UUID.test(t)) throw new Error('job data has no valid tenantId');
  return { tenantId: t.toLowerCase() };
}

/** A UUID derived from the queue, tenant and day: the same inputs give the same job id. */
function jobId(queue: string, tenantId: string, day: string): string {
  const h = createHash('sha256').update(`${queue}|${tenantId}|${day}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Owner instance only (lf_migrator): the daily schedule and its queues. Idempotent. */
export async function installDailySchedules(owner: PgBoss): Promise<void> {
  for (const name of [DAILY_FANOUT_QUEUE, AR_REMINDERS_QUEUE]) {
    if (!(await owner.getQueue(name))) {
      await owner.createQueue(name, { retryLimit: 3, retryDelay: 300, retryBackoff: true });
    }
  }
  await owner.schedule(DAILY_FANOUT_QUEUE, DAILY_FANOUT_CRON, {}, { tz: 'UTC' });
}

/**
 * Owner instance only: one `ar.reminders.run` job per active tenant for the UTC day of `now`.
 * `ownerUrl` must connect as lf_migrator, the only role that may call app.active_tenant_ids().
 */
export async function fanOutDailyJobs(
  owner: PgBoss,
  ownerUrl: string,
  now: Date,
): Promise<{ tenants: string[]; sent: number }> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  let tenants: string[];
  try {
    const { rows } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM app.active_tenant_ids()',
    );
    tenants = rows.map((r) => r.tenant_id);
  } finally {
    await client.end();
  }
  const day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const tenantId of tenants) {
    const id = await owner.send(
      AR_REMINDERS_QUEUE,
      { tenantId },
      { id: jobId(AR_REMINDERS_QUEUE, tenantId, day) },
    );
    if (id) sent += 1;
  }
  return { tenants, sent };
}

export interface TenantReminderRun {
  readonly runDate: string;
  readonly companies: { companyId: string; queued: number }[];
}

/** Worker (lf_app): the daily reminder run for every company of one tenant, in its transaction. */
export async function runTenantReminders(
  db: Kysely<Database>,
  deps: { outbox: DocumentOutbox },
  tenantId: string,
  now: Date,
): Promise<TenantReminderRun> {
  return withTenant(db, tenantId, async (trx) => {
    // app.sod_settings is history; the latest row wins (0021). Not in the Kysely schema, so plain SQL.
    const { rows: zone } = await sql<{ report_timezone: string }>`
      SELECT report_timezone FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(
      trx,
    );
    const settings = zone[0];
    const runDate = localDate(now, settings?.report_timezone ?? DEFAULT_ZONE);
    const companies = await trx.selectFrom('app.company').select('id').orderBy('id').execute();
    const out: { companyId: string; queued: number }[] = [];
    for (const c of companies) {
      const r = await runOverdueReminders(trx, deps, { companyId: c.id, runDate });
      out.push({ companyId: c.id, queued: r.queued.length });
    }
    return { runDate, companies: out };
  });
}

/** Worker (lf_app): consume `ar.reminders.run`, one tenant per job. */
export async function startReminderWorker(opts: {
  boss: PgBoss;
  db: Kysely<Database>;
  outbox: DocumentOutbox;
  now?: () => Date;
}): Promise<string> {
  const now = opts.now ?? (() => new Date());
  return opts.boss.work(AR_REMINDERS_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { tenantId } = parseTenantJob(job.data);
      await runTenantReminders(opts.db, { outbox: opts.outbox }, tenantId, now());
    }
  });
}

/** Owner instance: consume `daily.fanout` (the schedule's job) by fanning out per tenant. */
export async function startFanOutWorker(owner: PgBoss, ownerUrl: string): Promise<string> {
  return owner.work(DAILY_FANOUT_QUEUE, { batchSize: 1 }, async () => {
    await fanOutDailyJobs(owner, ownerUrl, new Date());
  });
}
