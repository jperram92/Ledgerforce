// End-to-end proof of the failover loop (design §10.4) using fake provider CLIs in temp git repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo, runCli, git, cardField, readState, readText, configWith, fake, AGENT_DIR } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { quotaMatch, classifyOutput } from '../lib/run.ts';

const FAST = { LF_POLL_MS: '100' };

function fakeLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'lf-fakelog-')), 'calls.log');
}
function calls(path: string): string[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}
function runLogs(root: string): string[] {
  try { return readdirSync(join(root, '.agent/runs')).filter((f) => f.endsWith('.log')).sort(); } catch { return []; }
}

test('run --dry-run prints the provider commands in failover order and changes nothing', () => {
  const root = makeRepo(); // fixture config uses the real CLIs "claude -p" / "codex exec" with default args
  const before = readText(root, '.agent/backlog/T-0002.md');
  const r = runCli(root, ['run', '--once', '--dry-run']);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Task: T-0002/);
  const claudeLine = r.stdout.split('\n').find((l) => l.includes('claude -p'));
  const codexLine = r.stdout.split('\n').find((l) => l.includes('codex exec'));
  assert.ok(claudeLine, r.stdout);
  assert.ok(codexLine, r.stdout);
  assert.ok(r.stdout.indexOf('claude -p') < r.stdout.indexOf('codex exec'), 'claude before codex');
  // defaults from RQ-0002 / RQ-0001 (the fixture config has no `args`)
  assert.match(claudeLine!, /--output-format stream-json --verbose --permission-mode acceptEdits --max-turns 200/);
  assert.match(codexLine!, new RegExp(`--cd ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -s workspace-write -c sandbox_workspace_write.network_access=true --json -o \\S+-codex-r02-last\\.md`));
  assert.doesNotMatch(r.stdout, /--full-auto/);
  assert.match(r.stdout, /You are resuming LedgerForce task T-0002/);
  assert.match(r.stdout, /claim T-0002 --provider claude/);
  assert.equal(readText(root, '.agent/backlog/T-0002.md'), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('run --dry-run honours configured args and --task', () => {
  const root = makeRepo({ config: configWith({ claudeArgs: '["--output-format", "stream-json", "--verbose"]', codexArgs: '[]' }) });
  const r = runCli(root, ['run', '--once', '--dry-run', '--task', 'T-0004']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Task: T-0004/);
  const claudeLine = r.stdout.split('\n').find((l) => l.includes('claude -p'))!;
  assert.match(claudeLine, /--output-format stream-json --verbose/);
  assert.doesNotMatch(claudeLine, /acceptEdits/);
  const codexLine = r.stdout.split('\n').find((l) => l.includes('codex exec'))!;
  assert.doesNotMatch(codexLine, /--sandbox/);
});

test('FAILOVER: claude hits a credit/quota error, codex resumes on the same branch and finishes', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-quota.sh'), codexCli: fake('fake-success.sh') }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);

  // both providers ran, in order, on the same task
  assert.deepEqual(calls(log).map((l) => l.split(' ').slice(0, 3).join(' ')),
    ['fake-quota claude T-0002', 'fake-success codex T-0002']);

  // same task branch for both
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.equal(branch, 'feat/T-0002-ledger-tables');
  assert.equal(readState(root).branch, 'feat/T-0002-ledger-tables');

  // claude's uncommitted work was snapshotted to a wip/ ref and never lost
  const wipRefs = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/wip/').split('\n').filter(Boolean);
  assert.equal(wipRefs.length, 1, wipRefs.join(','));
  assert.match(wipRefs[0], /^wip\/T-0002-\d{8}T\d{6}Z$/);
  assert.equal(git(root, 'show', `${wipRefs[0]}:work-claude.txt`), 'partial work by claude');
  // and is still present for codex, which checkpointed it on the task branch
  assert.match(git(root, 'show', '--name-only', '--format=', 'HEAD'), /work-claude\.txt/);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'wip(T-0002): codex finished step 2');

  // task finished by codex
  assert.equal(cardField(root, 'T-0002', 'status'), 'done');
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'codex');
  assert.equal(cardField(root, 'T-0002', 'attempts'), '2');
  const s = readState(root);
  assert.equal(s.current_task, null);
  assert.ok(s.providers.claude.exhausted_until, 'claude marked exhausted');
  assert.equal(s.providers.claude.last_failure, 'quota');

  // handover records the provider failure
  const h = readText(root, '.agent/HANDOVER.md');
  assert.match(h, /claude.*(quota|credit)/i);
  assert.match(h, /wip\/T-0002-/);

  // one run log per provider session, named <date>-<provider>-rNN.log
  const logs = runLogs(root);
  assert.equal(logs.length, 2, logs.join(','));
  assert.match(logs.find((f) => f.includes('-claude-'))!, /^\d{4}-\d{2}-\d{2}-claude-r01\.log$/);
  assert.match(logs.find((f) => f.includes('-codex-'))!, /^\d{4}-\d{2}-\d{2}-codex-r02\.log$/);
  const claudeLog = readFileSync(join(root, '.agent/runs', logs.find((f) => f.includes('-claude-'))!), 'utf8');
  assert.match(claudeLog, /Credit balance is too low/);
  assert.match(claudeLog, /outcome: quota/);
});

