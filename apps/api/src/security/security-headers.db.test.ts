/**
 * T-0142 AC-1, AC-2 — REST security headers on every API response and strict CORS (ADR-0054,
 * RQ-0141 F1–F3; OWASP REST Security Cheat Sheet "Security Headers" and "CORS").
 */
import 'reflect-metadata';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let tdb: TestDatabase;
let api: Api;
let https: Api;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
  https = await createApi({ databaseUrl: tdb.url('lf_app'), security: { hsts: true } });
});
afterAll(async () => {
  await api.close();
  await https.close();
  await tdb.close();
});

const BASELINE: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

function expectBaseline(res: Response): void {
  const got = Object.fromEntries(Object.keys(BASELINE).map((h) => [h, res.headers.get(h)]));
  expect(got).toEqual(BASELINE);
  expect(res.headers.get('x-powered-by')).toBeNull();
}

describe('T-0142 AC-1 security headers on every API response (ADR-0054 rule 1–2)', () => {
  it('AC-1 a public route (GET /health, 200) carries the OWASP REST header set [T-0142]', async () => {
    const res = await fetch(`${api.url}/health`);
    expect(res.status).toBe(200);
    expectBaseline(res);
  });

  it('AC-1 an authenticated route refused without credentials (401) carries it too [T-0142]', async () => {
    const res = await fetch(`${api.url}/auth/me`);
    expect(res.status).toBe(401);
    expectBaseline(res);
  });

  it('AC-1 an unknown route (404) carries it too [T-0142]', async () => {
    const res = await fetch(`${api.url}/no-such-route`);
    expect(res.status).toBe(404);
    expectBaseline(res);
  });

  it('AC-1 a refused mutation (POST without credentials) carries it too [T-0142]', async () => {
    const res = await fetch(`${api.url}/auth/logout`, { method: 'POST' });
    expect(res.status).toBe(401);
    expectBaseline(res);
  });

  it('AC-1 HSTS only when the public URL is https (max-age one year, no preload) [T-0142]', async () => {
    const plain = await fetch(`${api.url}/health`);
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const tls = await fetch(`${https.url}/health`);
    expectBaseline(tls);
    expect(tls.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});

describe('T-0142 AC-2 strict CORS: cross-origin access is never granted (ADR-0054 rule 3)', () => {
  it('AC-2 a preflight from another origin gets no Access-Control-Allow-* header [T-0142]', async () => {
    const res = await fetch(`${api.url}/auth/logout`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const cors = [...res.headers.keys()].filter((h) => h.startsWith('access-control-'));
    expect(cors).toEqual([]);
  });

  it('AC-2 a simple cross-origin GET gets no Access-Control-Allow-Origin [T-0142]', async () => {
    const res = await fetch(`${api.url}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
