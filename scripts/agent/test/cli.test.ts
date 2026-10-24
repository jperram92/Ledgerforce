// CLI contract tests for: next, claim, checkpoint, release, handover, status, lease-check, lint-backlog.
// Other agents' skills call these exact subcommands, so the interface is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, runCli, git, cardField, readState, readText, exists } from './helpers.ts';

const T0 = '2026-10-24T05:00:00.000Z';
const at = (iso: string) => ({ LF_NOW: iso });

test('next prints the next claimable task in dependency order', () => {
  const root = makeRepo();
  const r = runCli(root, ['next']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'T-0002');
  const r5 = runCli(root, ['next', '--count', '5']);
  assert.deepEqual(r5.stdout.trim().split('\n'), ['T-0002', 'T-0004']);
});

test('claim writes the lease to card and state.json', () => {
  const root = makeRepo();
  const r = runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(cardField(root, 'T-0002', 'status'), 'claimed');
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'claude');
  assert.equal(cardField(root, 'T-0002', 'attempts'), '1');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), '2026-10-24T05:45:00.000Z');
  const s = readState(root);
  assert.equal(s.current_task, 'T-0002');
  assert.equal(s.claimed_by, 'claude');
  assert.equal(s.lease_expires_at, '2026-10-24T05:45:00.000Z');
  assert.equal(s.attempts['T-0002'], 1);
  assert.equal(s.updated_at, T0);
  // the comment on the status line survives
  assert.match(readText(root, '.agent/backlog/T-0002.md'), /^status: claimed\s+# todo \| claimed/m);
});

test('claim refuses: unknown provider, unmet deps, done task, missing task', () => {
  const root = makeRepo();
  assert.equal(runCli(root, ['claim', 'T-0002', '--provider', 'gpt']).code, 2);
  const deps = runCli(root, ['claim', 'T-0003', '--provider', 'claude']);
  assert.equal(deps.code, 2);
  assert.match(deps.stderr, /T-0002.*not done/);
  assert.equal(runCli(root, ['claim', 'T-0001', '--provider', 'claude']).code, 2);
  assert.equal(runCli(root, ['claim', 'T-0999', '--provider', 'claude']).code, 2);
  assert.equal(runCli(root, ['claim', 'T-0002']).code, 2); // --provider required
});

test('claim refuses while another unexpired lease exists; allows takeover after expiry', () => {
  const root = makeRepo();
  assert.equal(runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0)).code, 0);
  const same = runCli(root, ['claim', 'T-0002', '--provider', 'codex'], at('2026-10-24T05:10:00.000Z'));
  assert.equal(same.code, 2);
  assert.match(same.stderr, /lease/);
  const other = runCli(root, ['claim', 'T-0004', '--provider', 'codex'], at('2026-10-24T05:10:00.000Z'));
  assert.equal(other.code, 2);
  assert.match(other.stderr, /T-0002/);
  // after expiry (claimed-expired) codex may take it over
  const later = runCli(root, ['claim', 'T-0002', '--provider', 'codex'], at('2026-10-24T06:00:00.000Z'));
  assert.equal(later.code, 0, later.stderr);
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'codex');
  assert.equal(cardField(root, 'T-0002', 'attempts'), '2');
  assert.equal(readState(root).attempts['T-0002'], 2);
});

test('checkpoint commits work, records the sha, renews the lease and logs the step', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  writeFileSync(join(root, 'migration.sql'), 'create table x();\n');
  const r = runCli(root, ['checkpoint', 'T-0002', '--step', 'step 2/3 — balance trigger green'], at('2026-10-24T05:20:00.000Z'));
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'wip(T-0002): step 2/3 — balance trigger green');
  assert.match(git(root, 'show', '--name-only', '--format=', 'HEAD'), /migration\.sql/);
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(cardField(root, 'T-0002', 'last_checkpoint'), head);
  const s = readState(root);
  assert.equal(s.last_green_commit, head);
  assert.equal(s.step, 'step 2/3 — balance trigger green');
  assert.equal(s.lease_expires_at, '2026-10-24T06:05:00.000Z');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), '2026-10-24T06:05:00.000Z');
  const handover = readText(root, '.agent/HANDOVER.md');
  assert.match(handover, /## Log[\s\S]*step 2\/3 — balance trigger green/);
});

