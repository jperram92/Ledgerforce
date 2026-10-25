/**
 * pg-boss configuration for the outbox (ADR-0008, RQ-0033, DL-0153).
 *
 *  - Schema `pgboss` is created by migration 0024, owned by lf_migrator. pg-boss's own tables are
 *    installed into it by `installOutboxQueues` on an *owner* instance (lf_migrator), right after
 *    the SQL migrations: its construction SQL contains DROP statements our runner rejects, so it
 *    cannot be a plain migration.
 *  - The application (lf_app) uses *runtime* instances: no install, no supervision, no cron,
 *    no instance registry. lf_app holds SELECT/INSERT/UPDATE on the pgboss tables only.
 *  - Supervision (expiring jobs of crashed workers, retention, stats partitions, reindex) is DDL,
 *    so it runs on an owner instance.
 */
import type { ConstructorOptions, Queue } from 'pg-boss';

export const PGBOSS_SCHEMA = 'pgboss';
/** One delivery job per outbox event; the job id is the event id. */
export const OUTBOX_QUEUE = 'outbox.deliver';
/** Exhausted deliveries land here; the Sync issues inbox reads it (design §5.6, follow-up). */
export const OUTBOX_DEAD_LETTER_QUEUE = 'outbox.deliver.dead';

/** Retries back off exponentially from 1 minute, capped at 6 hours (apps/worker AGENTS.md). */
export const OUTBOX_QUEUE_OPTIONS = Object.freeze({
  retryLimit: 10,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 6 * 60 * 60,
  // A worker that dies holding a job loses it for at most this long (then supervise retries it).
  expireInSeconds: 5 * 60,
  deadLetter: OUTBOX_DEAD_LETTER_QUEUE,
} satisfies Omit<Queue, 'name'>);

type Extra = Omit<ConstructorOptions, 'connectionString' | 'schema'>;

/** An lf_app instance: send, fetch, work, complete. Never installs, supervises or schedules. */
export function runtimeBossOptions(
  connectionString: string,
  extra: Extra = {},
): ConstructorOptions {
  return {
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    registerInstance: false,
    ...extra,
  };
}

/** An lf_migrator instance: installs/upgrades pg-boss's tables and runs maintenance. */
export function ownerBossOptions(connectionString: string, extra: Extra = {}): ConstructorOptions {
  return {
    connectionString,
    schema: PGBOSS_SCHEMA,
    migrate: true,
    createSchema: false,
    supervise: false,
    schedule: false,
    ...extra,
  };
}
