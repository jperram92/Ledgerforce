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
  // The owner merges the approval record to main (the comparison base); the feature branch
  // then integrates main, so the record is present, unchanged, at the merge-base (review C6).
  git(root, 'checkout', '-q', 'main');
  write();
  git(root, 'add', 'Docs/decisions/golden-approvals.json');
  git(root, 'commit', '-q', '-m', 'owner merges approval record');
  git(root, 'checkout', '-q', 'feat/T-0121-test');
  git(root, 'merge', '-q', '--no-edit', 'main');
  return { root, record, write, check: () => goldenGuard(makeCtx(root)) };
}

/** A feature branch that adds an Approved posting and a DL entry claiming owner approval, with no record on main. */
function selfApproval() {
  const root = makeRepo();
  git(root, 'checkout', '-q', '-b', 'feat/T-0999-self');
  mkdirSync(join(root, 'Docs/accounting'), { recursive: true });
  writeFileSync(join(root, path), approved);
  writeFileSync(join(root, 'Docs/decisions/decision-log.md'), readText(root, 'Docs/decisions/decision-log.md') + '\n### DL-9999 — Owner approval\n- By: human (claimed by agent).\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'agent self-approval');
  const record = { path, commit: git(root, 'rev-parse', 'HEAD'), decisions: ['DL-9999'] };
  writeFileSync(join(root, 'Docs/decisions/golden-approvals.json'), JSON.stringify({ schemaVersion: 1, approvals: [record] }));
  return { root, record, check: () => goldenGuard(makeCtx(root)) };
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

test('a branch-added record citing a branch-added decision cannot self-approve (review C6) [T-0121]', () => {
  const f = selfApproval();
  for (const commitRecord of [false, true]) {
    if (commitRecord) {
      git(f.root, 'add', 'Docs/decisions/golden-approvals.json');
      git(f.root, 'commit', '-q', '-m', 'agent commits its own approval record');
    }
    const result = f.check();
    assert.equal(result.result, 'FAIL', commitRecord ? 'committed on the branch' : 'uncommitted');
    const text = result.lines.join('\n');
    assert.match(text, /adds an Approved status — only the product owner approves golden postings/);
    assert.match(text, /new approval records require the product owner's merge to main/);
  }
});

test('a record present on the base still allows exactly the approved content only (review C6) [T-0121]', () => {
  const f = fixture();
  const result = f.check();
  assert.equal(result.result, 'PASS');
  assert.match(result.lines.join('\n'), /1 content-bound approved snapshot/);
  writeFileSync(join(f.root, path), approved.replace('110.00', '111.00'));
  assert.equal(f.check().result, 'FAIL', 'a base record never approves different content');
});

test('a base record modified on the branch no longer suppresses the guard (review C6) [T-0121]', () => {
  const f = fixture();
  // Re-anchor the same path to a new branch commit that introduces a branch-added decision.
  writeFileSync(join(f.root, path), approved + 'Draft note appended on the branch.\n');
  writeFileSync(join(f.root, 'Docs/decisions/decision-log.md'), readText(f.root, 'Docs/decisions/decision-log.md') + '\n### DL-9997 — Owner approval of the refreshed snapshot\n- By: human (claimed by agent).\n');
  git(f.root, 'add', path, 'Docs/decisions/decision-log.md');
  git(f.root, 'commit', '-q', '-m', 'agent refreshes the approved snapshot');
  const modified = { ...f.record, commit: git(f.root, 'rev-parse', 'HEAD'), decisions: ['DL-9997'] };
  for (const commitRecord of [false, true]) {
    f.write([modified]);
    if (commitRecord) {
      git(f.root, 'add', 'Docs/decisions/golden-approvals.json');
      git(f.root, 'commit', '-q', '-m', 'agent edits the approval record');
    }
    const result = f.check();
    assert.equal(result.result, 'FAIL', commitRecord ? 'committed on the branch' : 'uncommitted');
    const text = result.lines.join('\n');
    assert.match(text, /adds an Approved status — only the product owner approves golden postings/);
    assert.match(text, /new approval records require the product owner's merge to main/);
  }
});
