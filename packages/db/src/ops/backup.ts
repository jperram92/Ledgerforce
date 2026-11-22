/**
 * createBackup — a snapshot-consistent, encrypted logical backup (T-0143, ADR-0101, RQ-0183
 * Findings 2-3). One session opens REPEATABLE READ, exports its snapshot, computes the manifest
 * (exact row count of every table, every company's chain entries and head) and stays open while
 * `pg_dump -Fc --snapshot=<id>` streams through the encryptor, so the manifest and the dump are
 * the same instant. It must connect as a role that bypasses RLS (the cluster superuser today;
 * lf_app and lf_migrator are NOBYPASSRLS and pg_dump refuses FORCEd tables it cannot read).
 */
import type { Kms } from '@ledgerforce/shared/crypto';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { writeEncryptedBackup, type BackupManifest } from './backup-format.ts';
import { findPgTool, pgConnArgs } from './pg-tools.ts';

type Env = Readonly<Record<string, string | undefined>>;

export async function computeManifest(client: pg.ClientBase): Promise<BackupManifest> {
  const version = await client.query<{ v: string }>('SHOW server_version');
  const tables = await client.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1`,
  );
  const counts: Record<string, string> = {};
  for (const { name } of tables.rows) {
    // `name` comes from format('%I.%I') above, so it is a safely quoted identifier.
    const r = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${name}`);
    counts[name.replace(/"/g, '')] = r.rows[0]?.n ?? '0';
  }
  const chains = await client.query<{
    tenant_id: string;
    company_id: string;
    entries: string;
    head_seq: string;
    head_hash: string | null;
  }>(
    `SELECT c.tenant_id::text, c.id::text AS company_id,
            (SELECT count(*) FROM app.journal_entry e
              WHERE e.company_id = c.id AND e.status IN ('posted', 'reversed'))::text AS entries,
            coalesce(h.last_seq, 0)::text AS head_seq, h.last_hash AS head_hash
       FROM app.company c LEFT JOIN app.journal_chain_head h ON h.company_id = c.id
      ORDER BY c.tenant_id, c.id`,
  );
  return {
    version: 1,
    serverVersion: version.rows[0]?.v ?? '',
    tables: counts,
    chains: chains.rows.map((r) => ({
      tenantId: r.tenant_id,
      companyId: r.company_id,
      entries: r.entries,
      headSeq: r.head_seq,
      headHash: r.head_hash,
    })),
  };
}

/** The manifest of a live database (the restore drill reads the restored copy this way). */
export async function readManifest(url: string): Promise<BackupManifest> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const m = await computeManifest(client);
    await client.query('COMMIT');
    return m;
  } finally {
    await client.end();
  }
}

export async function createBackup(opts: {
  /** Superuser (or BYPASSRLS) URL of the database to back up. */
  url: string;
  out: string;
  kms: Kms;
  env?: Env;
}): Promise<{ backupId: string; manifest: BackupManifest }> {
  const env = opts.env ?? process.env;
  const client = new pg.Client({ connectionString: opts.url });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s');
    const snapshot = snap.rows[0]?.s ?? '';
    const manifest = await computeManifest(client);

    const { args, env: connEnv } = pgConnArgs(opts.url);
    const child = spawn(
      findPgTool('pg_dump', env),
      ['--format=custom', `--snapshot=${snapshot}`, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: env['PATH'] ?? '/usr/bin:/bin', ...connEnv },
      },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    let written: { backupId: string } | undefined;
    let writeError: unknown;
    try {
      written = await writeEncryptedBackup({
        kms: opts.kms,
        manifest,
        source: child.stdout,
        out: opts.out,
      });
    } catch (e) {
      writeError = e;
      child.kill();
    }
    const code = await exited;
    if (code !== 0) {
      // The encryptor finishes the file whenever pg_dump's stdout ends; a failed pg_dump is
      // still a failed backup, so its file is removed.
      if (written !== undefined) await rm(opts.out, { force: true });
      throw new Error(`pg_dump failed (exit ${String(code)}): ${stderr.trim()}`);
    }
    if (writeError !== undefined || written === undefined) throw writeError;
    await client.query('COMMIT');
    return { backupId: written.backupId, manifest };
  } finally {
    await client.end();
  }
}
