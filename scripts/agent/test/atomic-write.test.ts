// Card, state and handover files are read by the agent's own conductor commands while the running
// conductor rewrites them (lease renewal, deferred checkpoints). A truncate-then-write lets a
// concurrent reader see an empty file ("missing frontmatter"); under load that failed a provider
// run and triggered a needless relaunch (2026-10-24). Writes must be atomic: temp file + rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/util.ts';

test('writeFileAtomic replaces content and leaves no temp files behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-atomic-'));
  const f = join(dir, 'T-0001.md');
  writeFileSync(f, 'old');
  writeFileAtomic(f, '---\nid: T-0001\n---\nnew');
  assert.equal(readFileSync(f, 'utf8'), '---\nid: T-0001\n---\nnew');
  assert.deepEqual(readdirSync(dir), ['T-0001.md']);
});

test('a concurrent reader never sees a partial or empty file while writes are in progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-atomic-'));
  const f = join(dir, 'T-0002.md');
  const body = `---\nid: T-0002\nstatus: in_progress\n---\n${'x'.repeat(200_000)}\n`;
  writeFileAtomic(f, body);
  // A separate process reads in a tight loop and reports any read that is not a whole file.
  const reader = spawn(process.execPath, ['-e', `
    const fs = require('fs'); let bad = 0, reads = 0; const end = Date.now() + 1500;
    while (Date.now() < end) { reads++; const t = fs.readFileSync(${JSON.stringify(f)}, 'utf8');
      if (!t.startsWith('---\\n') || !t.endsWith('\\n')) bad++; }
    process.stdout.write(JSON.stringify({ bad, reads }));`]);
  let out = '';
  reader.stdout.on('data', (d: Buffer) => { out += String(d); });
  const done = new Promise<void>((r) => reader.on('close', () => r()));
  const end = Date.now() + 1500;
  let writes = 0;
  while (Date.now() < end) {
    writeFileAtomic(f, body.replace('in_progress', writes % 2 ? 'verifying' : 'in_progress'));
    writes++;
    await new Promise((r) => setImmediate(r));
  }
  await done;
  const { bad, reads } = JSON.parse(out) as { bad: number; reads: number };
  assert.ok(reads > 100 && writes > 100, `too few iterations to be meaningful (reads ${reads}, writes ${writes})`);
  assert.equal(bad, 0, `${bad} of ${reads} reads saw a partial file`);
});
