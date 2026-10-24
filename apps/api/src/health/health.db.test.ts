import 'reflect-metadata';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let tdb: TestDatabase;
let api: Api;

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  api = await createApi({ databaseUrl: tdb.url('lf_app') });
});
afterAll(async () => {
  await api.close();
  await tdb.close();
});

describe('GET /health', () => {
  it('answers 200 with database status, without any tenant', async () => {
    const res = await fetch(`${api.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });
});