test('checkpoint does not create an empty commit when nothing changed', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'claim');
  const before = git(root, 'rev-list', '--count', 'HEAD');
  const r = runCli(root, ['checkpoint', 'T-0002', '--step', 'nothing new'], at(T0));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(root, 'rev-list', '--count', 'HEAD'), before);
  assert.match(r.stdout, /no changes/i);
  assert.equal(cardField(root, 'T-0002', 'last_checkpoint'), git(root, 'rev-parse', 'HEAD'));
});

test('checkpoint refuses a task that is not claimed', () => {
  const root = makeRepo();
  assert.equal(runCli(root, ['checkpoint', 'T-0004', '--step', 'x']).code, 2);
  assert.equal(runCli(root, ['checkpoint', 'T-0002']).code, 2); // --step required
});

test('release: blocked needs a reason; done/blocked/todo clear the lease', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  const noReason = runCli(root, ['release', 'T-0002', '--status', 'blocked']);
  assert.equal(noReason.code, 2);
  assert.match(noReason.stderr, /reason/);
  assert.equal(runCli(root, ['release', 'T-0002', '--status', 'weird']).code, 2);
  const r = runCli(root, ['release', 'T-0002', '--status', 'blocked', '--reason', 'needs human approval of golden posting']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardField(root, 'T-0002', 'status'), 'blocked');
  assert.equal(cardField(root, 'T-0002', 'blocked_reason'), 'needs human approval of golden posting');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), 'null');
  const s = readState(root);
  assert.equal(s.current_task, null);
  assert.equal(s.lease_expires_at, null);
  assert.equal(s.claimed_by, null);

  runCli(root, ['claim', 'T-0004', '--provider', 'codex'], at(T0));
  assert.equal(runCli(root, ['release', 'T-0004', '--status', 'todo']).code, 0);
  assert.equal(cardField(root, 'T-0004', 'status'), 'todo');
  assert.equal(cardField(root, 'T-0004', 'claimed_by'), 'null');
  runCli(root, ['claim', 'T-0004', '--provider', 'codex'], at(T0));
  assert.equal(runCli(root, ['release', 'T-0004', '--status', 'done']).code, 0);
  assert.equal(cardField(root, 'T-0004', 'status'), 'done');
  assert.equal(cardField(root, 'T-0004', 'claimed_by'), 'codex');
});

test('handover writes the §10.5 template from state + card and keeps the Log', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  writeFileSync(join(root, 'a.txt'), 'a');
  runCli(root, ['checkpoint', 'T-0002', '--step', 'first green step'], at(T0));
  const r = runCli(root, ['handover', '--reason', 'credit limit reached'], at('2026-10-24T05:30:00.000Z'));
  assert.equal(r.code, 0, r.stderr);
  const h = readText(root, '.agent/HANDOVER.md');
  assert.match(h, /^# Handover - 2026-10-24 05:30 UTC$/m);
  assert.match(h, /^From: claude .*Reason: credit limit reached$/m);
  assert.match(h, /^Task: T-0002 Ledger tables$/m);
  assert.match(h, /^Branch: main\s+Last green commit: [0-9a-f]{7,}$/m);
  assert.match(h, /^Done: .*1\. Migration for journal tables/m);
  assert.match(h, /^In progress: .*2\. Deferred balance constraint trigger/m);
  for (const k of ['Next action:', 'Decisions taken:', 'Open questions for human:', 'Do not:']) assert.ok(h.includes(k), k);
  assert.match(h, /## Log[\s\S]*first green step/);
  assert.match(h, /## Log[\s\S]*handover: credit limit reached/);
});

test('handover works with no active task and no git remote/network', () => {
  const root = makeRepo();
  const r = runCli(root, ['handover', '--reason', 'end of day']);
  assert.equal(r.code, 0, r.stderr);
  const h = readText(root, '.agent/HANDOVER.md');
  assert.match(h, /^Task: none/m);
  assert.equal(runCli(root, ['handover']).code, 2); // --reason required
});

test('status prints state, lease, counts and next task', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  const r = runCli(root, ['status'], at(T0));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Current task: T-0002/);
  assert.match(r.stdout, /Lease: claude until 2026-10-24T05:45:00.000Z/);
  assert.match(r.stdout, /todo: 2/);
  assert.match(r.stdout, /claimed: 1/);
  assert.match(r.stdout, /done: 1/);
  assert.match(r.stdout, /Next claimable: T-0004/);
});

