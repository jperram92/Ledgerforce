// Opt-in real DAST contract tests (ADR-0044 rule 5, T-0096); Docker required, no mocked scanner.
// A disposable local HTTP server is the target: a deliberately insecure page must produce a High
// alert and fail the gate (exit 1), a clean page must pass (exit 0), and an unreachable target
// must fail closed (exit 2). The ZAP JSON field names the gate relies on are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const root = resolve(import.meta.dirname, '../..');
const runner = join(root, 'scripts/security/scan.mjs');
const out = () => mkdtempSync(join(tmpdir(), 'lf-dast-'));

function scan(url, dir) {
  const result = spawnSync(process.execPath, [runner, 'dast', url, dir], {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
  });
  assert.equal(result.error, undefined, 'the scan must complete rather than time out');
  return result;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolvePort(port));
    });
  });
}

/** A child-process HTTP server (spawnSync blocks this process, so it cannot serve itself). */
async function serve(body, headers) {
  const port = await freePort();
  const code = `
    const http = require('node:http');
    const body = ${JSON.stringify(body)};
    const headers = ${JSON.stringify(headers)};
    http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    }).listen(${port}, '127.0.0.1', () => console.log('ready'));`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ready, fail) => {
    child.stdout.once('data', ready);
    child.once('exit', (c) => fail(new Error(`fixture server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

const SECURE_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=()',
};

test('SS-PLAT-101 DAST fails on a High alert and lists it', async () => {
  // Disposable fixture text, not real data: a well-known test card number (PII Disclosure) and a
  // sample bcrypt hash (Hash Disclosure) — both High-risk passive rules in ZAP.
  const page =
    '<html><head><title>fixture</title></head><body>' +
    '<p>Card 4111 1111 1111 1111</p>' +
    '<p>$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy</p>' +
    '</body></html>';
  const server = await serve(page, SECURE_HEADERS);
  try {
    const dir = out();
    const result = scan(server.url, dir);
    assert.equal(
      result.status,
      1,
      `expected the gate to fail:\n${result.stdout}\n${result.stderr}`,
    );
    const report = JSON.parse(readFileSync(join(dir, 'zap.json'), 'utf8'));
    const alerts = report.site.flatMap((s) => s.alerts);
    assert.ok(
      alerts.some((a) => a.riskcode === '3'),
      'the report must contain a High (riskcode "3") alert',
    );
    for (const a of alerts) {
      assert.equal(typeof a.pluginid, 'string');
      assert.equal(typeof a.alert, 'string');
      assert.ok(Array.isArray(a.instances));
    }
    assert.match(result.stdout, /security: dast High /);
    assert.ok(existsSync(join(dir, 'zap.html')), 'an HTML report is kept as an artifact');
  } finally {
    server.stop();
  }
});

test('SS-PLAT-101 DAST passes a clean page (Medium/Low are reported, not gated)', async () => {
  const server = await serve(
    '<html><head><title>ok</title></head><body>ok</body></html>',
    SECURE_HEADERS,
  );
  try {
    const dir = out();
    const result = scan(server.url, dir);
    assert.equal(
      result.status,
      0,
      `expected the gate to pass:\n${result.stdout}\n${result.stderr}`,
    );
    const report = JSON.parse(readFileSync(join(dir, 'zap.json'), 'utf8'));
    assert.ok(Array.isArray(report.site));
    assert.match(result.stdout, /security: dast counts /);
  } finally {
    server.stop();
  }
});

test('SS-PLAT-101 DAST fails closed when the target cannot be reached or the URL is invalid', async () => {
  const port = await freePort(); // nothing listens here
  assert.equal(scan(`http://127.0.0.1:${port}/`, out()).status, 2);
  assert.equal(scan('file:///etc/passwd', out()).status, 2);
});