test('a provider that is still exhausted is skipped on the next run', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-quota.sh'), codexCli: fake('fake-success.sh') }) });
  const log = fakeLog();
  assert.equal(runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log }).code, 0);
  assert.equal(runCli(root, ['run', '--once', '--task', 'T-0004'], { ...FAST, FAKE_LOG: log }).code, 0);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[0] + ' ' + l.split(' ')[2]),
    ['fake-quota T-0002', 'fake-success T-0002', 'fake-success T-0004']);
});

test('all providers out of quota → exit 3, work saved, handover written, lease released', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-quota.sh'), codexCli: fake('fake-quota.sh') }) });
  const r = runCli(root, ['run', '--once'], FAST);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /all providers/i);
  assert.equal(cardField(root, 'T-0002', 'status'), 'todo');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), 'null');
  assert.match(readText(root, '.agent/HANDOVER.md'), /all providers/i);
  const wip = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/wip/').split('\n').filter(Boolean);
  assert.equal(wip.length, 2);
  // nothing lost: both providers' files are still in the working tree
  assert.match(git(root, 'status', '--porcelain'), /work-claude\.txt/);
  assert.match(git(root, 'status', '--porcelain'), /work-codex\.txt/);
});

test('non-quota failures rotate providers and block the task after max_attempts_per_task', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-fail.sh'), codexCli: fake('fake-fail.sh'), maxAttempts: 3 }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 4, r.stdout + r.stderr);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[1]), ['claude', 'codex', 'claude']);
  assert.equal(cardField(root, 'T-0002', 'status'), 'blocked');
  assert.match(cardField(root, 'T-0002', 'blocked_reason')!, /3 failed attempts/);
  assert.equal(readState(root).failures['T-0002'], 3);
  const notes = readdirSync(join(root, '.agent/notifications'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^\d{8}T\d{6}Z-T-0002\.md$/);
  const note = readFileSync(join(root, '.agent/notifications', notes[0]), 'utf8');
  assert.match(note, /T-0002/);
  assert.match(note, /\.agent\/runs\/.*-claude-r01\.log/);
  assert.match(note, /TypeError/);
});

test('missed heartbeat (lease expiry) kills the provider and fails over', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-hang.sh'), codexCli: fake('fake-success.sh'), lease: 0.02 }) });
  const log = fakeLog();
  const started = Date.now();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log }, 25_000);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - started < 20_000, 'hung provider was killed promptly');
  assert.match(r.stdout, /heartbeat/i);
  assert.equal(cardField(root, 'T-0002', 'status'), 'done');
  assert.equal(readState(root).failures['T-0002'], 1);
});

