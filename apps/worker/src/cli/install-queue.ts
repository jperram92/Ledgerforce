/**
 * Install or upgrade pg-boss and the outbox queues, after the SQL migrations:
 * `DATABASE_URL=postgres://lf_migrator@host/db pnpm --filter @ledgerforce/worker install-queue`
 * Must connect as lf_migrator (refuses any other role).
 */
import { installQueue } from '../queue-admin.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required (connect as lf_migrator)');
  process.exit(2);
}
await installQueue(url);
console.log('pg-boss and the outbox queues are installed');
