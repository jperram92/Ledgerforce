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
  assert.match(r.stdout, /GATE 12 memory: PASS/);
  assert.match(r.stdout, /GATE 11 no-delete: PASS/);
  assert.match(r.stdout, /GATE 10 no-shortcuts: PASS/);
  assert.match(r.stdout, /GATE 2b db-tests: SKIPPED/);
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
  assert.match(r.stdout, /GATE 10 no-shortcuts: FAIL/);
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
  assert.match(r.stdout, /GATE 7 security: FAIL/);
  assert.match(r.stdout, /leak\.ts/);
});

test('verify.sh fails backlog consistency on a broken card', () => {
  const root = makeRepo();
  writeFileSync(join(root, '.agent/backlog/T-0030.md'), '---\nid: T-0030\ntitle: x\nstatus: todo\ndepends_on: [T-0404]\n---\n');
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /GATE 12 memory: FAIL/);
});

test('verify.sh runs a package.json gate when its tooling exists', () => {
  const root = makeRepo();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' } }));
  mkdirSync(join(root, 'node_modules'));
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.match(r.stdout, /GATE 1 typecheck: PASS/);
  assert.match(r.stdout, /GATE 1 lint: FAIL/);
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

// ---- definition-of-done alignment (Docs/process/definition-of-done.md gates 1–12) ----

function tickAll(root: string, status = 'verifying'): void {
  const p = join(root, '.agent/backlog/T-0002.md');
  writeFileSync(p, readText(root, '.agent/backlog/T-0002.md').replace(/- \[ \]/g, '- [x]').replace(/^status: todo/m, `status: ${status}`).replace(/^claimed_by: null/m, 'claimed_by: claude'));
}

test('gate review: PENDING without a report, PASS with a non-builder PASS, FAIL on FAIL, self-review ignored', () => {
  const root = makeRepo();
  tickAll(root, 'review');
  assert.equal(runCli(root, ['gate', 'review', 'T-0002']).code, 10);
  mkdirSync(join(root, '.agent/evidence/T-0002'), { recursive: true });
  writeFileSync(join(root, '.agent/evidence/T-0002/review-claude-20261024-050000.md'), '# Cross-review T-0002 — PASS\n');
  assert.equal(runCli(root, ['gate', 'review', 'T-0002']).code, 10, 'self-review does not count');
  writeFileSync(join(root, '.agent/evidence/T-0002/review-codex-20261024-060000.md'), '# Cross-review T-0002 — FAIL\n');
  assert.equal(runCli(root, ['gate', 'review', 'T-0002']).code, 1);
  writeFileSync(join(root, '.agent/evidence/T-0002/review-codex-20261024-070000.md'), '# Cross-review T-0002 — PASS\n\nOverall verdict: **PASS**\n');
  const r = runCli(root, ['gate', 'review', 'T-0002']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /review-codex-20261024-070000\.md/);
});

test('gate memory: unticked steps, wrong status, open linked RQ and missing HANDOVER fail', () => {
  const root = makeRepo();
  const r1 = runCli(root, ['gate', 'memory', 'T-0002']);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /unticked step/i);
  assert.match(r1.stdout, /status "todo"/);
  tickAll(root);
  writeFileSync(join(root, '.agent/HANDOVER.md'), '# Handover\n');
  assert.equal(runCli(root, ['gate', 'memory', 'T-0002']).code, 0, runCli(root, ['gate', 'memory', 'T-0002']).stdout);
  const p = join(root, '.agent/backlog/T-0002.md');
  writeFileSync(p, readText(root, '.agent/backlog/T-0002.md').replace('adr_required: false', 'adr_required: false\nresearch: [RQ-0001, RQ-0002]'));
  const r2 = runCli(root, ['gate', 'memory', 'T-0002']);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /RQ-0001.*open/);
  assert.doesNotMatch(r2.stdout, /RQ-0002/);
});

