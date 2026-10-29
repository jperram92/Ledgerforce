// Explicit Docker regression command: node --test tests/install/setup-wait.test.mjs
// Execute the actual smoke runner's setup section against real disposable services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const source = readFileSync(join(root, 'infra/compose/smoke.sh'), 'utf8');
const section = source.slice(
  source.indexOf('# setup is one-shot:'),
  source.indexOf('echo "--- waiting for api'),
);
assert.ok(section.includes('setup_status'), 'locate the actual setup wait section');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

for (const scenario of [
  { name: 'already-stopped success', code: 0, start: true, expected: 0 },
  { name: 'already-stopped failure', code: 7, start: true, expected: 1 },
  { name: 'missing setup', code: 0, start: false, expected: 1 },
]) {
  test(`${scenario.name} is handled safely [T-0113]`, () => {
    const work = mkdtempSync(join(tmpdir(), 'lf-setup-wait-'));
    const project = `lf-wait-${process.pid}-${scenario.code}-${scenario.start}`;
    const file = join(work, 'compose.yaml');
    writeFileSync(
      file,
      `services:\n  setup:\n    image: postgres:17\n    entrypoint: ["sh", "-c"]\n    command: ["echo 'One-time password: synthetic-test-marker'; exit ${scenario.code}"]\n`,
    );
    const compose = ['compose', '-p', project, '-f', file];
    const docker = (...args) => {
      const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.error}`);
      return result.stdout.trim();
    };
    try {
      if (scenario.start) {
        docker(...compose, 'up', '-d');
        const id = docker(...compose, 'ps', '-a', '-q', 'setup');
        assert.equal(docker('wait', id), String(scenario.code), 'fixture must already be stopped');
      }
      const command = `set -euo pipefail\ncompose=(${['docker', ...compose].map(quote).join(' ')})\nwork=${quote(work.replaceAll('\\', '/'))}\n${section}`;
      const result = spawnSync(bash, ['-c', command], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /synthetic-test-marker/,
        'never disclose setup password',
      );
      if (scenario.code !== 0)
        assert.match(result.stderr, /setup exited with 7/, 'report actual container exit');
    } finally {
      // Only this uniquely named disposable project; no user volumes or existing services.
      docker(...compose, 'down');
    }
  });
}
