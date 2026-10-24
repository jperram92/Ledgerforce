import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCards, topoOrder, nextClaimable, lintBacklog, isLeaseActive } from '../lib/backlog.ts';
import { FIXTURES } from './helpers.ts';

function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'lf-backlog-'));
  cpSync(join(FIXTURES, 'repo'), root, { recursive: true });
  return root;
}

const NOW = Date.parse('2026-10-24T05:00:00Z');

test('loadCards reads only T-NNNN.md cards', () => {
  const cards = loadCards(join(fixtureCopy(), '.agent/backlog'));
  assert.deepEqual(cards.map((c) => c.id).sort(), ['T-0001', 'T-0002', 'T-0003', 'T-0004']);
});

test('topoOrder respects depends_on, ties broken by id', () => {
  const cards = loadCards(join(fixtureCopy(), '.agent/backlog'));
  assert.deepEqual(topoOrder(cards).map((c) => c.id), ['T-0001', 'T-0002', 'T-0003', 'T-0004']);
});

test('nextClaimable picks first todo whose deps are done', () => {
  const root = fixtureCopy();
  const cards = loadCards(join(root, '.agent/backlog'));
  assert.equal(nextClaimable(cards, NOW)?.id, 'T-0002');
  assert.deepEqual(nextClaimable(cards, NOW, 5).map((c) => c.id), ['T-0002', 'T-0004']);
});

test('a claimed card with an expired lease is claimable again; an unexpired one is not', () => {
  const root = fixtureCopy();
  const p = join(root, '.agent/backlog/T-0002.md');
  const cards = () => loadCards(join(root, '.agent/backlog'));
  const base = cards().find((c) => c.id === 'T-0002')!.text;
  writeFileSync(p, base.replace('status: todo', 'status: in_progress').replace('lease_expires_at: null', 'lease_expires_at: 2026-10-24T05:30:00Z'));
  assert.equal(nextClaimable(cards(), NOW)?.id, 'T-0004');
  assert.equal(isLeaseActive(cards().find((c) => c.id === 'T-0002')!, NOW), true);
  assert.equal(nextClaimable(cards(), Date.parse('2026-10-24T06:00:00Z'))?.id, 'T-0002');
});

test('lintBacklog passes on the fixture', () => {
  const root = fixtureCopy();
  assert.deepEqual(lintBacklog(root, '.agent/backlog'), []);
});

test('lintBacklog reports duplicate ids, missing deps, cycles, bad status, unknown scenarios, id/filename mismatch', () => {
  const root = fixtureCopy();
  const dir = join(root, '.agent/backlog');
  const card = (id: string, extra: string) => `---\nid: ${id}\ntitle: X\nstatus: todo\n${extra}\n---\n## Goal\n`;
  writeFileSync(join(dir, 'T-0010.md'), card('T-0010', 'depends_on: [T-0011]'));
  writeFileSync(join(dir, 'T-0011.md'), card('T-0011', 'depends_on: [T-0010]'));
  writeFileSync(join(dir, 'T-0012.md'), card('T-0012', 'depends_on: [T-9999]'));
  writeFileSync(join(dir, 'T-0013.md'), card('T-0002', 'depends_on: []'));
  writeFileSync(join(dir, 'T-0014.md'), card('T-0014', 'depends_on: []\nsuccess_scenarios: [SS-99]').replace('status: todo', 'status: wibble'));
  writeFileSync(join(dir, 'T-0015.md'), 'no frontmatter here\n');
  const errors = lintBacklog(root, '.agent/backlog').join('\n');
  assert.match(errors, /cycle/i);
  assert.match(errors, /T-0012.*T-9999/);
  assert.match(errors, /duplicate id T-0002/i);
  assert.match(errors, /T-0013\.md.*id T-0002 does not match/);
  assert.match(errors, /T-0014.*status "wibble"/);
  assert.match(errors, /T-0014.*SS-99/);
  assert.match(errors, /T-0015.*frontmatter/);
});

test('lintBacklog skips the scenario check when the register does not exist', () => {
  const root = fixtureCopy();
  writeFileSync(join(root, 'Docs/specs/success-scenarios.md'), '# empty\n');
  assert.match(lintBacklog(root, '.agent/backlog').join('\n'), /SS-01/);
  // missing register → no scenario errors
  const root2 = fixtureCopy();
  writeFileSync(join(root2, 'Docs/specs/success-scenarios.md'), '');
  cpSync(join(root2, 'Docs/specs/success-scenarios.md'), join(root2, 'Docs/specs/x.md'));
  const r3 = mkdtempSync(join(tmpdir(), 'lf-backlog-'));
  cpSync(join(FIXTURES, 'repo/.agent'), join(r3, '.agent'), { recursive: true });
  assert.deepEqual(lintBacklog(r3, '.agent/backlog'), []);
});
