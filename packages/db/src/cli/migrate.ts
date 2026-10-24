/**
 * Apply pending migrations: `DATABASE_URL=postgres://lf_migrator@host/db pnpm --filter @ledgerforce/db migrate`
 * Must connect as lf_migrator (refuses superusers and lf_app).
 */
import pg from 'pg';
import { migrate } from '../migrate.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required (connect as lf_migrator)');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query<{ u: string; su: boolean }>(
    'SELECT current_user AS u, rolsuper AS su FROM pg_roles WHERE rolname = current_user',
  );
  if (rows[0]?.u !== 'lf_migrator') {
    throw new Error(`Migrations must run as lf_migrator, not ${rows[0]?.u ?? '?'}`);
  }
  const r = await migrate(client, { log: (m) => console.log(m) });
  console.log(
    `applied ${String(r.applied.length)}, already applied ${String(r.alreadyApplied.length)}`,
  );
} finally {
  await client.end();
}
