import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, updateFrontmatter } from '../lib/frontmatter.ts';

const CARD = `---
id: T-0042
title: Posting engine - balance trigger
depends_on: [T-0038]
status: todo               # todo | claimed | done
claimed_by: null
attempts: 2
---
## Goal
Body text: with colons.
---
not frontmatter
`;

test('parseFrontmatter splits data and body', () => {
  const fm = parseFrontmatter(CARD);
  assert.equal(fm.data.id, 'T-0042');
  assert.deepEqual(fm.data.depends_on, ['T-0038']);
  assert.equal(fm.data.status, 'todo');
  assert.equal(fm.data.attempts, 2);
  assert.ok(fm.body.startsWith('## Goal'));
  assert.ok(fm.body.includes('not frontmatter'));
});

test('parseFrontmatter rejects files without frontmatter', () => {
  assert.throws(() => parseFrontmatter('# just markdown\n'), /frontmatter/);
  assert.throws(() => parseFrontmatter('---\nid: x\nno close\n'), /frontmatter/);
});

test('updateFrontmatter replaces in place, keeps comments and body, appends new keys', () => {
  const out = updateFrontmatter(CARD, {
    status: 'claimed', claimed_by: 'claude', attempts: 3, lease_expires_at: '2026-11-02T04:30:00Z',
  });
  assert.match(out, /^status: claimed\s+# todo \| claimed \| done$/m);
  assert.match(out, /^claimed_by: claude$/m);
  assert.match(out, /^attempts: 3$/m);
  assert.match(out, /^lease_expires_at: 2026-11-02T04:30:00Z$/m);
  const fm = parseFrontmatter(out);
  assert.equal(fm.data.status, 'claimed');
  assert.equal(fm.data.lease_expires_at, '2026-11-02T04:30:00Z');
  assert.equal(fm.data.title, 'Posting engine - balance trigger');
  assert.equal(fm.body, parseFrontmatter(CARD).body);
  // the new key goes inside the frontmatter, before the closing fence
  assert.ok(out.indexOf('lease_expires_at') < out.indexOf('## Goal'));
});

test('updateFrontmatter quotes values that need it', () => {
  const out = updateFrontmatter(CARD, { blocked_reason: 'needs human: golden # posting' });
  assert.equal(parseFrontmatter(out).data.blocked_reason, 'needs human: golden # posting');
});
