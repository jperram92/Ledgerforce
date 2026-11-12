import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Node application runtime applies available OS patches before dropping privileges [T-0057]', () => {
  const dockerfile = readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8');
  const runtime = dockerfile.split(/FROM .* AS node-runtime\r?\n/)[1]?.split(/^FROM /m)[0];
  assert.ok(runtime, 'shared node-runtime stage exists');
  const upgrade = runtime.search(/\bapk upgrade --no-cache\b/);
  const unprivileged = runtime.indexOf('USER node');
  assert.ok(
    upgrade >= 0 && upgrade < unprivileged,
    'install available OS patches before USER node',
  );
  for (const target of ['api', 'worker', 'setup']) {
    assert.match(dockerfile, new RegExp(`^FROM node-runtime AS ${target}$`, 'm'));
  }
});
