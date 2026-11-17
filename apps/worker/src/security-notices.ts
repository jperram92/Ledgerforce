/**
 * Security notice delivery jobs (T-0197, ADR-0092, RQ-0174), following the daily fan-out of
 * ADR-0062.
 *
 * The notices are written by database functions and triggers in the approving transaction
 * (migrations 0025 and 0072). SQL cannot create a pg-boss job, so delivery polls.
 *
 * Owner side, as lf_migrator, in the scheduler:
 * - `installSecurityNoticeSchedule` stores the every-minute schedule (UTC) and creates the queues.
 * - `fanOutSecurityNotices` sends one `security.notices.dispatch` job per active tenant and UTC
 *   minute. The job id is derived from queue, tenant and minute, so a second fan-out in the same
 *   minute adds nothing.
 *
 * Application side, as lf_app, in the worker:
 * - `runSecurityNoticeJob` dispatches that tenant's due notices (`dispatchSecurityNotices`, under
 *   RLS). Without an SMTP sender it does nothing, so the notices stay `pending`; the worker logs
 *   the gap at start.
 *
 * The queues have no pg-boss retries: the next minute's job is the retry, and backoff per notice
 * is recorded in app.security_notice_delivery.
 */
import { dispatchSecurityNotices, type EmailSender } from '@ledgerforce/email';
import type { Database } from '@ledgerforce/db';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { activeTenantIds, jobId, parseTenantJob } from './daily-jobs.ts';

export const SECURITY_NOTICES_FANOUT_QUEUE = 'security.notices.fanout';
export const SECURITY_NOTICES_QUEUE = 'security.notices.dispatch';
export const SECURITY_NOTICES_CRON = '* * * * *';

/** Owner instance only (lf_migrator): the queues of security notice delivery. Idempotent. */
export async function installSecurityNoticeQueues(owner: PgBoss): Promise<void> {
  for (const name of [SECURITY_NOTICES_FANOUT_QUEUE, SECURITY_NOTICES_QUEUE]) {
    if (!(await owner.getQueue(name))) await owner.createQueue(name, { retryLimit: 0 });
  }
}

/** Owner instance only: the queues and the every-minute schedule. Idempotent. */
export async function installSecurityNoticeSchedule(owner: PgBoss): Promise<void> {
  await installSecurityNoticeQueues(owner);
  await owner.schedule(SECURITY_NOTICES_FANOUT_QUEUE, SECURITY_NOTICES_CRON, {}, { tz: 'UTC' });
}

/** Owner instance only: one dispatch job per active tenant for the UTC minute of `now`. */
export async function fanOutSecurityNotices(
  owner: PgBoss,
  ownerUrl: string,
  now: Date,
): Promise<{ tenants: string[]; sent: number }> {
  const tenants = await activeTenantIds(ownerUrl);
  const minute = now.toISOString().slice(0, 16);
  let sent = 0;
  for (const tenantId of tenants) {
    const id = await owner.send(
      SECURITY_NOTICES_QUEUE,
      { tenantId },
      { id: jobId(SECURITY_NOTICES_QUEUE, tenantId, minute) },
    );
    if (id) sent += 1;
  }
  return { tenants, sent };
}

/** Worker (lf_app): one dispatch job. Returns what was sent, or null without a sender. */
export async function runSecurityNoticeJob(
  db: Kysely<Database>,
  sender: EmailSender | null,
  data: unknown,
  now: Date,
): Promise<{ sent: number; failed: number } | null> {
  const { tenantId } = parseTenantJob(data);
  if (!sender) return null;
  return dispatchSecurityNotices(db, tenantId, { sender, now });
}

/** Worker (lf_app): consume `security.notices.dispatch`, one tenant per job. */
export async function startSecurityNoticeWorker(opts: {
  boss: PgBoss;
  db: Kysely<Database>;
  sender: EmailSender | null;
  now?: () => Date;
}): Promise<string> {
  const now = opts.now ?? (() => new Date());
  return opts.boss.work(SECURITY_NOTICES_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await runSecurityNoticeJob(opts.db, opts.sender, job.data, now());
  });
}

/** Owner instance: consume `security.notices.fanout` (the schedule's job) by fanning out. */
export async function startSecurityNoticeFanOutWorker(
  owner: PgBoss,
  ownerUrl: string,
): Promise<string> {
  return owner.work(SECURITY_NOTICES_FANOUT_QUEUE, { batchSize: 1 }, async () => {
    await fanOutSecurityNotices(owner, ownerUrl, new Date());
  });
}
