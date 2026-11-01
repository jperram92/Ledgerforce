/**
 * Batch billing preview over HTTP (T-0043, UC-02, DL-0271): POST /ar/batches/preview needs
 * ar.batch.run and an idempotency key, returns money as decimal strings and replays; the stored
 * preview is readable with ar.read. Real PostgreSQL (lf_app), real sessions.
 */
import 'reflect-metadata';
import { addBillingLine } from '@ledgerforce/ar';
import { createDb, withTenant } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { generateFiscalYear } from '@ledgerforce/ledger';
import { seedPostingProfiles, setPartyProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const A = '01900000-0000-7000-8000-0000000043a1';
const uid = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PEOPLE = {
  arClerk: { id: uid(0x43a1), roles: ['ar_clerk'] },
  auditor: { id: uid(0x43a2), roles: ['auditor'] },
  approver: { id: uid(0x43a3), roles: ['approver'] },
} as const;
type Who = keyof typeof PEOPLE;

let tdb: TestDatabase;
let api: Api;
let companyId = '';
const cookies = new Map<string, string>();

async function call(method: string, path: string, who: Who, body?: unknown, key?: string) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (key) h['idempotency-key'] = key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  tdb = await createTestDatabase({ migrate: true });
  await tdb.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [A, 'Harbour Co']);
  for (const [who, p] of Object.entries(PEOPLE)) {
    await tdb.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, A, `${who}@batch.test`, who],
    );
    for (const role of p.roles) {
      await tdb.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [A, p.id, role],
      );
    }
  }
  const seed = createDb(tdb.url('lf_app'), 1);
  companyId = await withTenant(seed, A, async (trx) => {
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Harbour Co', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
    await generateFiscalYear(trx, { companyId: c.id, convention: 'AU', startYear: 2026 });
    await seedTaxCodes(trx, c.id);
    const profiles = await seedPostingProfiles(trx, c.id, auServicesSmb, chart.accounts);
    for (const name of ['Acme', 'Bolt']) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: c.id, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_role')
        .values({ company_id: c.id, party_id: p.id, role: 'customer' })
        .execute();
      await setPartyProfiles(trx, c.id, p.id, {
        customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
      });
      const ct = await trx
        .insertInto('app.party_contact')
        .values({
          company_id: c.id,
          party_id: p.id,
          name: 'Accounts',
          email: `ap@${name.toLowerCase()}.test`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_contact_role')
        .values({ company_id: c.id, party_id: p.id, contact_id: ct.id, role: 'billing_to' })
        .execute();
      await addBillingLine(trx, c.id, {
        partyId: p.id,
        productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
        description: 'Subscription November 2026',
        quantity: '1',
        unitPrice: '250.00',
        billDate: '2026-11-01',
      });
    }
    return c.id;
  });
  await seed.destroy();
  api = await createApi({ databaseUrl: tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(PEOPLE)) {
    cookies.set(
      who,
      await api.sessions.create(A, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 120_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (tdb as TestDatabase | undefined)?.close();
});

const body = () => ({ company_id: companyId, period_from: '2026-11-01', period_to: '2026-11-30' });

describe('SS-UC02-01 / SS-UC02-07: batch preview over HTTP', () => {
  it('SS-UC02-07 an Auditor (no ar.batch.run) is refused 403 naming the permission', async () => {
    const res = await call('POST', '/ar/batches/preview', 'auditor', body(), 'nov-audit');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ar.batch.run' });
  });

  it('requires an idempotency key', async () => {
    const res = await call('POST', '/ar/batches/preview', 'arClerk', body());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'idempotency_key_required' });
  });

  it('SS-UC02-01 the AR Clerk previews November: one row per account, decimal-string totals; a replay returns the same batch', async () => {
    const res = await call('POST', '/ar/batches/preview', 'arClerk', body(), 'nov-2026');
    expect(res.status).toBe(201);
    const p = (await res.json()) as {
      id: string;
      replayed: boolean;
      items: { party_name: string; gross: string; warnings: unknown[] }[];
      totals: Record<string, unknown>;
    };
    expect(p.replayed).toBe(false);
    expect(p.items.map((i) => [i.party_name, i.gross, i.warnings])).toEqual([
      ['Acme Pty Ltd', '275.0000', []],
      ['Bolt Pty Ltd', '275.0000', []],
    ]);
    expect(p.totals).toEqual({
      invoices: 2,
      ready: 2,
      net: '500.0000',
      tax: '50.0000',
      gross: '550.0000',
    });
    const again = await call('POST', '/ar/batches/preview', 'arClerk', body(), 'nov-2026');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: p.id, replayed: true });
    const read = await call('GET', `/ar/batches/${p.id}?company_id=${companyId}`, 'auditor');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: p.id, totals: p.totals });
  });

  it('refuses an invalid period with 422 and a body naming the problem', async () => {
    const res = await call(
      'POST',
      '/ar/batches/preview',
      'arClerk',
      { company_id: companyId, period_from: '2026-11-30', period_to: '2026-11-01' },
      'bad-period',
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'INVALID_BATCH' });
  });

  it('SS-UC02-02 approval needs ar.batch.approve: the AR Clerk is refused, the Approver approves once', async () => {
    const created = await call('POST', '/ar/batches/preview', 'arClerk', body(), 'nov-2026');
    const { id } = (await created.json()) as { id: string };
    const clerk = await call(
      'POST',
      `/ar/batches/${id}/approve?company_id=${companyId}`,
      'arClerk',
    );
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'ar.batch.approve' });
    const ok = await call('POST', `/ar/batches/${id}/approve?company_id=${companyId}`, 'approver');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id, status: 'approved' });
    const again = await call(
      'POST',
      `/ar/batches/${id}/approve?company_id=${companyId}`,
      'approver',
    );
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ error: 'BATCH_STATE' });
  });
});