test('gate evidence: each success scenario needs a passed manifest entry whose file exists', () => {
  const root = makeRepo();
  assert.equal(runCli(root, ['gate', 'evidence', 'T-0002']).code, 1); // SS-01 and no manifest
  assert.equal(runCli(root, ['gate', 'evidence', 'T-0004']).code, 0); // no scenarios on card
  const dir = join(root, '.agent/evidence/T-0002');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'shot.png'), 'png');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [
    { scenario: 'SS-01', file: '.agent/evidence/T-0002/shot.png', result: 'failed' },
  ] }));
  assert.equal(runCli(root, ['gate', 'evidence', 'T-0002']).code, 1);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ entries: [
    { scenario: 'SS-01', file: '.agent/evidence/T-0002/shot.png', result: 'failed' },
    { scenario: 'SS-01', file: '.agent/evidence/T-0002/shot.png', result: 'passed' },
  ] }));
  assert.equal(runCli(root, ['gate', 'evidence', 'T-0002']).code, 0);
});

test('verify.sh (full): migration DROP/RENAME grep fails gate 6', () => {
  const root = makeRepo();
  git(root, 'checkout', '-q', '-b', 'feat/T-0002-ledger-tables');
  mkdirSync(join(root, 'packages/db/migrations'), { recursive: true });
  writeFileSync(join(root, 'packages/db/migrations/0002_x.sql'), '-- we never DROP anything (comment is fine)\nALTER TABLE journal RENAME COLUMN a TO b;\n');
  const r = runBash(root, 'verify.sh');
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 6 migrations-forward: FAIL/);
  assert.match(r.stdout, /0002_x\.sql:2/);
  assert.doesNotMatch(r.stdout, /0002_x\.sql:1/);
});

test('verify.sh (full): a change under Docs/accounting versus main fails gate 4', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'Docs/accounting'), { recursive: true });
  writeFileSync(join(root, 'Docs/accounting/postings.md'), '# Golden\n- **Status: Approved (JP, 2026-10-24)** GP-01\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'golden');
  git(root, 'checkout', '-q', '-b', 'feat/T-0002-ledger-tables');
  writeFileSync(join(root, 'Docs/accounting/postings.md'), '# Golden\n- **Status: Approved (JP, 2026-10-24)** GP-01 changed\n');
  const r = runBash(root, 'verify.sh');
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 4 golden-postings: FAIL/);
  assert.match(r.stdout, /Docs\/accounting\/postings\.md/);
});

test('verify.sh (full) with a task: review PENDING, memory and evidence FAIL, 2c coverage reported', () => {
  const root = makeRepo();
  const r = runBash(root, 'verify.sh', ['--task', 'T-0002']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 8 cross-review: NOT YET AVAILABLE/);
  assert.match(r.stdout, /GATE 12 memory: FAIL/);
  assert.match(r.stdout, /GATE 9 e2e-evidence: FAIL/);
  assert.match(r.stdout, /GATE 2c coverage: NOT YET AVAILABLE/);
  for (const g of ['1 typecheck', '1 lint', '1 format', '2a unit-tests', '2b db-tests', '2c coverage', '3 accounting-invariants',
    '4 golden-postings', '5 cross-tenant-rls', '6 migrations-forward', '7 security', '8 cross-review', '9 e2e-evidence',
    '10 no-shortcuts', '11 no-delete', '12 memory']) assert.match(r.stdout, new RegExp(`GATE ${g}:`), g);
});

test('verify.sh --quick: lowered numRuns and unlogged suppressions in the diff fail gate 10', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'packages/ledger/src'), { recursive: true });
  writeFileSync(join(root, 'packages/ledger/src/a.prop.test.ts'), 'fc.assert(p, { numRuns: 10 });\n');
  const r = runBash(root, 'verify.sh', ['--quick']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 10 no-shortcuts: FAIL/);
  assert.match(r.stdout, /numRuns/);
  const root2 = makeRepo();
  mkdirSync(join(root2, 'packages/ledger/src'), { recursive: true });
  writeFileSync(join(root2, 'packages/ledger/src/b.ts'), '// eslint' + '-disable-next-line no-console\nconsole.log(1);\n// eslint' + '-disable-next-line no-console -- DL-0042\nconsole.log(2);\n');
  const r2 = runBash(root2, 'verify.sh', ['--quick']);
  assert.equal(r2.code, 1, r2.stdout);
  assert.match(r2.stdout, /b\.ts:1/);
  assert.doesNotMatch(r2.stdout, /b\.ts:3/);
});
