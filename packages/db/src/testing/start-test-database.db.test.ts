import { existsSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { startTestDatabase } from './start-test-database.ts';

describe('startTestDatabase()', () => {
  it('starts a real PostgreSQL >= 16 and tears it down completely', async () => {
    const server = await startTestDatabase();
    const client = new pg.Client({ connectionString: server.connectionString('postgres') });
    await client.connect();
    const { rows } = await client.query<{ v: string; su: boolean }>(
      "SELECT current_setting('server_version_num') AS v, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su",
    );
    await client.end();
    expect(Number.parseInt(rows[0]?.v ?? '0', 10)).toBeGreaterThanOrEqual(160000);
    expect(rows[0]?.su).toBe(true);

    await server.stop();
    if (server.mode === 'local') {
      expect(existsSync(server.dataDir ?? '/nonexistent-sentinel')).toBe(false);
      const probe = new pg.Client({
        connectionString: server.connectionString('postgres'),
        connectionTimeoutMillis: 2000,
      });
      await expect(probe.connect()).rejects.toThrow();
    }
  });
});
