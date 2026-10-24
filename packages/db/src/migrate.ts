/**
 * Forward-only SQL migration runner.
 *
 *  - Files: packages/db/migrations/NNNN_snake_name.sql, numbered 0001.. without gaps/duplicates.
 *  - Ledger: public.schema_migrations(version, name, checksum sha256, applied_at, applied_by).
 *  - Refuses to run if an applied migration's file changed (checksum) or disappeared.
 *  - Refuses destructive or security-weakening statements (no-delete policy DL-0004, migration
 *    skill): any DROP (incl. `ALTER TABLE t DROP c`; DROP DEFAULT / DROP NOT NULL allowed),
 *    RENAME, TRUNCATE, DELETE FROM, ALTER COLUMN TYPE, DISABLE TRIGGER/RLS, NO FORCE RLS, BYPASSRLS.
 *    Comments and string literals are ignored; function bodies ($$...$$) ARE checked.
 *  - Each migration runs in its own transaction together with its ledger row; a concurrent
 *    runner waits on an advisory lock.
 *  - Run as lf_migrator (never as the application role).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FILE_RE = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const LOCK_KEY = 7_340_019_221; // arbitrary constant for pg_advisory_lock

export class MigrationPolicyError extends Error {
  override name = 'MigrationPolicyError';
}
export class MigrationSequenceError extends Error {
  override name = 'MigrationSequenceError';
}
export class MigrationChecksumError extends Error {
  override name = 'MigrationChecksumError';
}
export class MigrationMissingError extends Error {
  override name = 'MigrationMissingError';
}

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

/** Remove comments and single-quoted literals; keep dollar-quoted bodies (they are code). */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

const DROP_KINDS = new Set([
  'table',
  'schema',
  'database',
  'column',
  'constraint',
  'index',
  'trigger',
  'policy',
  'function',
  'procedure',
  'view',
  'materialized',
  'sequence',
  'type',
  'domain',
  'role',
  'user',
  'extension',
  'rule',
  'owned',
  'aggregate',
  'operator',
  'publication',
  'subscription',
  'identity',
  'expression',
]);

/**
 * Forbidden in any migration (keep in step with .claude/skills/migration/SKILL.md):
 * DROP of anything (except ALTER COLUMN ... DROP DEFAULT / DROP NOT NULL), RENAME, TRUNCATE,
 * DELETE FROM, ALTER COLUMN ... TYPE (possibly data-losing: add a new column instead),
 * DISABLE TRIGGER/RULE/ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY, BYPASSRLS.
 */
const RULES: { label: (m: RegExpExecArray) => string; re: RegExp }[] = [
  {
    re: /\bdrop\s+(?!default\b|not\s+null\b)(\w+)/i,
    label: (m) => {
      const kind = (m[1] ?? '').toLowerCase();
      return DROP_KINDS.has(kind) ? `DROP ${kind.toUpperCase()}` : 'DROP COLUMN';
    },
  },
  { re: /\brename\b/i, label: () => 'RENAME' },
  // `TRUNCATE ON` is a trigger event / privilege name (e.g. BEFORE TRUNCATE ON t), not a TRUNCATE.
  { re: /\btruncate\b(?!\s+on\b)/i, label: () => 'TRUNCATE' },
  { re: /\bdelete\s+from\b/i, label: () => 'DELETE FROM' },
  {
    re: /\balter\s+column\s+(?:"[^"]+"|\w+)\s+(?:set\s+data\s+)?type\b/i,
    label: () => 'ALTER COLUMN ... TYPE',
  },
  {
    re: /\bdisable\s+(trigger|rule|row\s+level\s+security)\b/i,
    label: (m) => `DISABLE ${(m[1] ?? '').toUpperCase()}`,
  },
  { re: /\bno\s+force\s+row\s+level\s+security\b/i, label: () => 'NO FORCE ROW LEVEL SECURITY' },
  { re: /\bbypassrls\b/i, label: () => 'BYPASSRLS' },
];

export function checkMigrationPolicy(sql: string, filename: string): void {
  const code = stripCommentsAndStrings(sql);
  for (const rule of RULES) {
    const m = rule.re.exec(code);
    if (m) {
      throw new MigrationPolicyError(
        `${filename}: ${rule.label(m)} is not allowed — migrations are forward-only and additive ` +
          '(AGENTS.md directive 6, DL-0004). Add a new column/table, backfill, and deprecate the old one.',
      );
    }
  }
}

export const checksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

export async function loadMigrations(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const filename of names) {
    const m = FILE_RE.exec(filename);
    if (!m) {
      throw new MigrationSequenceError(
        `${filename}: migration files must be named NNNN_snake_case.sql`,
      );
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    checkMigrationPolicy(sql, filename);
    files.push({
      version: Number.parseInt(m[1] ?? '', 10),
      name: m[2] ?? '',
      filename,
      sql,
      checksum: checksum(sql),
    });
  }
  files.forEach((f, idx) => {
    if (f.version !== idx + 1) {
      throw new MigrationSequenceError(
        `${f.filename}: expected version ${String(idx + 1).padStart(4, '0')} (no gaps or duplicates)`,
      );
    }
  });
  return files;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(
  client: pg.ClientBase,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const files = await loadMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR);
  const log = opts.log ?? (() => undefined);

  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version    integer     PRIMARY KEY,
        name       text        NOT NULL,
        checksum   char(64)    NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text        NOT NULL DEFAULT current_user
      )`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
    );
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const alreadyApplied: string[] = [];
    for (const row of rows) {
      const file = byVersion.get(row.version);
      if (!file) {
        throw new MigrationMissingError(
          `Applied migration ${String(row.version).padStart(4, '0')}_${row.name} is missing from ${opts.dir ?? DEFAULT_MIGRATIONS_DIR}`,
        );
      }
      if (file.checksum !== row.checksum.trim()) {
        throw new MigrationChecksumError(
          `${file.filename} was modified after it was applied (checksum mismatch). Migrations are ` +
            'immutable once applied — write a new migration instead.',
        );
      }
      alreadyApplied.push(file.filename);
    }

    const appliedVersions = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const f of files) {
      if (appliedVersions.has(f.version)) continue;
      log(`applying ${f.filename}`);
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [f.version, f.name, f.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(f.filename);
    }
    return { applied, alreadyApplied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}