test('agent marking the task blocked stops the loop with a notification', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-blocked.sh'), codexCli: fake('fake-success.sh') }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 4, r.stdout + r.stderr);
  assert.equal(calls(log).length, 1);
  assert.equal(cardField(root, 'T-0002', 'status'), 'blocked');
  assert.equal(readdirSync(join(root, '.agent/notifications')).length, 1);
});

test('daily budget: a provider whose run logs today exceed daily_usd is skipped', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-success.sh'), codexCli: fake('fake-success.sh'), budgetClaude: 5 }) });
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, '.agent/runs'), { recursive: true });
  writeFileSync(join(root, '.agent/runs', `${today}-claude-r01.log`), 'blah\nconductor: cost_usd=3.50\n');
  writeFileSync(join(root, '.agent/runs', `${today}-claude-r02.log`), '{"type":"result","total_cost_usd":2.00}\n');
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /claude.*budget/i);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[1]), ['codex']);
  // the new run log records its own cost for future budget checks
  const codexLog = runLogs(root).find((f) => f.includes('-codex-'))!;
  assert.match(codexLog, /-r03\.log$/);
  assert.match(readFileSync(join(root, '.agent/runs', codexLog), 'utf8'), /conductor: cost_usd=1\.25/);
});

test('run with nothing to do exits 0', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-success.sh'), codexCli: fake('fake-success.sh') }) });
  for (const id of ['T-0002', 'T-0003', 'T-0004']) {
    const p = join(root, `.agent/backlog/${id}.md`);
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^status: todo/m, 'status: done'));
  }
  const r = runCli(root, ['run', '--once'], FAST);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to do/i);
});

test('run without --once keeps working the backlog until empty', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-success.sh'), codexCli: fake('fake-success.sh') }) });
  const log = fakeLog();
  const r = runCli(root, ['run'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[2]), ['T-0002', 'T-0003', 'T-0004']);
  for (const id of ['T-0002', 'T-0003', 'T-0004']) assert.equal(cardField(root, id, 'status'), 'done');
});

// ---- cross-review routing ----

function toReview(root: string, builder: string): void {
  const p = join(root, '.agent/backlog/T-0002.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^status: todo/m, 'status: review').replace(/^claimed_by: null/m, `claimed_by: ${builder}`));
}

test('run routes a card in review to the provider that did NOT build it', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-success.sh'), codexCli: fake('fake-success.sh') }) });
  toReview(root, 'claude');
  const log = fakeLog();
  const r = runCli(root, ['run', '--once', '--dry-run'], FAST);
  assert.match(r.stdout, /cross-review/i);
  assert.doesNotMatch(r.stdout.split('--- prompt ---')[0], /\$ bash .*claude|\[1\] claude/);
  const r2 = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[1]), ['codex']);
  const promptLog = readFileSync(join(root, '.agent/runs', runLogs(root)[0]), 'utf8');
  assert.match(promptLog, /cross-review/i);
});

test('review with only the builder available → exit 3, never self-review', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-success.sh'), codexCli: fake('fake-success.sh'), order: '[claude]' }) });
  toReview(root, 'claude');
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.equal(calls(log).length, 0);
  assert.equal(cardField(root, 'T-0002', 'status'), 'review');
});

test('builder handing the card to review counts as a successful session (not a failure)', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-to-review.sh'), codexCli: fake('fake-fail.sh') }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(cardField(root, 'T-0002', 'status'), 'review');
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'claude');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), 'null');
  assert.equal(readState(root).failures['T-0002'] ?? 0, 0);
});

// ---- provider failure classification (RQ-0001, RQ-0002) ----

