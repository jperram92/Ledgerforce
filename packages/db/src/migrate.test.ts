import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMigrationPolicy,
  loadMigrations,
  MigrationPolicyError,
  MigrationSequenceError,
  DEFAULT_MIGRATIONS_DIR,
} from './migrate.ts';

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lf-mig-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

describe('checkMigrationPolicy (no-delete, forward-only — DL-0004)', () => {
  it.each([
    ['DROP TABLE', 'DROP TABLE app.company;'],
    ['DROP TABLE IF EXISTS', 'drop table if exists app.x;'],
    ['DROP COLUMN', 'ALTER TABLE app.company DROP COLUMN name;'],
    ['implicit DROP COLUMN', 'alter table app.company drop name;'],
    ['DROP COLUMN IF EXISTS', 'ALTER TABLE app.company DROP COLUMN IF EXISTS name;'],
    ['RENAME COLUMN', 'ALTER TABLE app.company RENAME COLUMN name TO legal_name;'],
    ['RENAME TABLE', 'ALTER TABLE app.company RENAME TO firm;'],
    ['RENAME schema', 'ALTER SCHEMA app RENAME TO app2;'],
    ['DROP SCHEMA', 'DROP SCHEMA app CASCADE;'],
    ['TRUNCATE', 'TRUNCATE app.company;'],
    ['DELETE FROM', 'DELETE FROM app.company WHERE true;'],
    ['inside a function body', "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DROP TABLE t $$;"],
  ])('rejects %s', (_label, sql) => {
    expect(() => checkMigrationPolicy(sql, '0009_bad.sql')).toThrow(MigrationPolicyError);
  });

  it.each([
    ['DROP CONSTRAINT', 'ALTER TABLE app.company DROP CONSTRAINT company_name_check;'],
    ['DROP DEFAULT', 'ALTER TABLE app.company ALTER COLUMN name DROP DEFAULT;'],
    ['DROP NOT NULL', 'ALTER TABLE app.company ALTER COLUMN name DROP NOT NULL;'],
    ['DROP POLICY', 'DROP POLICY IF EXISTS p ON app.company;'],
    ['DROP TRIGGER', 'DROP TRIGGER IF EXISTS t ON app.company;'],
    ['words in comments', '-- never DROP TABLE or RENAME anything\n/* DROP COLUMN */ SELECT 1;'],
    ['words in string literals', "COMMENT ON TABLE app.company IS 'do not DROP TABLE or RENAME';"],
    ['identifiers containing the words', 'CREATE TABLE app.renamed_items (dropped_at timestamptz);'],
  ])('allows %s', (_label, sql) => {
    expect(() => checkMigrationPolicy(sql, '0009_ok.sql')).not.toThrow();
  });
});

describe('loadMigrations', () => {
  it('loads NNNN_name.sql files in order with sha256 checksums', async () => {
    const dir = await dirWith({
      '0002_b.sql': 'SELECT 2;',
      '0001_a.sql': 'SELECT 1;',
      'README.md': 'ignored',
    });
    const ms = await loadMigrations(dir);
    expect(ms.map((m) => [m.version, m.name])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(ms[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects gaps in numbering', async () => {
    const dir = await dirWith({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 3;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationSequenceError);
  });

  it('rejects duplicate version numbers', async () => {
    const dir = await dirWith({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationSequenceError);
  });

  it('rejects badly named .sql files', async () => {
    const dir = await dirWith({ '0001_a.sql': 'SELECT 1;', '2_Bad Name.sql': 'SELECT 1;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationSequenceError);
  });

  it('applies the policy check while loading', async () => {
    const dir = await dirWith({ '0001_a.sql': 'DROP TABLE x;' });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationPolicyError);
  });

  it('the shipped migrations directory passes all checks', async () => {
    const ms = await loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(ms.length).toBeGreaterThanOrEqual(3);
  });
});
