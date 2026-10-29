import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, readText } from './helpers.ts';
import { makeCtx } from '../lib/commands.ts';
import { memoryGate } from '../lib/gates.ts';

function check(status: string, steps: string) {
  const root = makeRepo();
  writeFileSync(join(root, '.agent/HANDOVER.md'), 'Test handover\n');
  const path = '.agent/backlog/T-0002.md';
  let card = readText(root, path).replace(/^status:.*$/m, `status: ${status}`);
  card = card.replace(/^research:.*$/m, 'research: []');
  card = card.replace(/^## Steps[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/m, `## Steps\n${steps}\n\n`);
  writeFileSync(join(root, path), card);
  return memoryGate(makeCtx(root), 'T-0002');
}

const implementation = '- [x] 1. Implementation tested';
const pending = '\n- [ ] 2. Verify [phase: verify]\n- [ ] 3. Cross-provider review [phase: review]\n- [ ] 4. Handover [phase: finish]';

test('verifying permits explicitly marked current and later workflow steps [T-0010]', () => {
  const result = check('verifying', implementation + pending);
  assert.equal(result.result, 'PASS', result.lines.join('\n'));
});
test('review requires completed verification but permits review and finish [T-0010]', () => {
  const result = check('review', implementation + pending.replace('[ ] 2.', '[x] 2.'));
  assert.equal(result.result, 'PASS', result.lines.join('\n'));
  assert.equal(check('review', implementation + pending).result, 'FAIL');
});
test('done requires every workflow step completed [T-0010]', () => {
  assert.equal(check('done', implementation + pending).result, 'FAIL');
  const result = check('done', implementation + pending.replaceAll('[ ]', '[x]'));
  assert.equal(result.result, 'PASS', result.lines.join('\n'));
});
test('implementation and unmarked steps remain mandatory during verification [T-0010]', () => {
  assert.equal(check('verifying', '- [ ] 1. Implementation' + pending).result, 'FAIL');
  assert.equal(check('verifying', implementation + '\n- [ ] 2. Cross-provider review').result, 'FAIL');
});
test('unknown and non-terminal phase markers cannot waive a step [T-0010]', () => {
  assert.equal(check('verifying', implementation + '\n- [ ] 2. Work [phase: future]').result, 'FAIL');
  assert.equal(check('verifying', implementation + '\n- [ ] 2. Work [phase: finish] still implementing').result, 'FAIL');
});
