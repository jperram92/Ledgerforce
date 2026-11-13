// Tests for the shell entry points: resume.sh, verify.sh, checkpoint.sh, handover.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
  const { packageManager } = JSON.parse(readText(join(import.meta.dirname, '../../..'), 'package.json'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    packageManager,
    scripts: { typecheck: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' },
  }));
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

test('verify.sh (full): no false positives — protective TRUNCATE triggers, string literals, non-migration .sql, instructional golden text', () => {
  const root = makeRepo();
  mkdirSync(join(root, 'Docs/accounting'), { recursive: true });
  writeFileSync(join(root, 'Docs/accounting/postings.md'), '# Golden\n- **Status: Draft** GP-01\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'golden draft');
  git(root, 'checkout', '-q', '-b', 'feat/T-0002-ledger-tables');
  writeFileSync(join(root, 'Docs/accounting/postings.md'),
    '# Golden\n> Approval: _pending_ — the product owner changes `Status: Draft` to `Status: Approved (initials, date)`.\n- **Status: Draft** GP-01 amended\n');
  mkdirSync(join(root, 'packages/db/migrations'), { recursive: true });
  writeFileSync(join(root, 'packages/db/migrations/0003_audit.sql'), [
    "CREATE FUNCTION no_trunc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TRUNCATE on % is forbidden', TG_TABLE_NAME; END $$;",
    'CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit.audit_log FOR EACH STATEMENT EXECUTE FUNCTION no_trunc();',
    '',
  ].join('\n'));
  mkdirSync(join(root, 'Docs/research/assets'), { recursive: true });
  writeFileSync(join(root, 'Docs/research/assets/probe.sql'), 'TRUNCATE ledger.journal_line;\n');
  const r = runBash(root, 'verify.sh');
  assert.match(r.stdout, /GATE 4 golden-postings: (PASS|NOT YET AVAILABLE)/, r.stdout);
  assert.match(r.stdout, /Draft-only changes/);
  assert.doesNotMatch(r.stdout, /GATE 6 migrations-forward: FAIL/, r.stdout);
  // but a real TRUNCATE / DROP statement in a migration still fails
  writeFileSync(join(root, 'packages/db/migrations/0004_bad.sql'), 'TRUNCATE ledger.journal_line;\nALTER TABLE x DROP COLUMN y;\n');
  const r2 = runBash(root, 'verify.sh');
  assert.match(r2.stdout, /GATE 6 migrations-forward: FAIL/);
  assert.match(r2.stdout, /0004_bad\.sql:1/);
  assert.match(r2.stdout, /0004_bad\.sql:2/);
});

// ---- gate 2c: unit+db coverage measure (T-0128, RQ-0105 remedy 2, DL-0408) ----------------------
// A temp repo with @vitest/coverage-v8 "installed" and a fake pnpm on PATH that records how it was
// called and writes a coverage summary with the given line percentage. main's baseline is optional;
// branchBaseline, when given, is committed on the task branch (it must never be used as the base).
function coverageRepo(mainBaseline: object | null, pct: number, branchBaseline?: object) {
  const root = makeRepo();
  mkdirSync(join(root, 'node_modules/@vitest/coverage-v8'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  if (mainBaseline) writeFileSync(join(root, '.agent/coverage-baseline.json'), JSON.stringify(mainBaseline, null, 2) + '\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'baseline on main');
  git(root, 'checkout', '-q', '-b', 'feat/T-0002-ledger-tables');
  if (branchBaseline) {
    writeFileSync(join(root, '.agent/coverage-baseline.json'), JSON.stringify(branchBaseline, null, 2) + '\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'baseline on branch');
  }
  const bin = mkdtempSync(join(tmpdir(), 'lf-fakebin-'));
  const log = join(bin, 'pnpm.log');
  writeFileSync(join(bin, 'pnpm'), [
    '#!/usr/bin/env bash',
    'echo "ARGS $* WORKERS=${VITEST_MAX_WORKERS:-unset}" >> "$FAKE_PNPM_LOG"',
    'case " $* " in',
    '  *" exec vitest run "*)',
    '    for a in "$@"; do case "$a" in --coverage.reportsDirectory=*) d="${a#--coverage.reportsDirectory=}";; esac; done',
    '    mkdir -p "$d"',
    '    p="$FAKE_COV_PCT"',
    '    printf \'{"total":{"lines":{"pct":%s},"branches":{"pct":%s},"functions":{"pct":%s},"statements":{"pct":%s}}}\' "$p" "$p" "$p" "$p" > "$d/coverage-summary.json"',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(log, '');
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, FAKE_PNPM_LOG: log, FAKE_COV_PCT: String(pct), VITEST_MAX_WORKERS: '8' };
  return { root, env, log };
}
const unitDbBaseline = (pct: number) => ({
  measure: 'unit+db', recorded: '2026-11-13', total: { lines: { pct }, branches: { pct }, functions: { pct }, statements: { pct } },
});

test('verify.sh (full) with a task: 2c coverage measures unit+db with one worker and passes against a unit+db main baseline', () => {
  const { root, env, log } = coverageRepo(unitDbBaseline(93.5), 94.1);
  const r = runBash(root, 'verify.sh', ['--task', 'T-0002'], env);
  assert.match(r.stdout, /GATE 2c coverage: PASS \(unit\+db lines 94\.1% vs main 93\.5%\)/, r.stdout);
  const calls = readFileSync(log, 'utf8');
  // the measure is pinned: both projects, coverage on, one worker even if the caller set more
  assert.match(calls, /ARGS -s exec vitest run --project unit --project db --coverage\.enabled .*WORKERS=1$/m, calls);
});

test('verify.sh (full) with a task: 2c coverage fails when unit+db lines drop below the unit+db main baseline', () => {
  const { root, env } = coverageRepo(unitDbBaseline(93.95), 93.7);
  const r = runBash(root, 'verify.sh', ['--task', 'T-0002'], env);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /GATE 2c coverage: FAIL \(unit\+db lines 93\.7% < main 93\.95%\)/, r.stdout);
});

test('verify.sh (full) with a task: 2c coverage is PENDING, never PASS, when main\'s baseline was taken with another measure', () => {
  // Legacy main baseline (no "measure" field = the old unit-only measure). Current is higher and the
  // branch already carries a re-recorded unit+db baseline, but the branch file is never the base.
  const legacy = { note: 'unit-test coverage baseline', recorded: '2026-10-24', total: { lines: { pct: 72.22 } } };
  const a = coverageRepo(legacy, 94.1, unitDbBaseline(94.1));
  const r = runBash(a.root, 'verify.sh', ['--task', 'T-0002'], a.env);
  assert.match(r.stdout, /GATE 2c coverage: NOT YET AVAILABLE \(unit\+db lines 94\.1% — main baseline measure is "unit", not "unit\+db": re-record \.agent\/coverage-baseline\.json on main with the unit\+db measure; no comparison across measures\)/, r.stdout);
  assert.doesNotMatch(r.stdout, /GATE 2c coverage: (PASS|FAIL)/);

  // an explicit other measure, even with a base the current number would fail against, is PENDING too
  const b = coverageRepo({ measure: 'unit', recorded: '2026-10-24', total: { lines: { pct: 99 } } }, 94.1);
  const r2 = runBash(b.root, 'verify.sh', ['--task', 'T-0002'], b.env);
  assert.match(r2.stdout, /GATE 2c coverage: NOT YET AVAILABLE \(unit\+db lines 94\.1% — main baseline measure is "unit", not "unit\+db"/, r2.stdout);
  assert.doesNotMatch(r2.stdout, /GATE 2c coverage: (PASS|FAIL)/);
});

test('verify.sh (full) with a task: 2c coverage is PENDING without a main baseline', () => {
  const { root, env } = coverageRepo(null, 94.1, unitDbBaseline(94.1));
  const r = runBash(root, 'verify.sh', ['--task', 'T-0002'], env);
  assert.match(r.stdout, /GATE 2c coverage: NOT YET AVAILABLE \(unit\+db lines 94\.1% — no baseline \.agent\/coverage-baseline\.json on main yet\)/, r.stdout);
});
