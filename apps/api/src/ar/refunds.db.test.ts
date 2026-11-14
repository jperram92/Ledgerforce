/**
 * Customer refunds over HTTP (T-0152, UC-11, SS-UC11-08 refund half, ADR-0074, DL-0477 item 3),
 * real PostgreSQL (lf_app) and real sessions:
 *   PUT  /ar/refunds/:id                          — ar.refund.create, SoD refund.create, replay 200
 *   POST /ar/refunds/:id/approve?company_id=      — ar.refund.approve, SoD refund.approve
 *   GET  /ar/refunds/:id[/journal]?company_id=    — ar.read; the journal is GP-006, writes nothing
 *   GET  /ar/parties/:id/credit?company_id=       — ar.read
 * The creator may not approve (SOD_REFUND_SELF_APPROVAL); another tenant's party or refund is 404;
 * money is a decimal string. The preview is compared line for line with the Approved GP-006.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createCustomerRefund,
  createDraftInvoice,
  recordReceipt,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp006 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-006',
);

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let acme = '';
let beta = '';
let foreignParty = '';
let foreignRefund = '';
const codeOf: Record<string, string> = {};
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  auditor: { id: randomUUID(), roles: ['auditor'] },
  apClerk: { id: randomUUID(), roles: ['ap_clerk'] },
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

/** GP-001 invoice paid in full, then GP-005's 220.00 credit note: `party` holds a 220.00 credit. */
async function creditOf220(fx: LedgerFixture, prefix: string, count = 1) {
  const profiles = await seedBillingCompany(fx);
  const parties = await seedBillableCustomers(fx, profiles, {
    count,
    prefix,
    billDate: '2026-11-01',
  });
  const outbox = { publish: async () => {} };
  for (const party of parties) {
    await fx.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: fx.companyId,
          partyId: party,
          issueDate: '2026-11-05',
          lines: [
            {
              productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
              description: 'Professional services',
              quantity: '1',
              unitPrice: '1250.00',
            },
          ],
        },
        { outbox },
      );
      const inv = await approveInvoice(
        trx,
        { companyId: fx.companyId, invoiceId: d.invoiceId },
        { outbox },
      );
      await recordReceipt(trx, {
        companyId: fx.companyId,
        partyId: party,
        receiptDate: '2026-11-10',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: fx.acct['1010'] ?? '' },
        idempotencyKey: `seed-${party}`,
        allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
      });
      const cn = await createCreditNote(trx, {
        companyId: fx.companyId,
        invoiceId: inv.invoiceId,
        id: randomUUID(),
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      await approveCreditNote(trx, { companyId: fx.companyId, creditNoteId: cn.creditNoteId });
    });
  }
  return parties;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000015201');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000015202');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@refund.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  [acme = '', beta = ''] = await creditOf220(f, 'Acme', 2);
  [foreignParty = ''] = await creditOf220(other, 'Elsewhere');
  foreignRefund = (
    await other.inTenant((trx) =>
      createCustomerRefund(trx, {
        companyId: other.companyId,
        id: randomUUID(),
        partyId: foreignParty,
        refundDate: '2026-11-24',
        amount: '220.00',
        method: 'bank_batch',
      }),
    )
  ).refundId;
  await f.inTenant(async (trx) => {
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['bank:OPERATING'] = '1010';
  });
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 240_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

const body = (party: string, amount: string) => ({
  company_id: f.companyId,
  party_id: party,
  refund_date: '2026-11-24',
  amount,
  method: 'bank_batch',
  reason: 'Customer asked for the credit back',
});
const q = () => `company_id=${f.companyId}`;
const entries = async () =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1',
      [f.tenantId],
    )
  ).rows[0]?.n;

