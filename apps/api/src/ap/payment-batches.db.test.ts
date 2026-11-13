/**
 * Payment batches on the real routes (T-0054, UC-06, design §6.5 rule 1, ADR-0025, DL-0291): the
 * AP Clerk builds a batch from 12 due bills (SS-UC06-01); the Clerk cannot release it
 * (SOD_BATCH_SELF_RELEASE, SS-UC06-02); a releaser without a fresh step-up gets step_up_required
 * and succeeds after re-authenticating (SS-UC06-03); a $25,000 batch is partially released by one
 * releaser and completed by a second, distinct one (SS-UC06-04); a supplier whose bank details were
 * verified 3 hours ago is excluded with BANK_DETAILS_COOLING_OFF (SS-UC06-05).
 * Real PostgreSQL as lf_app, real sessions; step-up is recorded on the session as the IdP
 * callback does (the IdP round trip itself is proven in authz/mfa-step-up.db.test.ts).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { seedPayablesCompany, type PayablesFixture } from '@ledgerforce/ap/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let api: Api;
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  apClerk: { id: randomUUID(), roles: ['ap_clerk', 'approver'] },
  releaserA: { id: randomUUID(), roles: ['approver'] },
  releaserB: { id: randomUUID(), roles: ['approver'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A session whose last (MFA) authentication was `ageMinutes` ago. */
async function login(who: string, ageMinutes: number) {
  if (!api.sessions) throw new Error('sessions not configured');
  cookies.set(
    who,
    await api.sessions.create(f.tenantId, {
      userId: people[who]?.id ?? '',
      amr: ['pwd', 'otp'],
      acr: null,
      authTime: new Date(Date.now() - ageMinutes * 60 * 1000),
    }),
  );
}

/** Step-up: a new MFA authentication recorded on the same session (as the IdP callback does). */
async function stepUp(who: string) {
  const sessionId = cookies.get(who)?.split('.')[1] ?? '';
  await f.inTenant(
    (trx) =>
      api.sessions?.reauthenticateInTx(trx, sessionId, {
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(),
      }) ?? Promise.resolve(),
  );
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005402');
  for (const [who, person] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [person.id, f.tenantId, `${who}@batches.test`, who],
    );
    for (const role of person.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, person.id, role],
      );
    }
  }
  p = await seedPayablesCompany(f);
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  await login('apClerk', 1);
  await login('releaserA', 30);
  await login('releaserB', 30);
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

const q = () => `company_id=${f.companyId}`;
const build = (id: string, dueBy: string) =>
  call('PUT', `/ap/payment-batches/${id}`, 'apClerk', {
    company_id: f.companyId,
    payment_date: dueBy,
    due_by: dueBy,
    account_id: f.acct['1010'],
  });
const release = (id: string, who: string) =>
  call('POST', `/ap/payment-batches/${id}/release?${q()}`, who);

const weekly = randomUUID();

describe('SS-UC06-01: Batch created from 12 due bills', () => {
  it('SS-UC06-01 the AP Clerk builds a batch of 12 payments totalling the 12 bills', async () => {
    for (let i = 1; i <= 12; i += 1) {
      const s = await p.addSupplier(`Weekly ${String(i)} Pty Ltd`, 72);
      await p.postBill(s, `W-${String(i)}`, '500.00', '2026-11-06');
    }
    const res = await build(weekly, '2026-11-06');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payments: unknown[] };
    expect(body).toMatchObject({
      id: weekly,
      status: 'draft',
      batch_no: expect.stringMatching(/^PB-/),
      payment_count: 12,
      total: '6000.0000',
      releases_required: 1,
      excluded: [],
    });
    expect(body.payments).toHaveLength(12);
    expect((await build(weekly, '2026-11-06')).status).toBe(200);
  });
});

describe('SS-UC06-02: Creator cannot release own batch', () => {
  it('SS-UC06-02 the Clerk who created the batch (fresh step-up) is denied with SOD_BATCH_SELF_RELEASE', async () => {
    const res = await release(weekly, 'apClerk');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_BATCH_SELF_RELEASE',
    });
    const got = await call('GET', `/ap/payment-batches/${weekly}?${q()}`, 'releaserA');
    expect(await got.json()).toMatchObject({ status: 'draft', releases: [] });
  });
});

describe('SS-UC06-03: Release requires step-up MFA', () => {
  it('SS-UC06-03 user B without a fresh step-up gets step_up_required; after step-up the release succeeds', async () => {
    const stale = await release(weekly, 'releaserA');
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    await stepUp('releaserA');
    const ok = await release(weekly, 'releaserA');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: 'released',
      releases: [{ released_by: people.releaserA?.id }],
    });
  });
});

describe('SS-UC06-04: Batch over $10,000 needs two releasers', () => {
  it('SS-UC06-04 a $25,000 batch is Partially released after one releaser; the same releaser cannot complete it; a second does', async () => {
    const s1 = await p.addSupplier('Large One Pty Ltd', 48);
    const s2 = await p.addSupplier('Large Two Pty Ltd', 48);
    await p.postBill(s1, 'L-1', '12500.00', '2026-11-20');
    await p.postBill(s2, 'L-2', '12500.00', '2026-11-20');
    const id = randomUUID();
    const created = await build(id, '2026-11-20');
    expect(await created.json()).toMatchObject({ total: '25000.0000', releases_required: 2 });
    const first = await release(id, 'releaserA');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'partially_released' });
    const twice = await release(id, 'releaserA');
    expect(twice.status).toBe(403);
    expect(await twice.json()).toMatchObject({ rule: 'SOD_BATCH_SAME_RELEASER' });
    await stepUp('releaserB');
    const second = await release(id, 'releaserB');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: 'released',
      releases: [{ released_by: people.releaserA?.id }, { released_by: people.releaserB?.id }],
    });
    expect((await release(id, 'apClerk')).status).toBe(403);
  });
});

describe('SS-UC06-05: Recently changed bank details excluded with reason', () => {
  it('SS-UC06-05 the supplier verified 3 hours ago is excluded with BANK_DETAILS_COOLING_OFF', async () => {
    const recent = await p.addSupplier('Just Changed Pty Ltd', 3);
    const settled = await p.addSupplier('Long Standing Pty Ltd', 100);
    const held = await p.postBill(recent, 'JC-1', '800.00', '2026-11-27');
    await p.postBill(settled, 'LS-1', '200.00', '2026-11-27');
    const res = await build(randomUUID(), '2026-11-27');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      payment_count: 1,
      total: '200.0000',
      excluded: [
        {
          bill_id: held,
          party_id: recent,
          amount: '800.0000',
          reason: 'BANK_DETAILS_COOLING_OFF',
          payable_from: expect.any(String),
        },
      ],
    });
  });

  it('a malformed request is refused before anything is written', async () => {
    const res = await call('PUT', `/ap/payment-batches/${randomUUID()}`, 'apClerk', {
      company_id: f.companyId,
      payment_date: '2026-11-30',
      due_by: '2026-11-30',
      account_id: f.acct['6230'],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'INVALID_BATCH' });
  });
});
