// Opt-in real scanner tests; Docker required. No mocked scanners or real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const runner = join(root, 'scripts/security/scan.mjs');
const fixture = () => mkdtempSync(join(tmpdir(), 'lf-security-fixture-'));
function run(kind, target, out, extra = []) {
  assert.ok(existsSync(runner), 'security runner must implement real scanner invocation');
  const result = spawnSync(process.execPath, [runner, kind, target, out, ...extra], {
    cwd: root, encoding: 'utf8', timeout: 300_000,
  });
  assert.equal(result.error, undefined, 'scanner must complete rather than time out');
  return result;
}
function report(out, name) { return JSON.parse(readFileSync(join(out, name), 'utf8')); }

test('SS-PLAT-18 SAST fails on unsafe code and succeeds on clean code', () => {
  const target = fixture();
  writeFileSync(join(target, 'unsafe.js'), 'export function execute(input) { return eval(input); }');
  const bad = fixture();
  assert.equal(run('sast', target, bad).status, 1);
  assert.ok(report(bad, 'semgrep.json').results.length > 0);
  writeFileSync(join(target, 'unsafe.js'), 'export function execute(input) { return JSON.parse(input); }');
  const good = fixture();
  assert.equal(run('sast', target, good).status, 0);
  assert.equal(report(good, 'semgrep.json').results.length, 0);
});

test('SS-PLAT-18 secret scan fails and redacts a generated synthetic token', () => {
  const target = fixture();
  // This is generated non-authentic text in a disposable fixture, never a real token.
  const synthetic = ['ghp', randomBytes(18).toString('hex')].join('_');
  writeFileSync(join(target, 'settings.txt'), `github_token = "${synthetic}"`);
  const out = fixture();
  const result = run('secrets', target, out);
  assert.equal(result.status, 1);
  const raw = readFileSync(join(out, 'gitleaks.json'), 'utf8');
  assert.ok(JSON.parse(raw).length > 0);
  assert.ok(![raw, result.stdout, result.stderr].some((value) => value.includes(synthetic)), 'secret must be redacted');
  writeFileSync(join(target, 'settings.txt'), 'public_setting = "ordinary"');
  assert.equal(run('secrets', target, fixture()).status, 0);
});

test('SS-PLAT-18 inventory is real CycloneDX and vulnerable packages fail', () => {
  const target = fixture();
  const packageDir = join(target, 'node_modules/lodash');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.20' }));
  const out = fixture();
  assert.equal(run('sbom', target, out).status, 0);
  const inventory = report(out, 'sbom.cdx.json');
  assert.equal(inventory.bomFormat, 'CycloneDX');
  assert.ok(inventory.components.some((c) => c.name === 'lodash' && c.version === '4.17.20'));
  assert.equal(run('vulnerabilities', join(out, 'sbom.cdx.json'), out).status, 1);
  assert.ok(report(out, 'grype.json').matches.some((m) => ['High', 'Critical'].includes(m.vulnerability.severity)));
});

test('SS-PLAT-18 malformed scanner configuration and missing input fail closed', () => {
  const target = fixture();
  writeFileSync(join(target, 'clean.js'), 'export const safe = 1;');
  const malformed = join(fixture(), 'rules.yml');
  writeFileSync(malformed, 'rules: [broken');
  assert.notEqual(run('sast', target, fixture(), ['--rules', malformed]).status, 0);
  assert.notEqual(run('sbom', join(target, 'absent'), fixture()).status, 0);
});