test('the real config matches the session-limit message that stopped a session, case-insensitively', () => {
  const cfg = loadConfig(join(AGENT_DIR, '../..'));
  for (const msg of [
    "You've hit your session limit · resets 7:30am (UTC)",
    "YOU'VE HIT YOUR SESSION LIMIT · RESETS 7:30AM (UTC)",
    "You've hit your weekly limit · resets Mon",
    'Credit balance is too low',
    'API Error: Request rejected (429) · rate limited',
    'API Error: Repeated 529 Overloaded errors.',
    'Server is temporarily limiting requests (not your usage limit)',
    "You've hit your monthly spend limit",
    'stream error: exceeded retry limit, last status: 429 Too Many Requests',
  ]) assert.ok(quotaMatch(cfg, msg), msg);
  assert.equal(quotaMatch(cfg, 'TypeError: cannot read properties of undefined'), null);
});

test('classifyOutput: stdout and stderr, is_error/subtype from the final result', () => {
  const cfg = loadConfig(join(AGENT_DIR, '../..'));
  assert.equal(classifyOutput(cfg, 1, '{"type":"result","is_error":true,"result":"You\'ve hit your session limit · resets 7:30am (UTC)"}').kind, 'quota');
  assert.equal(classifyOutput(cfg, 0, '{"type":"result","subtype":"error_max_budget_usd","is_error":true}').kind, 'quota');
  const mt = classifyOutput(cfg, 0, '{"type":"result","subtype":"error_max_turns","is_error":true}');
  assert.equal(mt.kind, 'failure');
  assert.match(mt.detail, /error_max_turns/);
  assert.equal(classifyOutput(cfg, 1, 'boom: segfault').kind, 'failure');
  // exit 0, task not done, limit message at the end of the output → quota
  assert.equal(classifyOutput(cfg, 0, 'did some work\nYou\'ve hit your session limit · resets 7:30am (UTC)\n').kind, 'quota');
});

test('FAILOVER on the real session-limit message printed to stdout', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-session-limit.sh'), codexCli: fake('fake-success.sh') }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(calls(log).map((l) => l.split(' ')[1]), ['claude', 'codex']);
  assert.equal(readState(root).providers.claude.last_failure, 'quota');
  assert.match(readText(root, '.agent/HANDOVER.md'), /session limit/);
});

// ---- codex cannot write .git: the conductor commits for it ----

test('commits: conductor — deferred checkpoints are committed by the conductor during and after the run', () => {
  const root = makeRepo({ config: configWith({ claudeCli: fake('fake-quota.sh'), codexCli: fake('fake-nogit.sh'), codexCommits: 'conductor' }) });
  const log = fakeLog();
  const r = runCli(root, ['run', '--once'], { ...FAST, FAKE_LOG: log }, 30_000);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(calls(log).some((l) => l.startsWith('fake-nogit codex T-0002 saw-commit')), calls(log).join('\n'));
  const subjects = git(root, 'log', '--format=%s').split('\n');
  assert.ok(subjects.includes('wip(T-0002): codex step 1 (no .git access)'), subjects.join('\n'));
  assert.ok(subjects.some((x) => /^wip\(T-0002\): codex r\d+ session end \(committed by conductor\)$/.test(x)), subjects.join('\n'));
  assert.match(git(root, 'show', '--name-only', '--format=', 'HEAD~1'), /codex-step1\.txt/);
  assert.match(git(root, 'show', '--name-only', '--format=', 'HEAD'), /codex-final\.txt/);
  assert.equal(cardField(root, 'T-0002', 'status'), 'done');
  const s = readState(root);
  assert.deepEqual(s.pending_checkpoints ?? [], []);
  assert.equal(cardField(root, 'T-0002', 'last_checkpoint'), git(root, 'rev-parse', 'HEAD~1'));
});

test('checkpoint with LF_DEFER_COMMIT=1 records the step instead of touching .git', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'codex']);
  writeFileSync(join(root, 'x.txt'), 'x');
  const before = git(root, 'rev-parse', 'HEAD');
  const r = runCli(root, ['checkpoint', 'T-0002', '--step', 'deferred step'], { LF_DEFER_COMMIT: '1' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /deferred/i);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  assert.deepEqual(readState(root).pending_checkpoints, ['deferred step']);
});