describe('SS-UC11-08: refund of the customer credit, approved by another person, journal shown first', () => {
  it('SS-UC11-08 the AR Clerk requests a 220.00 refund (replay 200), sees GP-006, and an Approver approves it; the Clerk may not', async () => {
    const credit = await call('GET', `/ar/parties/${acme}/credit?${q()}`, 'auditor');
    expect(credit.status).toBe(200);
    expect(await credit.json()).toEqual({
      party_id: acme,
      balance: '-220.0000',
      requested: '0.0000',
      available: '220.0000',
    });

    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', body(acme, '220.00'));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id,
      replayed: false,
      refund_no: expect.stringMatching(/^RF-\d{6}$/) as string,
      party_id: acme,
      refund_date: '2026-11-24',
      amount: '220.0000',
      method: 'bank_batch',
      status: 'requested',
      approval: 'pending',
      created_by: people.arClerk?.id,
      approved_by: null,
      approved_at: null,
      entry_id: null,
      paid_on: null,
    });
    const replay = await call('PUT', `/ar/refunds/${id}`, 'arClerk', body(acme, '220.00'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, replayed: true, approval: 'pending' });
    expect(
      await (await call('GET', `/ar/parties/${acme}/credit?${q()}`, 'arClerk')).json(),
    ).toMatchObject({ requested: '220.0000', available: '0.0000' });

    // The journal the bank confirmation will post: exactly GP-006; nothing is written.
    const before = await entries();
    const journal = await call(
      'GET',
      `/ar/refunds/${id}/journal?${q()}&account_id=${f.acct['1010'] ?? ''}`,
      'arClerk',
    );
    expect(journal.status).toBe(200);
    const j = (await journal.json()) as {
      entry_date: string;
      total: string;
      bank_account_source: string;
      lines: { account_code: string; debit: string; credit: string; party_id: string | null }[];
    };
    expect(await entries()).toBe(before);
    expect(j).toMatchObject({
      entry_date: '2026-11-24',
      total: '220.0000',
      bank_account_source: 'chosen',
    });
    expect(gp006?.lines).toHaveLength(2);
    expect(j.lines).toHaveLength(gp006?.lines.length ?? -1);
    const money = (s: string) =>
      s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;
    gp006?.lines.forEach((g, i) => {
      const at = `GP-006 line ${String(i + 1)} (${g.binding})`;
      expect(j.lines[i]?.account_code, at).toBe(codeOf[g.binding]);
      expect(j.lines[i]?.debit, at).toBe(money(g.debit));
      expect(j.lines[i]?.credit, at).toBe(money(g.credit));
      expect(j.lines[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
    // No bank account chosen and the company has none configured: refused, not guessed.
    const unchosen = await call('GET', `/ar/refunds/${id}/journal?${q()}`, 'arClerk');
    expect(unchosen.status).toBe(422);
    expect(await unchosen.json()).toMatchObject({ error: 'BANK_ACCOUNT_REQUIRED' });

    // Maker-checker: the Clerk lacks the permission; the Approver approves; a repeat replays.
    const clerk = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'arClerk');
    expect(clerk.status).toBe(403);
    expect(await clerk.json()).toEqual({ error: 'forbidden', permission: 'ar.refund.approve' });
    const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id,
      replayed: false,
      status: 'requested',
      approval: 'approved',
      approved_by: people.approver?.id,
      approved_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });
    const again = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, replayed: true, approval: 'approved' });
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'auditor');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id, approval: 'approved', status: 'requested' });
  });

  it('SS-UC11-08 a person who requested a refund is refused its approval (SOD_REFUND_SELF_APPROVAL), even holding both permissions', async () => {
    // The Finance Admin holds ar.refund.create and ar.refund.approve (ADR-0072).
    const admin = randomUUID();
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, 'fa@refund.test', 'fa', 'active')`,
      [admin, f.tenantId],
    );
    await f.admin.query(
      `INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, 'finance_admin')`,
      [f.tenantId, admin],
    );
    cookies.set(
      'financeAdmin',
      await (api.sessions ?? { create: () => Promise.reject(new Error('no sessions')) }).create(
        f.tenantId,
        {
          userId: admin,
          amr: ['pwd', 'otp'],
          acr: null,
          authTime: new Date(Date.now() - 30 * 60 * 1000),
        },
      ),
    );
    const id = randomUUID();
    expect(
      (await call('PUT', `/ar/refunds/${id}`, 'financeAdmin', body(beta, '50.00'))).status,
    ).toBe(201);
    const own = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'financeAdmin');
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_REFUND_SELF_APPROVAL',
    });
    const still = await call('GET', `/ar/refunds/${id}?${q()}`, 'financeAdmin');
    expect(await still.json()).toMatchObject({ approval: 'pending' });
    expect((await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver')).status).toBe(200);
  });

  it('403 without ar.refund.create, ar.refund.approve or ar.read', async () => {
    const id = randomUUID();
    const create = await call('PUT', `/ar/refunds/${id}`, 'approver', body(beta, '10.00'));
    expect(create.status).toBe(403);
    expect(await create.json()).toEqual({ error: 'forbidden', permission: 'ar.refund.create' });
    const approve = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'auditor');
    expect(approve.status).toBe(403);
    expect(await approve.json()).toEqual({ error: 'forbidden', permission: 'ar.refund.approve' });
    for (const path of [
      `/ar/refunds/${id}?${q()}`,
      `/ar/refunds/${id}/journal?${q()}`,
      `/ar/parties/${beta}/credit?${q()}`,
    ]) {
      const res = await call('GET', path, 'apClerk');
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden', permission: 'ar.read' });
    }
  });

  it('another tenant: its party and its refund are 404; more than the credit is REFUND_EXCEEDS_CREDIT 422', async () => {
    const foreign = await call('PUT', `/ar/refunds/${randomUUID()}`, 'arClerk', {
      ...body(foreignParty, '10.00'),
    });
    expect(foreign.status).toBe(404);
    for (const [method, path] of [
      ['GET', `/ar/refunds/${foreignRefund}?${q()}`],
      ['GET', `/ar/refunds/${foreignRefund}/journal?${q()}&account_id=${f.acct['1010'] ?? ''}`],
      ['POST', `/ar/refunds/${foreignRefund}/approve?${q()}`],
      ['GET', `/ar/parties/${foreignParty}/credit?${q()}`],
    ] as const) {
      const res = await call(method, path, method === 'POST' ? 'approver' : 'auditor');
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ error: 'not_found' });
    }
    const tooMuch = await call(
      'PUT',
      `/ar/refunds/${randomUUID()}`,
      'arClerk',
      body(beta, '500.00'),
    );
    expect(tooMuch.status).toBe(422);
    expect(await tooMuch.json()).toMatchObject({ error: 'REFUND_EXCEEDS_CREDIT' });
    const stripe = await call('PUT', `/ar/refunds/${randomUUID()}`, 'arClerk', {
      ...body(beta, '10.00'),
      method: 'stripe',
    });
    expect(stripe.status).toBe(422);
    expect(await stripe.json()).toMatchObject({ error: 'METHOD_NOT_AVAILABLE' });
    const bad = await call('PUT', `/ar/refunds/${randomUUID()}`, 'arClerk', {
      ...body(beta, '10.00'),
      amount: 10,
    });
    expect(bad.status).toBe(400);
  });
});
