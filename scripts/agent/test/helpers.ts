// Shared helpers for the conductor test-suite. Every git-based test works in a fresh
// temp directory (mkdtemp) — the real repository's git state is never touched.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const AGENT_DIR = join(import.meta.dirname, '..');
export const CONDUCTOR = join(AGENT_DIR, 'conductor.ts');
export const FIXTURES = join(import.meta.dirname, 'fixtures');
export const BIN = join(FIXTURES, 'bin');

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Copy the fixture repo into a temp dir, git init it and make an initial commit. */
export function makeRepo(opts: { config?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lf-conductor-')).replaceAll('\\', '/');
  cpSync(join(FIXTURES, 'repo'), root, { recursive: true });
  if (opts.config !== undefined) writeFileSync(join(root, '.agent/config.yaml'), opts.config);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Conductor Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

export interface CliResult { code: number | null; stdout: string; stderr: string }

export function runCli(root: string, args: string[], env: Record<string, string> = {}, timeoutMs = 60_000): CliResult {
  const r = spawnSync(process.execPath, [CONDUCTOR, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function runBash(root: string, script: string, args: string[] = [], env: Record<string, string> = {}, timeoutMs = 180_000): CliResult {
  const r = spawnSync('bash', [join(AGENT_DIR, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function readText(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

export function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function readState(root: string): any {
  return JSON.parse(readText(root, '.agent/state.json'));
}

/** Read one top-level frontmatter field of a card as raw text (independent of the parser under test). */
export function cardField(root: string, id: string, key: string): string | undefined {
  const text = readText(root, `.agent/backlog/${id}.md`);
  const fm = text.split(/^---\s*$/m)[1] ?? '';
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*(#.*)?$`, 'm'));
  return m ? m[1].replace(/^"(.*)"$/, '$1') : undefined;
}

/** The failure_patterns block of the real .agent/config.yaml, so tests track the human-owned list. */
export function realFailurePatterns(): string {
  const text = readFileSync(join(AGENT_DIR, '../../.agent/config.yaml'), 'utf8');
  const m = text.match(/^failure_patterns:[^\n]*\n(?:[ \t]+[^\n]*\n)+/m);
  if (!m) throw new Error('no failure_patterns block in .agent/config.yaml');
  return m[0].trimEnd();
}

/** Build a config.yaml for a temp repo with the given provider CLIs. */
export function configWith(o: {
  claudeCli?: string; codexCli?: string; claudeArgs?: string; codexArgs?: string;
  lease?: number; maxAttempts?: number; order?: string; budgetClaude?: number; extra?: string;
  codexCommits?: string;
}): string {
  const claudeArgs = o.claudeArgs !== undefined ? `\n    args: ${o.claudeArgs}` : '';
  const codexArgs = o.codexArgs !== undefined ? `\n    args: ${o.codexArgs}` : '';
  return `providers:
  - id: claude
    cli: "${o.claudeCli ?? 'claude -p'}"${claudeArgs}
    role: [build, review]
  - id: codex
    cli: "${o.codexCli ?? 'codex exec'}"${codexArgs}${o.codexCommits ? `\n    commits: ${o.codexCommits}` : ''}
    role: [build, review]
failover_order: ${o.order ?? '[claude, codex]'}
lease_minutes: ${o.lease ?? 45}
heartbeat_minutes: 10
max_attempts_per_task: ${o.maxAttempts ?? 3}
parallel_tasks: 1
budgets:
  claude: { daily_usd: ${o.budgetClaude ?? 40} }
  codex: { daily_usd: 40 }
${realFailurePatterns()}
${o.extra ?? ''}
`;
}

export function fake(name: string): string {
  return `bash ${join(BIN, name).replaceAll('\\', '/')}`;
}
