// Tests for the shell entry points: resume.sh, verify.sh, checkpoint.sh, handover.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo, runBash, runCli, git, readText, cardField } from './helpers.ts';

test('resume.sh prints every section of the context pack', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude']);
  mkdirSync(join(root, '.agent/runs'), { recursive: true });
  writeFileSync(join(root, '.agent/runs/2026-10-24-claude-r01.log'), 'line-a\nlast-run-tail-marker\n');
  const r = runBash(root, 'resume.sh');
  assert.equal(r.code, 0, r.stderr);
  const o = r.stdout;
  for (const h of ['HANDOVER', 'STATE', 'ACTIVE TASK', 'BACKLOG', 'OPEN RESEARCH', 'RECENT DECISIONS', 'LAST RUN LOG', 'GIT LOG', 'GIT STATUS']) {
    assert.match(o, new RegExp(`=== ${h}`), `section ${h}`);
  }
  assert.match(o, /"current_task": "T-0002"/);
  assert.match(o, /## Goal\nCreate the journal tables\./); // full active card
  assert.match(o, /T-0004/); // next claimable
  assert.match(o, /RQ-0001-open-question\.md/);
  assert.doesNotMatch(o, /RQ-0002-resolved/);
  assert.match(o, /DL-0002 — Second decision/);
  assert.match(o, /last-run-tail-marker/);
  assert.match(o, /initial/); // git log
  assert.match(o, /T-0002\.md/); // git status --short shows the modified card
});

test('resume.sh survives an empty directory that is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-empty-'));
  const r = runBash(dir, 'resume.sh');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /=== HANDOVER[\s\S]*\(missing\)/);
  assert.match(r.stdout, /=== GIT LOG/);
});

test('verify.sh --quick: unavailable gates are PENDING, not PASS, and do not fail', () => {
  const root = makeRepo();
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /GATE 1 typecheck: NOT YET AVAILABLE \(no /);
  assert.match(r.stdout, /PENDING/);
  assert.match(r.stdout, /GATE 10 backlog-consistency: PASS/);
  assert.match(r.stdout, /GATE 11 no-delete: PASS/);
  assert.match(r.stdout, /GATE 12 no-skip: PASS/);
  assert.match(r.stdout, /SUMMARY/);
  assert.doesNotMatch(r.stdout, /typecheck\s*\|\s*PASS/);
});

test('verify.sh fails the no-skip guard on skipped/focused tests', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'packages/ledger/test'), { recursive: true });
  // built by concatenation so this test file itself never trips the guard
  writeFileSync(join(root, 'packages/ledger/test/balance.test.ts'), "it" + ".sk" + "ip('balances', () => {});\n");
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 12 no-skip: FAIL/);
  assert.match(r.stdout, /balance\.test\.ts/);
});

test('verify.sh fails the no-delete guard on a deleted tracked file (working tree, staged or committed)', () => {
  const root = makeRepo();
  unlinkSync(join(root, 'Docs/research/RQ-0002-resolved.md'));
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 11 no-delete: FAIL/);
  assert.match(r.stdout, /RQ-0002-resolved\.md/);

  // committed on a branch relative to main
  const root2 = makeRepo();
  git(root2, 'checkout', '-q', '-b', 'feat/T-0002-x');
  git(root2, 'rm', '-q', 'Docs/research/RQ-0002-resolved.md'); // temp repo only
  git(root2, 'commit', '-q', '-m', 'oops');
  const r2 = runBash(root2, 'verify.sh', ['--quick']);
  assert.equal(r2.code, 1, r2.stdout);
  assert.match(r2.stdout, /GATE 11 no-delete: FAIL/);
});

test('verify.sh fails the secrets scan on a committed key pattern', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'leak.ts'), `const k = "AKIA${'ABCDEFGHIJKLMNOP'}";\n`);
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 9 security: FAIL/);
  assert.match(r.stdout, /leak\.ts/);
});

test('verify.sh fails backlog consistency on a broken card', () => {
  const root = makeRepo();
  writeFileSync(join(root, '.agent/backlog/T-0030.md'), '---\nid: T-0030\ntitle: x\nstatus: todo\ndepends_on: [T-0404]\n---\n');
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /GATE 10 backlog-consistency: FAIL/);
});

test('verify.sh runs a package.json gate when its tooling exists', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' } }));
  mkdirSync(join(root, 'node_modules'));
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.match(r.stdout, /GATE 1 typecheck: PASS/);
  assert.match(r.stdout, /GATE 2 lint: FAIL/);
  assert.equal(r.code, 1);
});

test('checkpoint.sh and handover.sh wrap the conductor', () => {
  const root = makeRepo();
  runCli(root, ['claim', 'T-0002', '--provider', 'claude']);
  writeFileSync(join(root, 'w.txt'), 'w');
  const c = runBash(root, 'checkpoint.sh', ['human step']);
  assert.equal(c.code, 0, c.stderr + c.stdout);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'wip(T-0002): human step');
  assert.equal(cardField(root, 'T-0002', 'last_checkpoint'), git(root, 'rev-parse', 'HEAD'));
  const h = runBash(root, 'handover.sh', ['going home']);
  assert.equal(h.code, 0, h.stderr);
  assert.match(readText(root, '.agent/HANDOVER.md'), /Reason: going home/);
});
