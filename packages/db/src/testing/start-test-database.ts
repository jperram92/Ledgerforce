/**
 * startTestDatabase() — a real, throw-away PostgreSQL server for integration tests (DL-0007).
 *
 * Mode selection (`chooseMode`), overridable with LF_TEST_DB_MODE=auto|external|docker|local:
 *  1. external — LF_TEST_DATABASE_URL is set (a superuser URL, e.g. the CI service container);
 *  2. docker   — a Docker daemon is reachable → Testcontainers `postgres:17`;
 *  3. local    — otherwise: initdb + pg_ctl from the installed PostgreSQL binaries
 *                (LF_PG_BINDIR, `pg_config --bindir`, or the newest /usr/lib/postgresql/<v>/bin),
 *                in a fresh temp directory, on a free localhost port, trust auth, fsync off.
 *                When running as root (initdb refuses root) the cluster runs as the `postgres`
 *                OS user (or LF_PG_OS_USER), via Node's spawn uid/gid — no sudo needed.
 * `stop()` shuts the server down and removes the temp directory; an exit hook does the same if
 * the process dies first, so no cluster is left running.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chownSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TestDbMode = 'external' | 'docker' | 'local';
type Env = Readonly<Record<string, string | undefined>>;

export interface TestDatabaseServer {
  mode: TestDbMode;
  host: string;
  port: number;
  superuser: string;
  superuserPassword: string | undefined;
  /** Local mode only: the cluster's temp directory (removed by stop()). */
  dataDir: string | undefined;
  /** Connection string for `database` as `user` (defaults to the superuser). */
  connectionString(database: string, user?: string, password?: string): string;
  stop(): Promise<void>;
}

export function chooseMode(env: Env, dockerAvailable: boolean): TestDbMode {
  const requested = env['LF_TEST_DB_MODE'] ?? 'auto';
  switch (requested) {
    case 'auto':
      if (env['LF_TEST_DATABASE_URL']) return 'external';
      return dockerAvailable ? 'docker' : 'local';
    case 'external':
      if (!env['LF_TEST_DATABASE_URL']) {
        throw new Error('LF_TEST_DB_MODE=external requires LF_TEST_DATABASE_URL (a superuser URL)');
      }
      return 'external';
    case 'docker':
      if (!dockerAvailable)
        throw new Error('LF_TEST_DB_MODE=docker but no Docker daemon is reachable');
      return 'docker';
    case 'local':
      return 'local';
    default:
      throw new Error(`Unknown LF_TEST_DB_MODE=${requested} (auto|external|docker|local)`);
  }
}

const hasTools = (dir: string): boolean =>
  existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'));

const versionKey = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0);

