/**
 * Evidence manifest writer (AGENTS.md directive 8, design §10.8).
 *
 * Screenshots live at `.agent/evidence/<taskId>/<YYYYMMDD-HHMMSS>-<scenarioId>-<slug>.png` and
 * every capture is recorded in `.agent/evidence/<taskId>/manifest.json`:
 *
 *   { "schemaVersion": 1, "taskId": "T-0009", "entries": [ { scenario, file, test, commit,
 *     provider, timestamp, result }, ... ] }
 *
 * The manifest is append-only: existing entries are never rewritten or dropped, a corrupt file is
 * left untouched (the append fails loudly instead), and concurrent writers (parallel Playwright
 * workers) serialise through a lock directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface EvidenceEntry {
  /** Success-scenario id, e.g. SS-PLAT-UI-01. */
  scenario: string;
  /** Repo-relative POSIX path of the screenshot. */
  file: string;
  /** Full test title. */
  test: string;
  /** Git commit the evidence was produced from (`-dirty` suffix if the tree had changes). */
  commit: string;
  /** Provider that ran the tests: claude | codex | ci | unknown. */
  provider: string;
  /** ISO-8601 capture time. */
  timestamp: string;
  /** Test outcome: passed | failed | timedOut | skipped | interrupted. */
  result: string;
}

export interface EvidenceManifest {
  schemaVersion: 1;
  taskId: string;
  entries: EvidenceEntry[];
}

export interface EvidenceContext {
  taskId: string;
  provider: string;
  commit: string;
  repoRoot: string;
  evidenceRoot: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeId(label: string, value: string): string {
  if (!SAFE_ID.test(value) || value.includes('..')) {
    throw new Error(`Unsafe evidence ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (slug === '') throw new Error(`Evidence slug ${JSON.stringify(input)} is empty after slugify`);
  return slug;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** UTC `YYYYMMDD-HHMMSS`. */
export function formatTimestamp(date: Date): string {
  return (
    `${String(date.getUTCFullYear())}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

export function evidenceFilePath(opts: {
  evidenceRoot: string;
  taskId: string;
  scenarioId: string;
  slug: string;
  date: Date;
}): string {
  const taskId = assertSafeId('taskId', opts.taskId);
  const scenario = assertSafeId('scenarioId', opts.scenarioId);
  const name = `${formatTimestamp(opts.date)}-${scenario}-${slugify(opts.slug)}.png`;
  return join(opts.evidenceRoot, taskId, name).split(sep).join('/');
}

const REQUIRED: (keyof EvidenceEntry)[] = [
  'scenario',
  'file',
  'test',
  'commit',
  'provider',
  'timestamp',
  'result',
];

function validateEntry(e: EvidenceEntry): void {
  for (const k of REQUIRED) {
    if (typeof e[k] !== 'string' || e[k].trim() === '') {
      throw new Error(`Evidence entry field "${k}" must be a non-empty string`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${target}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock older than 30s belongs to a crashed writer; it is an empty directory we created.
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > 30_000) await rmdir(lock).catch(() => undefined);
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for manifest lock ${lock}`, { cause: error });
      await sleep(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

async function readManifest(path: string, taskId: string): Promise<EvidenceManifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, taskId, entries: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Evidence manifest ${path} is not valid JSON; refusing to overwrite it`, {
      cause: error,
    });
  }
  const m = parsed as Partial<EvidenceManifest>;
  if (m.schemaVersion !== 1 || !Array.isArray(m.entries) || typeof m.taskId !== 'string') {
    throw new Error(`Evidence manifest ${path} has an unexpected shape; refusing to overwrite it`);
  }
  if (m.taskId !== taskId) {
    throw new Error(`Evidence manifest ${path} belongs to ${m.taskId}, not ${taskId}`);
  }
  return m as EvidenceManifest;
}

/** Append entries to the manifest (created if missing). Never rewrites existing entries. */
export async function appendManifestEntries(
  manifestPath: string,
  taskId: string,
  entries: readonly EvidenceEntry[],
): Promise<void> {
  assertSafeId('taskId', taskId);
  entries.forEach(validateEntry);
  await mkdir(dirname(manifestPath), { recursive: true });
  await withLock(manifestPath, async () => {
    const manifest = await readManifest(manifestPath, taskId);
    manifest.entries.push(...entries);
    const tmp = `${manifestPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(tmp, manifestPath);
  });
}

/** Walk up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml found above ${start}`);
    dir = parent;
  }
}

function gitCommit(cwd: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export function resolveEvidenceContext(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): EvidenceContext {
  const repoRoot = findRepoRoot(cwd);
  const taskId = assertSafeId('taskId', env['LF_TASK_ID'] || 'adhoc');
  return {
    taskId,
    provider: env['LF_PROVIDER'] || 'unknown',
    commit: env['GITHUB_SHA'] || gitCommit(repoRoot),
    repoRoot,
    evidenceRoot: env['LF_EVIDENCE_DIR'] || join(repoRoot, '.agent', 'evidence'),
  };
}
