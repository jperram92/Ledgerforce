/**
 * The worker process of the self-hosted install (`worker` service, T-0094): an lf_app pg-boss
 * instance consuming the outbox (ADR-0008). It never installs, supervises or schedules — those
 * run as lf_migrator (queue-admin.ts; supervision is an open question, ADR-0029).
 *
 * Health: every 10 s the worker runs `SELECT 1` through its pool and, on success, touches
 * LF_WORKER_HEARTBEAT_FILE (default /tmp/lf-worker-heartbeat); the compose healthcheck checks
 * that the file is fresh.
 */
import { writeFileSync } from 'node:fs';
import { createDb, databaseUrlFromEnv } from '@ledgerforce/db';
import { HandlerRegistry, runtimeBossOptions } from '@ledgerforce/outbox';
import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';
import { startOutboxWorker } from './outbox-worker.ts';
import { startSyncIssueWorker } from './sync-issue-worker.ts';

let url: string;
try {
  url = databaseUrlFromEnv(process.env, 'lf_app');
} catch (error) {
  console.error(`LedgerForce worker: ${(error as Error).message}`);
  process.exit(1);
}
const heartbeat = process.env['LF_WORKER_HEARTBEAT_FILE'] ?? '/tmp/lf-worker-heartbeat';

const db = createDb(url, 4);
const boss = new PgBoss(runtimeBossOptions(url));
boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));
await boss.start();
// No outbox handlers are registered yet: events are delivered to none and recorded as such.
await startOutboxWorker({ boss, db, registry: new HandlerRegistry() });
// Dead-lettered deliveries become Sync issues (design §5.6 rule 2, T-0071).
await startSyncIssueWorker({ boss, db });

async function beat(): Promise<void> {
  try {
    await sql`SELECT 1`.execute(db);
    writeFileSync(heartbeat, new Date().toISOString());
  } catch (error) {
    console.error(`worker health check failed: ${(error as Error).message}`);
  }
}
await beat();
const timer = setInterval(() => void beat(), 10_000);
console.log('LedgerForce worker started (outbox consumer, lf_app)');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void boss
      .stop({ graceful: true, timeout: 10_000 })
      .then(() => db.destroy())
      .then(() => process.exit(0));
  });
}
