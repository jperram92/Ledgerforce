/**
 * Vitest globalSetup for the `db` project: one throw-away PostgreSQL server per run
 * (startTestDatabase — Testcontainers, local initdb cluster, or LF_TEST_DATABASE_URL), with the
 * cluster bootstrap (roles) applied once. Test files get the connection info via
 * `inject('lfTestDb')` and create their own databases (see test-db.ts).
 */
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { bootstrapCluster } from '../bootstrap.ts';
import { startTestDatabase } from './start-test-database.ts';

export interface LfTestDbInfo {
  mode: string;
  host: string;
  port: number;
  superuser: string;
  superuserPassword: string | null;
  rolePassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    lfTestDb: LfTestDbInfo;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startTestDatabase();
  const rolePassword = process.env['LF_TEST_ROLE_PASSWORD'] ?? 'lf_test_only_password';
  const admin = new pg.Client({ connectionString: server.connectionString('postgres') });
  await admin.connect();
  try {
    await bootstrapCluster(admin, { migrator: rolePassword, app: rolePassword });
  } finally {
    await admin.end();
  }
  console.log(
    `[db] test PostgreSQL ready (${server.mode}) on ${server.host}:${String(server.port)}`,
  );
  project.provide('lfTestDb', {
    mode: server.mode,
    host: server.host,
    port: server.port,
    superuser: server.superuser,
    superuserPassword: server.superuserPassword ?? null,
    rolePassword,
  });
  return async () => {
    await server.stop();
  };
}
