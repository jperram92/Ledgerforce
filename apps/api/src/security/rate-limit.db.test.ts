/**
 * T-0142 AC-3, AC-4 — per-address rate limits on the auth routes, on every state-changing route
 * and on webhooks, answered with 429 + Retry-After before any handler runs (ADR-0054 rules 4–5,
 * RQ-0141 F4–F5). The test acts as nginx (one trusted hop) and names clients with
 * X-Forwarded-For; the window is driven by an injected clock.
 */
import 'reflect-metadata';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { Controller, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { Public } from '../tenancy/public.decorator.ts';

let handled = 0;

@Controller('t0142-probe')
class ProbeController {
  @Public()
  @Post('write')
  write(): { ok: true } {
    handled += 1;
    return { ok: true };
  }
}

let tdb: TestDatabase;
let api: Api;
let direct: Api;
let now = Date.UTC(2026, 10, 13, 9, 0, 0);
const LIMITS = { windowMs: 60_000, auth: 3, mutating: 2, webhook: 4 };

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  api = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    testControllers: [ProbeController],
    security: { trustProxyHops: 1, rateLimits: LIMITS, now: () => now },
  });
  // No trusted proxy: X-Forwarded-For must be ignored (every caller is its socket address).
  direct = await createApi({
    databaseUrl: tdb.url('lf_app'),
    testControllers: [ProbeController],
    security: { rateLimits: LIMITS, now: () => now },
  });
});
afterAll(async () => {
  await api.close();
  await direct.close();
  await tdb.close();
});

const from = (ip: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), 'X-Forwarded-For': ip },
});
const statuses = async (n: number, url: string, init: RequestInit): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await fetch(url, init)).status);
  return out;
};

describe('T-0142 AC-3 auth routes are limited per client address', () => {
  it('AC-3 the (N+1)-th step-up request in the window answers 429 rate_limited with Retry-After [T-0142]', async () => {
    const url = `${api.url}/auth/step-up`;
    expect(await statuses(3, url, from('203.0.113.1'))).toEqual([401, 401, 401]);
    now += 15_000;
    const res = await fetch(url, from('203.0.113.1'));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('retry-after')).toBe('45');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('AC-3 another client address is unaffected [T-0142]', async () => {
    expect((await fetch(`${api.url}/auth/step-up`, from('203.0.113.2'))).status).toBe(401);
  });

  it('AC-3 a forged left-most X-Forwarded-For entry does not escape the bucket [T-0142]', async () => {
    const res = await fetch(`${api.url}/auth/step-up`, from('198.51.100.9, 203.0.113.1'));
    expect(res.status).toBe(429);
  });

  it('AC-3 case and trailing-slash variants of an auth route share its bucket [T-0142]', async () => {
    for (const path of [
      '/AUTH/step-up',
      '/auth/step-up/',
      '/t/acme/auth/login',
      '/auth/callback',
    ]) {
      expect((await fetch(`${api.url}${path}`, from('203.0.113.1'))).status).toBe(429);
    }
  });

  it('AC-3 after the window the client is allowed again [T-0142]', async () => {
    now += 60_000;
    expect((await fetch(`${api.url}/auth/step-up`, from('203.0.113.1'))).status).toBe(401);
  });
});

describe('T-0142 AC-4 state-changing routes and webhooks are limited; reads are not', () => {
  it('AC-4 the (N+1)-th POST answers 429 before the handler runs [T-0142]', async () => {
    handled = 0;
    const url = `${api.url}/t0142-probe/write`;
    expect(await statuses(3, url, from('192.0.2.7', { method: 'POST' }))).toEqual([201, 201, 429]);
    expect(handled).toBe(2);
  });

  it('AC-4 PUT, PATCH and DELETE count against the same bucket [T-0142]', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${api.url}/t0142-probe/write`, from('192.0.2.7', { method }));
      expect(res.status).toBe(429);
    }
  });

  it('AC-4 GET reads are never limited [T-0142]', async () => {
    expect(await statuses(6, `${api.url}/health`, from('192.0.2.7'))).toEqual(
      Array<number>(6).fill(200),
    );
  });

  it('AC-4 webhooks have their own bucket: an exhausted mutating bucket does not block them [T-0142]', async () => {
    const url = `${api.url}/webhooks/stripe`;
    const got = await statuses(5, url, from('192.0.2.7', { method: 'POST' }));
    expect(got.slice(0, 4).every((s) => s !== 429)).toBe(true);
    expect(got[4]).toBe(429);
  });

  it('AC-4 without a trusted proxy X-Forwarded-For is ignored: rotating it does not reset the limit [T-0142]', async () => {
    handled = 0;
    const url = `${direct.url}/t0142-probe/write`;
    const got: number[] = [];
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      got.push((await fetch(url, from(ip, { method: 'POST' }))).status);
    }
    expect(got).toEqual([201, 201, 429]);
    expect(handled).toBe(2);
  });
});
