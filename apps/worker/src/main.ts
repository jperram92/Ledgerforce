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
import { reminderEmailHandler, SmtpSender } from '@ledgerforce/email';
import { enqueue, HandlerRegistry, runtimeBossOptions } from '@ledgerforce/outbox';
import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';
import { startReminderWorker } from './daily-jobs.ts';
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
const registry = new HandlerRegistry();
// Overdue-reminder emails (T-0068, T-0147) need SMTP. Without LF_SMTP_URL / LF_SMTP_FROM the event is
// delivered to no handler and recorded as such, and the gap is logged at start.
if (process.env['LF_SMTP_URL'] && process.env['LF_SMTP_FROM']) {
  registry.register(reminderEmailHandler({ sender: SmtpSender.fromEnv(process.env) }));
} else {
  console.warn('LF_SMTP_URL / LF_SMTP_FROM not set: overdue-reminder emails are not sent');
}
await startOutboxWorker({ boss, db, registry });
// The daily overdue-reminder run, one job per tenant fanned out by the scheduler (ADR-0062).
await startReminderWorker({
  boss,
  db,
  outbox: {
    publish: async (trx, e) => {
      await enqueue(trx, boss, {
        companyId: e.companyId,
        topic: e.topic,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload,
      });
    },
  },
});
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
