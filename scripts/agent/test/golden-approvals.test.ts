import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, git, readText } from './helpers.ts';
import { makeCtx } from '../lib/commands.ts';
import { goldenGuard } from '../lib/gates.ts';

const path = 'Docs/accounting/postings.md';
const approved = '# Golden\n- **Status: Approved (owner)**\nDr AR 110.00 / Cr Sales 100.00 / Cr GST 10.00\n';
function fixture() {
  const root = makeRepo();
  git(root, 'checkout', '-q', '-b', 'feat/T-0121-test');
  mkdirSync(join(root, 'Docs/accounting'), { recursive: true });
  writeFileSync(join(root, path), approved);
  writeFileSync(join(root, 'Docs/decisions/decision-log.md'), readText(root, 'Docs/decisions/decision-log.md') + '\n### DL-9999 — Owner approval\n- By: human. Approves the fixture golden posting.\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'owner-approved fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  const record = { path, commit, decisions: ['DL-9999'] };
  const write = (approvals: unknown = [record]) => writeFileSync(join(root, 'Docs/decisions/golden-approvals.json'), JSON.stringify({ schemaVersion: 1, approvals }));
  write();
  return { root, record, write, check: () => goldenGuard(makeCtx(root)) };
}

test('explicit ancestor approval allows exactly the approved content [T-0121]', () => {
  const f = fixture();
  assert.equal(f.check().result, 'PASS');
  writeFileSync(join(f.root, path), approved.replaceAll('\n', '\r\n'));
  assert.equal(f.check().result, 'PASS', 'checkout CRLF is not an accounting change');
});

test('approval does not allow an amount mutation or trailing content [T-0121]', () => {
  const f = fixture();
  for (const text of [approved.replace('110.00', '111.00'), approved + ' ']) {
    writeFileSync(join(f.root, path), text);
    const result = f.check();
    assert.equal(result.result, 'FAIL');
    assert.match(result.lines.join('\n'), /approved snapshot/i);
  }
});

test('a missing protected file fails even when changedFiles excludes deletion [T-0121]', () => {
  const f = fixture();
  unlinkSync(join(f.root, path)); // disposable fixture only
  assert.equal(f.check().result, 'FAIL');
});

test('missing decision evidence and malformed commit fail closed [T-0121]', () => {
  const f = fixture();
  for (const record of [{ ...f.record, decisions: ['DL-9998'] }, { ...f.record, decisions: [] }, { ...f.record, commit: 'HEAD' }]) {
    f.write([record]);
    assert.equal(f.check().result, 'FAIL');
  }
});

test('approval from an unrelated branch is not evidence for this HEAD [T-0121]', () => {
  const f = fixture();
  git(f.root, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(f.root, 'other.txt'), 'other');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-q', '-m', 'other branch');
  const other = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'checkout', '-q', 'feat/T-0121-test');
  f.write([{ ...f.record, commit: other }]);
  assert.equal(f.check().result, 'FAIL');
});

test('malformed registry fails even when there are no accounting changes [T-0121]', () => {
  const f = fixture();
  git(f.root, 'checkout', '-q', 'main');
  writeFileSync(join(f.root, 'Docs/decisions/golden-approvals.json'), '{broken');
  assert.equal(f.check().result, 'FAIL');
});

test('duplicate paths, traversal paths, and unknown schema versions fail [T-0121]', () => {
  const f = fixture();
  f.write([f.record, f.record]);
  assert.equal(f.check().result, 'FAIL');
  f.write([{ ...f.record, path: 'Docs/accounting/../decisions/decision-log.md' }]);
  assert.equal(f.check().result, 'FAIL');
  writeFileSync(join(f.root, 'Docs/decisions/golden-approvals.json'), JSON.stringify({ schemaVersion: 2, approvals: [] }));
  assert.equal(f.check().result, 'FAIL');
});

test('an approved file outside the registry is still rejected [T-0121]', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'Docs/accounting/unapproved.md'), approved);
  assert.equal(f.check().result, 'FAIL');
});

test('a new snapshot cannot recycle an earlier decision to approve changed amounts [T-0121]', () => {
  const f = fixture();
  writeFileSync(join(f.root, path), approved.replace('110.00', '111.00'));
  git(f.root, 'add', path);
  git(f.root, 'commit', '-q', '-m', 'unapproved mutation');
  f.write([{ ...f.record, commit: git(f.root, 'rev-parse', 'HEAD') }]);
  assert.equal(f.check().result, 'FAIL');
});

test('records cannot override the existing protection of Approved content on main [T-0121]', () => {
  const f = fixture();
  git(f.root, 'checkout', '-q', 'main');
  git(f.root, 'merge', '-q', '--ff-only', 'feat/T-0121-test');
  git(f.root, 'checkout', '-q', 'feat/T-0121-test');
  writeFileSync(join(f.root, path), approved.replace('110.00', '111.00'));
  writeFileSync(join(f.root, 'Docs/decisions/decision-log.md'), readText(f.root, 'Docs/decisions/decision-log.md') + '\n### DL-9998 — New approval claim\n');
  git(f.root, 'add', path, 'Docs/decisions/decision-log.md');
  git(f.root, 'commit', '-q', '-m', 'attempt to edit Approved content');
  f.write([{ ...f.record, commit: git(f.root, 'rev-parse', 'HEAD'), decisions: ['DL-9998'] }]);
  assert.equal(f.check().result, 'FAIL');
});

test('missing parent evidence cannot be treated as proof that a decision is new [T-0121]', () => {
  const f = fixture();
  git(f.root, 'checkout', '-q', '--orphan', 'without-history');
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-q', '-m', 'root snapshot has no parent evidence');
  f.write([{ ...f.record, commit: git(f.root, 'rev-parse', 'HEAD') }]);
  assert.equal(f.check().result, 'FAIL');
});
