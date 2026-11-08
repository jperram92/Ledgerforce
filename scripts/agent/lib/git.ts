// Thin git wrapper. Never deletes, never rewrites history, never resets.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gitTry(root: string, args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: env ?? process.env });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

export function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = gitTry(root, args, env);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

export function isRepo(root: string): boolean {
  return gitTry(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

export function headSha(root: string): string | null {
  const r = gitTry(root, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.out : null;
}

export function currentBranch(root: string): string | null {
  const r = gitTry(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 && r.out !== 'HEAD' ? r.out : null;
}

export function hasChanges(root: string): boolean {
  return gitTry(root, ['status', '--porcelain']).out !== '';
}

export function branchExists(root: string, name: string): boolean {
  return gitTry(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).code === 0;
}

/** Environment with a fallback committer identity if the repo/user has none configured. */
export function identityEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!gitTry(root, ['config', 'user.email']).out && !env.GIT_AUTHOR_EMAIL) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'LedgerForce Conductor';
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'conductor@ledgerforce.invalid';
  }
  return env;
}

export function commitAll(root: string, message: string): string {
  const env = identityEnv(root);
  git(root, ['add', '-A'], env);
  git(root, ['commit', '-q', '--no-verify', '-m', message], env);
  return headSha(root)!;
}

/**
 * Snapshot the whole working tree (tracked + untracked, respecting .gitignore) into a commit
 * on `refs/heads/<ref>` WITHOUT touching the real index, HEAD or working tree.
 * Returns the ref name actually used (a numeric suffix is added if it already exists).
 */
export function snapshotToRef(root: string, ref: string, message: string): { ref: string; sha: string } {
  const env = identityEnv(root, { ...process.env, GIT_INDEX_FILE: join(mkdtempSync(join(tmpdir(), 'lf-wip-')), 'index') });
  const head = headSha(root);
  if (head) git(root, ['read-tree', 'HEAD'], env);
  git(root, ['add', '-A'], env);
  const tree = git(root, ['write-tree'], env);
  const sha = git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], env);
  let name = ref;
  for (let n = 2; branchExists(root, name); n++) name = `${ref}-${n}`;
  git(root, ['update-ref', `refs/heads/${name}`, sha]);
  return { ref: name, sha };
}

export function ensureBranch(root: string, name: string): void {
  if (currentBranch(root) === name) return;
  if (branchExists(root, name)) git(root, ['checkout', '-q', name]);
  else git(root, ['checkout', '-q', '-b', name]);
}
