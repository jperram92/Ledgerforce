/**
 * PostgreSQL client tools for backup and restore (T-0143, RQ-0183 Finding 8). pg_dump refuses a
 * server newer than its own major version, so the newest installed version is preferred:
 * LF_PG_BINDIR, else the newest /usr/lib/postgresql/<v>/bin that has the tool, else PATH.
 * Connections are passed as discrete options with the password in PGPASSWORD, never on the
 * command line (visible in `ps`).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

export function findPgTool(
  tool: 'pg_dump' | 'pg_restore',
  env: Env = process.env,
  roots: readonly string[] = ['/usr/lib/postgresql', '/usr/local/lib/postgresql'],
): string {
  const explicit = env['LF_PG_BINDIR'];
  if (explicit) {
    const p = join(explicit, tool);
    if (!existsSync(p)) throw new Error(`LF_PG_BINDIR has no ${tool}`);
    return p;
  }
  const found: { v: number; path: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root)) {
      const p = join(root, v, 'bin', tool);
      const major = Number.parseInt(v, 10);
      if (Number.isFinite(major) && existsSync(p)) found.push({ v: major, path: p });
    }
  }
  found.sort((a, b) => b.v - a.v);
  return found[0]?.path ?? tool;
}

/** libpq options and environment for a postgres:// URL. */
export function pgConnArgs(url: string): { args: string[]; env: Record<string, string> } {
  const u = new URL(url);
  const args = [
    `--host=${decodeURIComponent(u.hostname)}`,
    `--port=${u.port || '5432'}`,
    `--username=${decodeURIComponent(u.username)}`,
    `--dbname=${decodeURIComponent(u.pathname.replace(/^\//, ''))}`,
    '--no-password',
  ];
  const env: Record<string, string> = {};
  if (u.password) env['PGPASSWORD'] = decodeURIComponent(u.password);
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env['PGSSLMODE'] = ssl;
  return { args, env };
}

/** The same URL pointing at another database on the same server. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}
