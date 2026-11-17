/**
 * Bills inbox IMAP polling schedule (T-0127, ADR-0095 rule 6, DL-0814; ADR-0062 pattern).
 *
 * Owner side, as lf_migrator, in the scheduler:
 * - `installInboxPollSchedule` stores the 5-minute pg-boss schedule (UTC) and creates the queues.
 * - `fanOutInboxPolls` sends one `ap.inbox.poll` job per active tenant and 5-minute slot; the job
 *   id is derived from queue, tenant and slot, so a second fan-out in the same slot adds nothing.
 *
 * Application side, as lf_app, in the worker:
 * - `runTenantInboxPoll` polls every active bills mailbox of one tenant (RLS applies); mail-server
 *   failures are recorded on the mailbox row and do not fail the job (the next slot retries).
 */
import { pollTenantMailboxes, type PollDeps, type PollResult } from '@ledgerforce/ap';
import type { Database } from '@ledgerforce/db';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { activeTenantIds, jobId, parseTenantJob } from './daily-jobs.ts';

export const INBOX_FANOUT_QUEUE = 'ap.inbox.fanout';
export const INBOX_POLL_QUEUE = 'ap.inbox.poll';
export const INBOX_FANOUT_CRON = '*/5 * * * *';
const SLOT_MS = 5 * 60_000;

/** Owner instance only (lf_migrator): the 5-minute schedule and its queues. Idempotent. */
export async function installInboxPollSchedule(owner: PgBoss): Promise<void> {
  for (const name of [INBOX_FANOUT_QUEUE, INBOX_POLL_QUEUE]) {
    if (!(await owner.getQueue(name))) {
      // No retries: a failed poll is repeated by the next slot anyway.
      await owner.createQueue(name, { retryLimit: 0 });
    }
  }
  await owner.schedule(INBOX_FANOUT_QUEUE, INBOX_FANOUT_CRON, {}, { tz: 'UTC' });
}

/** Owner instance only: one `ap.inbox.poll` job per active tenant for the 5-minute slot of `now`. */
export async function fanOutInboxPolls(
  owner: PgBoss,
  ownerUrl: string,
  now: Date,
): Promise<{ tenants: string[]; sent: number }> {
  const tenants = await activeTenantIds(ownerUrl);
  const slot = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS).toISOString();
  let sent = 0;
  for (const tenantId of tenants) {
    const id = await owner.send(
      INBOX_POLL_QUEUE,
      { tenantId },
      { id: jobId(INBOX_POLL_QUEUE, tenantId, slot) },
    );
    if (id) sent += 1;
  }
  return { tenants, sent };
}

/** Worker (lf_app): poll every active bills mailbox of one tenant. */
export function runTenantInboxPoll(
  db: Kysely<Database>,
  deps: PollDeps,
  tenantId: string,
): Promise<PollResult[]> {
  return pollTenantMailboxes(db, deps, tenantId);
}

/** Worker (lf_app): consume `ap.inbox.poll`, one tenant per job. */
export async function startInboxPollWorker(opts: {
  boss: PgBoss;
  db: Kysely<Database>;
  deps: PollDeps;
}): Promise<string> {
  return opts.boss.work(INBOX_POLL_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const { tenantId } = parseTenantJob(job.data);
      const results = await runTenantInboxPoll(opts.db, opts.deps, tenantId);
      for (const r of results) {
        if (r.status === 'failed') {
          console.warn(`bills mailbox ${r.mailboxId}: poll failed (${r.error ?? 'unknown'})`);
        }
      }
    }
  });
}

/** Owner instance: consume `ap.inbox.fanout` (the schedule's job) by fanning out per tenant. */
export async function startInboxFanOutWorker(owner: PgBoss, ownerUrl: string): Promise<string> {
  return owner.work(INBOX_FANOUT_QUEUE, { batchSize: 1 }, async () => {
    await fanOutInboxPolls(owner, ownerUrl, new Date());
  });
}
