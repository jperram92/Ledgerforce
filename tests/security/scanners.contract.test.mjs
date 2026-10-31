// Opt-in real scanner tests; Docker required. No mocked scanners or real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(result.error, undefined, 'scanner must complete rather than time out');
  return result;
}
function report(out, name) {
  return JSON.parse(readFileSync(join(out, name), 'utf8'));
}

test('SS-PLAT-18 SAST fails on unsafe code and succeeds on clean code', () => {
  const target = fixture();
  writeFileSync(
    join(target, 'unsafe.js'),
    'export function execute(input) { return eval(input); }',
  );
  const bad = fixture();
  assert.equal(run('sast', target, bad).status, 1);
  assert.ok(report(bad, 'semgrep.json').results.length > 0);
  writeFileSync(
    join(target, 'unsafe.js'),
    'export function execute(input) { return JSON.parse(input); }',
  );
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
  assert.ok(
    ![raw, result.stdout, result.stderr].some((value) => value.includes(synthetic)),
    'secret must be redacted',
  );
  writeFileSync(join(target, 'settings.txt'), 'public_setting = "ordinary"');
  assert.equal(run('secrets', target, fixture()).status, 0);
});

test('SS-PLAT-18 history scan fails on a secret committed then removed, and redacts it', () => {
  const repo = fixture();
  const git = (...args) => {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
  };
  git('init', '-q');
  // Generated non-authentic text in a disposable repository, never a real token.
  const synthetic = ['ghp', randomBytes(18).toString('hex')].join('_');
  writeFileSync(join(repo, 'settings.txt'), `github_token = "${synthetic}"`);
  git('add', '.');
  git('commit', '-qm', 'seed');
  writeFileSync(join(repo, 'settings.txt'), 'public_setting = "ordinary"');
  git('commit', '-qam', 'remove');
  const out = fixture();
  const result = run('history', repo, out);
  assert.equal(result.status, 1);
  const raw = readFileSync(join(out, 'gitleaks.json'), 'utf8');
  assert.ok(JSON.parse(raw).length > 0);
  assert.ok(
    ![raw, result.stdout, result.stderr].some((value) => value.includes(synthetic)),
    'secret must be redacted',
  );
  assert.equal(run('secrets', repo, fixture()).status, 0, 'the working tree alone is clean');
});

// Syft catalogs directory sources from declared lockfiles; installed node_modules/*/package.json
// is catalogued only for image sources (`syft cataloger list`, DL-0243). The fixture is a lockfile.
function vulnerableLockfileFixture() {
  const target = fixture();
  writeFileSync(
    join(target, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0', dependencies: { lodash: '4.17.20' } },
        'node_modules/lodash': {
          version: '4.17.20',
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
        },
      },
    }),
  );
  return target;
}

test('SS-PLAT-18 inventory is real CycloneDX listing the seeded package', () => {
  const out = fixture();
  assert.equal(run('sbom', vulnerableLockfileFixture(), out).status, 0);
  const inventory = report(out, 'sbom.cdx.json');
  assert.equal(inventory.bomFormat, 'CycloneDX');
  assert.ok(inventory.components.some((c) => c.name === 'lodash' && c.version === '4.17.20'));
});

test('SS-PLAT-18 vulnerable packages in the inventory fail the high-severity gate', () => {
  const out = fixture();
  assert.equal(run('sbom', vulnerableLockfileFixture(), out).status, 0);
  assert.equal(run('vulnerabilities', join(out, 'sbom.cdx.json'), out).status, 1);
  assert.ok(
    report(out, 'grype.json').matches.some((m) =>
      ['High', 'Critical'].includes(m.vulnerability.severity),
    ),
  );
});

test('SS-PLAT-18 malformed scanner configuration and missing input fail closed', () => {
  const target = fixture();
  writeFileSync(join(target, 'clean.js'), 'export const safe = 1;');
  const malformed = join(fixture(), 'rules.yml');
  writeFileSync(malformed, 'rules: [broken');
  assert.notEqual(run('sast', target, fixture(), ['--rules', malformed]).status, 0);
  assert.notEqual(run('sbom', join(target, 'absent'), fixture()).status, 0);
});
