/**
 * Test harness for outbox db tests (test-only). On a migrated test database:
 *  - `owner`: a pg-boss instance as lf_migrator that installed pg-boss and the outbox queues and
 *    holds a pg-boss TestClock (attaching it replaces pgboss.job_now(), which is DDL);
 *  - `app`: Kysely as lf_app whose sessions read that fake clock (`-c pgboss.test_clock=on`), so
 *    jobs sent inside posting transactions are stamped with the same time the workers poll with;
 *  - `startRuntime()`: a new lf_app runtime instance on the same clock (a "worker process").
 * Time only moves through `clock.tick()`; nothing sleeps (apps/worker AGENTS.md, RQ-0033).
 */
import { createDb, type Database } from '@ledgerforce/db';
import type { TestDatabase } from '@ledgerforce/db/testing';
import type { Kysely } from 'kysely';
import { PgBoss, TestClock, type Clock } from 'pg-boss';
import { installOutboxQueues } from '../install.ts';
import { ownerBossOptions, runtimeBossOptions } from '../queue.ts';

const CLOCK_OPTION = '-c pgboss.test_clock=on';

export interface OutboxHarness {
  clock: TestClock;
  owner: PgBoss;
  app: Kysely<Database>;
  startRuntime(): Promise<PgBoss>;
  /** Errors pg-boss emitted on any instance (a test asserts this stays empty). */
  errors: string[];
  close(): Promise<void>;
}

/** The TestClock's time and timers without `attach`: lf_app may not replace pgboss.job_now(). */
const view = (c: TestClock): Clock => ({
  now: () => c.now(),
  setTimeout: (fn, ms) => c.setTimeout(fn, ms),
  clearTimeout: (h) => c.clearTimeout(h),
  setInterval: (fn, ms) => c.setInterval(fn, ms),
  clearInterval: (h) => c.clearInterval(h),
});

export async function createOutboxHarness(
  tdb: TestDatabase,
  start: Date = new Date('2026-10-25T09:00:00Z'),
): Promise<OutboxHarness> {
  const clock = new TestClock(start);
  const errors: string[] = [];
  const watch = (b: PgBoss, who: string) =>
    b.on('error', (e: unknown) => errors.push(`${who}: ${String(e)}`));

  const owner = new PgBoss(ownerBossOptions(tdb.url('lf_migrator'), { clock }));
  watch(owner, 'owner');
  await owner.start();
  await installOutboxQueues(owner);

  const url = new URL(tdb.url('lf_app'));
  url.searchParams.set('options', CLOCK_OPTION);
  const app = createDb(url.toString(), 4);

  const runtimes: PgBoss[] = [];
  return {
    clock,
    owner,
    app,
    errors,
    async startRuntime() {
      const b = new PgBoss(
        runtimeBossOptions(tdb.url('lf_app'), { clock: view(clock), options: CLOCK_OPTION }),
      );
      watch(b, `runtime${String(runtimes.length + 1)}`);
      runtimes.push(b);
      return b.start();
    },
    async close() {
      for (const b of runtimes) await b.stop({ graceful: false });
      await owner.stop({ graceful: false });
      await app.destroy();
    },
  };
}
