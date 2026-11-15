/**
 * T-0161, ADR-0078 — the route-scoped JSON reader of the statement import route, below the
 * controller: a declared length over 10 MB and a chunked body over 10 MB are 413 (with the
 * security headers), a compressed body and a non-UTF-8 charset are 415, the ADR-0054 rate limit
 * answers 429 before the body is read, and other paths are left to Nest's 100 kB parser. The
 * requests carry no session, so a body that passes the reader ends at the tenant guard (401).
 */
import 'reflect-metadata';
import { request as httpRequest } from 'node:http';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';
import { STATEMENT_BODY_LIMIT } from './statement-body.ts';

let tdb: TestDatabase;
let api: Api;
let limited: Api;
let now = Date.UTC(2026, 10, 15, 9, 0, 0);
const PATH = '/bank-rec/accounts/01900000-0000-7000-8000-000000016101/statements';
const MB = 1024 * 1024;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
  limited = await createApi({
    databaseUrl: tdb.url('lf_app'),
    sessions: {},
    security: {
      rateLimits: { windowMs: 60_000, auth: 10, mutating: 1, webhook: 10 },
      now: () => now,
    },
  });
});
afterAll(async () => {
  await api.close();
  await limited.close();
  await tdb.close();
});

const jsonOf = (bytes: number): string =>
  JSON.stringify({ content_base64: 'A'.repeat(Math.max(0, bytes - 20)) });

/** A raw HTTP request, optionally chunked (no Content-Length), resolving to status and body. */
function raw(
  url: string,
  path: string,
  body: string | Buffer,
  headers: Record<string, string>,
  chunked = false,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: chunked ? headers : { ...headers, 'content-length': String(body.length) },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    // The server may close the connection after a 413 before the whole upload is written.
    req.on('error', (e) => (e.message.includes('EPIPE') ? undefined : reject(e)));
    if (chunked) {
      const buf = Buffer.from(body);
      for (let i = 0; i < buf.length; i += 256 * 1024) req.write(buf.subarray(i, i + 256 * 1024));
      req.end();
    } else {
      req.end(body);
    }
  });
}

describe('T-0161 ADR-0078: the statement import route reads JSON up to 10 MB, no further', () => {
  it('T-0161 the limit is 10 MB', () => {
    expect(STATEMENT_BODY_LIMIT).toBe(10 * MB);
  });

  it('T-0161 a body of 3 MB passes the reader and reaches the tenant guard (401)', async () => {
    const r = await raw(api.url, PATH, jsonOf(3 * MB), { 'content-type': 'application/json' });
    expect(r.status).toBe(401);
  });

  it('T-0161 a declared Content-Length over 10 MB is 413 payload_too_large with the security headers', async () => {
    const r = await raw(api.url, PATH, jsonOf(10 * MB + 1024), {
      'content-type': 'application/json',
    });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'payload_too_large' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['connection']).toBe('close');
  });

  it('T-0161 a chunked body (no Content-Length) over 10 MB is 413', async () => {
    const r = await raw(
      api.url,
      PATH,
      jsonOf(11 * MB),
      { 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked' },
      true,
    );
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: 'payload_too_large' });
  });

  it('T-0161 a compressed body is 415 and a non-UTF-8 charset is 415; JSON that is not an object or array is 400', async () => {
    const gz = await raw(api.url, PATH, jsonOf(1024), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });
    expect(gz.status).toBe(415);
    expect(JSON.parse(gz.body)).toEqual({ error: 'unsupported_content_encoding' });
    const latin = await raw(api.url, PATH, jsonOf(1024), {
      'content-type': 'application/json; charset=iso-8859-1',
    });
    expect(latin.status).toBe(415);
    expect(JSON.parse(latin.body)).toEqual({ error: 'unsupported_charset' });
    const scalar = await raw(api.url, PATH, '"just a string"', {
      'content-type': 'application/json',
    });
    expect(scalar.status).toBe(400);
    expect(JSON.parse(scalar.body)).toEqual({ error: 'invalid_json' });
  });

  it('T-0161 the upper-case spelling of the path is handled the same (Express routes case-insensitively)', async () => {
    const r = await raw(api.url, PATH.toUpperCase(), jsonOf(3 * MB), {
      'content-type': 'application/json',
    });
    expect(r.status).not.toBe(413);
  });

  it('T-0161 other paths keep Nest’s 100 kB parser: 200 kB to a sibling route is 413', async () => {
    const r = await raw(
      api.url,
      `${PATH.replace('/statements', '')}/matching-runs`,
      jsonOf(200 * 1024),
      {
        'content-type': 'application/json',
      },
    );
    expect(r.status).toBe(413);
  });

  it('T-0161 the ADR-0054 write rate limit answers 429 before the body is read', async () => {
    const first = await raw(limited.url, PATH, jsonOf(3 * MB), {
      'content-type': 'application/json',
    });
    expect(first.status).toBe(401);
    const second = await raw(limited.url, PATH, jsonOf(3 * MB), {
      'content-type': 'application/json',
    });
    expect(second.status).toBe(429);
    expect(JSON.parse(second.body)).toEqual({ error: 'rate_limited' });
    now += 60_000;
  });
});
