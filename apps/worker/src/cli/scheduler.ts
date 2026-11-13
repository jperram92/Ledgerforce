/**
 * The owner-role scheduler (compose service `scheduler`; ADR-0062 option 1, T-0147). It connects as
 * lf_migrator (startMaintenance refuses any other role) and does three things:
 * - pg-boss supervision;
 * - the cron timekeeper for the daily schedule (installed idempotently on start);
 * - the `daily.fanout` consumer, which sends one `ar.reminders.run` job per active tenant.
 * Tenant data is never read here; the worker does that per tenant, as lf_app.
 *
 * Health: every 10 s it runs `SELECT 1` and touches LF_SCHEDULER_HEARTBEAT_FILE
 * (default /tmp/lf-scheduler-heartbeat).
 */
import { writeFileSync } from 'node:fs';
import { databaseUrlFromEnv } from '@ledgerforce/db';
import pg from 'pg';
import { installDailySchedules, startFanOutWorker } from '../daily-jobs.ts';
import { startMaintenance } from '../queue-admin.ts';

let url: string;
try {
  url = databaseUrlFromEnv(process.env, 'lf_migrator');
} catch (error) {
  console.error(`LedgerForce scheduler: ${(error as Error).message}`);
  process.exit(1);
}
const heartbeat = process.env['LF_SCHEDULER_HEARTBEAT_FILE'] ?? '/tmp/lf-scheduler-heartbeat';

const owner = await startMaintenance(url, { schedule: true });
owner.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));
await installDailySchedules(owner);
await startFanOutWorker(owner, url);

const pool = new pg.Pool({ connectionString: url, max: 1 });
async function beat(): Promise<void> {
  try {
    await pool.query('SELECT 1');
    writeFileSync(heartbeat, new Date().toISOString());
  } catch (error) {
    console.error(`scheduler health check failed: ${(error as Error).message}`);
  }
}
await beat();
const timer = setInterval(() => void beat(), 10_000);
console.log('LedgerForce scheduler started (daily fan-out, lf_migrator)');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void owner
      .stop({ graceful: true, timeout: 10_000 })
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
