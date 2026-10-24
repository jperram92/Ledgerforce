/**
 * Per-test-file databases inside the shared test server (see global-setup.ts).
 *
 *   const tdb = await createTestDatabase({ migrate: true });
 *   tdb.admin   — pg.Pool as the superuser on this database (seeding / verification, bypasses RLS)
 *   tdb.app     — Kysely<Database> as lf_app (the application role: RLS applies)
 *   tdb.url(r)  — connection string for 'lf_app' | 'lf_migrator' | 'superuser'
 *   await tdb.close();
 */
import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { inject } from 'vitest';
import { bootstrapDatabase } from '../bootstrap.ts';
import { migrate } from '../migrate.ts';
import type { Database } from '../schema.ts';
import { createDb } from '../tenant.ts';

export type TestRole = 'lf_app' | 'lf_migrator' | 'superuser';

export interface TestDatabase {
  name: string;
  admin: pg.Pool;
  app: Kysely<Database>;
  url(role: TestRole): string;
  close(): Promise<void>;
}

function connString(database: string, role: TestRole): string {
  const info = inject('lfTestDb');
  const user = role === 'superuser' ? info.superuser : role;
  const password = role === 'superuser' ? info.superuserPassword : info.rolePassword;
  const auth =
    password === null ? encodeURIComponent(user) : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${info.host}:${String(info.port)}/${database}`;
}

export async function createTestDatabase(opts: { migrate: boolean; migrationsDir?: string }): Promise<TestDatabase> {
  const name = `lf_test_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: connString('postgres', 'superuser') });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }

  const admin = new pg.Pool({ connectionString: connString(name, 'superuser'), max: 4 });
  await bootstrapDatabase(admin);

  if (opts.migrate) {
    const m = new pg.Client({ connectionString: connString(name, 'lf_migrator') });
    await m.connect();
    try {
      await migrate(m, opts.migrationsDir === undefined ? {} : { dir: opts.migrationsDir });
    } finally {
      await m.end();
    }
  }

  const app = createDb(connString(name, 'lf_app'), 4);
  return {
    name,
    admin,
    app,
    url: (role) => connString(name, role),
    close: async () => {
      await app.destroy();
      await admin.end();
    },
  };
}
