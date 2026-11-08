import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MigrationChecksumError, MigrationMissingError } from './migrate.ts';
import { createTestDatabase, type TestDatabase } from './testing/test-db.ts';

let dir: string;
let tdb: TestDatabase;
let client: pg.Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lf-mig-'));
  tdb = await createTestDatabase({ migrate: false });
  client = new pg.Client({ connectionString: tdb.url('lf_migrator') });
  await client.connect();
});

afterAll(async () => {
  await client.end().catch(() => undefined);
  await tdb.close();
});

const write = (name: string, sql: string) => writeFile(join(dir, name), sql);

describe('migrate()', () => {
  it('applies pending migrations in order and records version, checksum and role', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await write('0002_b.sql', 'ALTER TABLE public.t1 ADD COLUMN note text;');
    const r = await migrate(client, { dir });
    expect(r.applied).toEqual(['0001_a.sql', '0002_b.sql']);
    const { rows } = await client.query(
      'SELECT version, name, checksum, applied_by FROM public.schema_migrations ORDER BY version',
    );
    expect(rows.map((x) => [x.version, x.name, x.applied_by])).toEqual([
      [1, 'a', 'lf_migrator'],
      [2, 'b', 'lf_migrator'],
    ]);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent: a second run applies nothing', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await migrate(client, { dir });
    const again = await migrate(client, { dir });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['0001_a.sql']);
  });

  it('applies only the new migration when one is added', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await migrate(client, { dir });
    await write('0002_b.sql', 'CREATE TABLE public.t2 (id int);');
    expect((await migrate(client, { dir })).applied).toEqual(['0002_b.sql']);
  });

  it('refuses to run when an applied migration was edited (checksum changed)', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await migrate(client, { dir });
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id bigint);');
    await write('0002_b.sql', 'CREATE TABLE public.t2 (id int);');
    await expect(migrate(client, { dir })).rejects.toThrow(MigrationChecksumError);
    const { rows } = await client.query("SELECT to_regclass('public.t2') AS t2");
    expect(rows[0].t2).toBeNull(); // nothing after the tampered file ran
  });

  it('refuses to run when an applied migration file has disappeared', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await migrate(client, { dir });
    const other = await mkdtemp(join(tmpdir(), 'lf-mig-'));
    await expect(migrate(client, { dir: other })).rejects.toThrow(MigrationMissingError);
  });

  it('rolls back a failing migration completely and does not record it', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await write('0002_b.sql', 'CREATE TABLE public.t2 (id int); SELECT 1/0;');
    await expect(migrate(client, { dir })).rejects.toThrow(/division by zero/);
    const { rows } = await client.query(
      "SELECT to_regclass('public.t1') AS t1, to_regclass('public.t2') AS t2",
    );
    expect(rows[0]).toEqual({ t1: 't1', t2: null });
    const versions = await client.query('SELECT version FROM public.schema_migrations');
    expect(versions.rows.map((x) => x.version)).toEqual([1]);
  });

  it('refuses policy-violating migrations before touching the database', async () => {
    await write('0001_a.sql', 'CREATE TABLE public.t1 (id int);');
    await write('0002_b.sql', 'ALTER TABLE public.t1 RENAME TO t9;');
    await expect(migrate(client, { dir })).rejects.toThrow(/RENAME/);
    const { rows } = await client.query("SELECT to_regclass('public.t1') AS t1");
    expect(rows[0].t1).toBeNull();
  });
});