test('lease-check lists expired leases with exit 1, none with exit 0', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  const ok = runCli(root, ['lease-check'], at('2026-10-24T05:10:00.000Z'));
  assert.equal(ok.code, 0);
  const bad = runCli(root, ['lease-check'], at('2026-10-24T07:00:00.000Z'));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /T-0002.*claude.*2026-10-24T05:45:00.000Z/);
});

test('lint-backlog passes on the fixture and fails on a broken card', () => {
  const root = makeRepo();
  assert.equal(runCli(root, ['lint-backlog']).code, 0);
  writeFileSync(join(root, '.agent/backlog/T-0020.md'), '---\nid: T-0020\ntitle: x\nstatus: todo\ndepends_on: [T-0404]\n---\n');
  const r = runCli(root, ['lint-backlog']);
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /T-0404/);
});

test('unknown subcommand prints usage and exits 1; help exits 0', () => {
  const root = makeRepo();
  const r = runCli(root, ['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
  assert.equal(runCli(root, ['help']).code, 0);
  assert.ok(!exists(root, '.agent/HANDOVER.md'));
});

// ---- status model alignment (AGENTS.md §3): researching / in_progress / verifying / review ----

test('set-status moves through in-flight statuses keeping (and renewing) the lease', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  for (const st of ['researching', 'in_progress', 'verifying']) {
    const r = runCli(root, ['set-status', 'T-0002', st], at('2026-10-24T05:10:00.000Z'));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(cardField(root, 'T-0002', 'status'), st);
    assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), '2026-10-24T05:55:00.000Z');
    assert.equal(readState(root).current_task, 'T-0002');
  }
  assert.equal(runCli(root, ['set-status', 'T-0002', 'wibble']).code, 2);
  assert.equal(runCli(root, ['set-status', 'T-0002', 'blocked']).code, 2); // needs --reason
  // done/todo/blocked via set-status behave like release
  assert.equal(runCli(root, ['set-status', 'T-0002', 'blocked', '--reason', 'waiting on ADR']).code, 0);
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), 'null');
  assert.equal(readState(root).current_task, null);
});

test('release accepts verifying and review, clears the lease and keeps the builder', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  const r = runCli(root, ['release', 'T-0002', '--status', 'review'], at(T0));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardField(root, 'T-0002', 'status'), 'review');
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'claude');
  assert.equal(cardField(root, 'T-0002', 'lease_expires_at'), 'null');
  assert.equal(readState(root).current_task, null);
});

test('a card in review can only be claimed by the other provider; claimed_by stays the builder', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  runCli(root, ['release', 'T-0002', '--status', 'review'], at(T0));
  const self = runCli(root, ['claim', 'T-0002', '--provider', 'claude'], at(T0));
  assert.equal(self.code, 2);
  assert.match(self.stderr, /cross-review|own work/i);
  const r = runCli(root, ['claim', 'T-0002', '--provider', 'codex'], at(T0));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cardField(root, 'T-0002', 'status'), 'review');
  assert.equal(cardField(root, 'T-0002', 'claimed_by'), 'claude');
  assert.equal(cardField(root, 'T-0002', 'reviewer'), 'codex');
  assert.equal(readState(root).claimed_by, 'codex');
});