export function findPgBinDir(
  env: Env,
  candidateRoots: readonly string[] = ['/usr/lib/postgresql', '/usr/local/lib/postgresql'],
): string {
  const explicit = env['LF_PG_BINDIR'];
  if (explicit) {
    if (!hasTools(explicit)) throw new Error(`LF_PG_BINDIR=${explicit} has no initdb/pg_ctl`);
    return explicit;
  }
  const versioned: { version: string; bin: string }[] = [];
  for (const root of candidateRoots) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root)) {
      const bin = join(root, v, 'bin');
      if (hasTools(bin)) versioned.push({ version: v, bin });
    }
  }
  versioned.sort((a, b) => {
    const ka = versionKey(a.version);
    const kb = versionKey(b.version);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  if (versioned[0]) return versioned[0].bin;
  try {
    const bin = execFileSync('pg_config', ['--bindir'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    })
      .toString()
      .trim();
    if (hasTools(bin)) return bin;
  } catch {
    // fall through
  }
  throw new Error(
    'No PostgreSQL server binaries found (initdb, pg_ctl). Install PostgreSQL 16/17, set ' +
      'LF_PG_BINDIR, start Docker, or set LF_TEST_DATABASE_URL.',
  );
}

async function dockerAvailable(env: Env): Promise<boolean> {
  const host = env['DOCKER_HOST'];
  if (!host && !existsSync('/var/run/docker.sock')) return false;
  try {
    const { getContainerRuntimeClient } = await import('testcontainers');
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function url(
  host: string,
  port: number,
  database: string,
  user: string,
  password?: string,
): string {
  const auth =
    password === undefined
      ? encodeURIComponent(user)
      : `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${String(port)}/${encodeURIComponent(database)}`;
}

function osUser(env: Env): { uid: number; gid: number } | undefined {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return undefined;
  const name = env['LF_PG_OS_USER'] ?? 'postgres';
  try {
    const uid = Number.parseInt(execFileSync('id', ['-u', name]).toString().trim(), 10);
    const gid = Number.parseInt(execFileSync('id', ['-g', name]).toString().trim(), 10);
    return { uid, gid };
  } catch {
    return { uid: 65534, gid: 65534 }; // nobody
  }
}

function run(
  bin: string,
  args: string[],
  cwd: string,
  ids: { uid: number; gid: number } | undefined,
): void {
  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
    ...(ids ?? {}),
  });
  if (r.status !== 0) {
    throw new Error(
      `${bin} ${args.join(' ')} failed (${String(r.status)}):\n${r.stdout}\n${r.stderr}`,
    );
  }
}

async function startLocal(env: Env): Promise<TestDatabaseServer> {
  const binDir = findPgBinDir(env);
  const ids = osUser(env);
  const base = mkdtempSync(join(env['LF_TEST_DB_TMPDIR'] ?? tmpdir(), 'lf-pg-'));
  const dataDir = join(base, 'data');
  const logFile = join(base, 'postgres.log');
  writeFileSync(logFile, '');
  if (ids) {
    chownSync(base, ids.uid, ids.gid);
    chownSync(logFile, ids.uid, ids.gid);
  }
  const pgCtl = join(binDir, 'pg_ctl');
  let stopped = false;
  const stopSync = (): void => {
    if (stopped) return;
    stopped = true;
    if (existsSync(join(dataDir, 'postmaster.pid'))) {
      spawnSync(pgCtl, ['stop', '-D', dataDir, '-m', 'immediate', '-w'], {
        cwd: base,
        ...(ids ?? {}),
      });
    }
    rmSync(base, { recursive: true, force: true });
  };
  process.once('exit', stopSync);

  try {
    run(
      join(binDir, 'initdb'),
      ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C', '--no-sync'],
      base,
      ids,
    );
    let port = 0;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      port = await freePort();
      const opts = [
        `-p ${String(port)}`,
        `-k ${base}`,
        "-c listen_addresses='127.0.0.1'",
        '-c fsync=off',
        '-c synchronous_commit=off',
        '-c full_page_writes=off',
        '-c max_connections=200',
      ].join(' ');
      try {
        run(
          pgCtl,
          ['start', '-D', dataDir, '-l', logFile, '-w', '-t', '60', '-o', opts],
          base,
          ids,
        );
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
    statSync(join(dataDir, 'postmaster.pid'));

    const host = '127.0.0.1';
    return {
      mode: 'local',
      host,
      port,
      superuser: 'postgres',
      superuserPassword: undefined,
      dataDir: base,
      connectionString: (database, user = 'postgres', password) =>
        url(host, port, database, user, password),
      stop: async () => {
        process.removeListener('exit', stopSync);
        if (stopped) return;
        stopped = true;
        run(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], base, ids);
        rmSync(base, { recursive: true, force: true });
      },
    };
  } catch (error) {
    stopSync();
    process.removeListener('exit', stopSync);
    throw error;
  }
}

async function startDocker(): Promise<TestDatabaseServer> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:17').start();
  const host = container.getHost();
  const port = container.getPort();
  const user = container.getUsername();
  const pass = container.getPassword();
  return {
    mode: 'docker',
    host,
    port,
    superuser: user,
    superuserPassword: pass,
    dataDir: undefined,
    connectionString: (database, u = user, p) =>
      url(host, port, database, u, u === user ? pass : p),
    stop: async () => {
      await container.stop();
    },
  };
}

function external(env: Env): TestDatabaseServer {
  const u = new URL(env['LF_TEST_DATABASE_URL'] ?? '');
  const host = u.hostname;
  const port = Number.parseInt(u.port || '5432', 10);
  const user = decodeURIComponent(u.username);
  const pass = u.password ? decodeURIComponent(u.password) : undefined;
  return {
    mode: 'external',
    host,
    port,
    superuser: user,
    superuserPassword: pass,
    dataDir: undefined,
    connectionString: (database, uu = user, p) =>
      url(host, port, database, uu, uu === user ? pass : p),
    stop: async () => {
      // externally managed — nothing to tear down
    },
  };
}

export async function startTestDatabase(env: Env = process.env): Promise<TestDatabaseServer> {
  const needDockerProbe = !env['LF_TEST_DATABASE_URL'] && env['LF_TEST_DB_MODE'] !== 'local';
  const mode = chooseMode(env, needDockerProbe ? await dockerAvailable(env) : false);
  if (mode === 'external') return external(env);
  if (mode === 'docker') return startDocker();
  return startLocal(env);
}
