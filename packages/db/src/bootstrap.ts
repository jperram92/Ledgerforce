/**
 * Cluster/database bootstrap (the one superuser step before migrations). The SQL lives in
 * packages/db/bootstrap/*.sql so the compose init script and the test harness share it.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const BOOTSTRAP_DIR = fileURLToPath(new URL('../bootstrap/', import.meta.url));

export async function bootstrapCluster(
  superuser: pg.ClientBase | pg.Pool,
  passwords: { migrator?: string; app?: string } = {},
): Promise<void> {
  await superuser.query(await readFile(`${BOOTSTRAP_DIR}01_cluster_roles.sql`, 'utf8'));
  const escape = (s: string) => `'${s.replace(/'/g, "''")}'`;
  if (passwords.migrator !== undefined) {
    await superuser.query(`ALTER ROLE lf_migrator PASSWORD ${escape(passwords.migrator)}`);
  }
  if (passwords.app !== undefined) {
    await superuser.query(`ALTER ROLE lf_app PASSWORD ${escape(passwords.app)}`);
  }
}

/** Run while connected (as superuser) to the database being prepared. */
export async function bootstrapDatabase(superuser: pg.ClientBase | pg.Pool): Promise<void> {
  await superuser.query(await readFile(`${BOOTSTRAP_DIR}02_database_grants.sql`, 'utf8'));
}
