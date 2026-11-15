/**
 * Stripe refunds over HTTP (T-0172, ADR-0083, DL-0562, ADR-0074; SS-UC11-09, SS-UC11-10). Real
 * PostgreSQL (lf_app), real sessions and the local Stripe stub replaying the documented fixture.
 *   PUT  /ar/refunds/:id            method stripe: needs a Stripe payment covering the refund
 *   POST /ar/refunds/:id/approve    a Stripe refund also needs step-up (300 s); SoD unchanged;
 *                                   the approval sends it once and posts GP-006 Stripe variant
 * The approval and its outbox event commit together; a failed send leaves the refund approved
 * for the outbox handler, with nothing posted. Another tenant's refund is 404.
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
  type DocumentOutbox,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import {
  assertStripeRefundable,
  StripeClient,
  STRIPE_REFUND_APPROVED,
  type HttpPost,
} from '@ledgerforce/connector-stripe';
import {
  APPROVED_REFUNDS_FIXTURE,
  loadCassette,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
  type StripePaidCredit,
} from '@ledgerforce/connector-stripe/testing';
import type { PostingOutbox } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp006 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-006',
);
const CODE_OF: Record<string, string> = {
  'setting:stripe.clearing_account': '1210',
  'system:AR_CONTROL': '1200',
};
const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;
/** 2026-11-24 11:00 in Sydney (the golden's date); the API's clock. */
const NOW = new Date('2026-11-24T00:00:00Z');
const FRESH = new Date(NOW.getTime() - 60 * 1000);
const STALE = new Date(NOW.getTime() - 30 * 60 * 1000);

let f: LedgerFixture;
let other: LedgerFixture;
let profiles: SeededProfiles;
let api: Api;
let stub: RecordedStripe;
let stripeDown = false;
let foreignRefund = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  arClerk: { id: randomUUID(), roles: ['ar_clerk'] },
  approver: { id: randomUUID(), roles: ['approver'] },
  financeAdmin: { id: randomUUID(), roles: ['finance_admin'] },
};

async function call(method: string, path: string, who: string, body?: unknown) {
  const h: Record<string, string> = {};
  const c = cookies.get(who);
  if (c) h.cookie = `lf_session=${c}`;
  h['sec-fetch-site'] = 'same-origin';
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const q = () => `company_id=${f.companyId}`;
const stripeBody = (party: string, amount = '220.00') => ({
  company_id: f.companyId,
  party_id: party,
  refund_date: '2026-11-24',
  amount,
  method: 'stripe',
  reason: 'Back to the card',
});

const seedCredit = async (fx: LedgerFixture, prefix: string, p: SeededProfiles) => {
  const [party = ''] = await seedBillableCustomers(fx, p, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return seedStripePaidCredit(fx, {
    professionalServicesProfileId: p.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: fx.acct['1210'] ?? '',
  });
};

function useVars(credit: StripePaidCredit, refundId: string, refundNo: string, re: string) {
  Object.assign(stub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    refundId,
    refundNo,
    creditNoteId: credit.creditNoteId,
    creditNoteNo: credit.creditNoteNo,
    paymentIntentId: credit.paymentIntentId,
    stripeRefundId: re,
  });
}

const entriesFor = async (refundId: string) =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.journal_entry
        WHERE tenant_id = $1 AND source_type = 'ar_refund' AND source_id = $2`,
      [f.tenantId, refundId],
    )
  ).rows[0]?.n;

const eventsFor = async (refundId: string) =>
  (
    await f.admin.query<{ topic: string }>(
      `SELECT topic FROM app.outbox_event WHERE tenant_id = $1 AND aggregate_id = $2`,
      [f.tenantId, refundId],
    )
  ).rows.map((r) => r.topic);

async function session(who: string, authTime: Date, fx: LedgerFixture = f) {
  const p = people[who];
  if (!p || !api.sessions) throw new Error('no such person or sessions');
  return api.sessions.create(fx.tenantId, {
    userId: p.id,
    amr: ['pwd', 'otp'],
    acr: null,
    authTime,
  });
}

beforeAll(async () => {
  stub = await startRecordedStripe(loadCassette(APPROVED_REFUNDS_FIXTURE));
  f = await createLedgerFixture('01900000-0000-7000-8000-000000017211');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000017212');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@t0172.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  profiles = await seedBillingCompany(f);
  const otherProfiles = await seedBillingCompany(other);
  const foreign = await seedCredit(other, 'Elsewhere', otherProfiles);
  foreignRefund = (
    await other.inTenant((trx) =>
      createCustomerRefund(
        trx,
        {
          companyId: other.companyId,
          id: randomUUID(),
          partyId: foreign.partyId,
          refundDate: '2026-11-24',
          amount: '220.00',
          method: 'stripe',
        },
        { stripeCheck: assertStripeRefundable },
      ),
    )
  ).refundId;

  const http: HttpPost = async (url, init) => {
    if (stripeDown) throw new Error('connect ECONNREFUSED');
    const res = await fetch(url, init);
    return { status: res.status, text: () => res.text() };
  };
  const documentOutbox: DocumentOutbox = {
    publish: async (trx, e) => {
      await sql`INSERT INTO app.outbox_event (company_id, topic, aggregate_type, aggregate_id, payload)
        VALUES (${e.companyId}, ${e.topic}, ${e.aggregateType}, ${e.aggregateId},
                ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
    },
  };
  const postingOutbox: PostingOutbox = { enqueue: async () => {} };
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: { clock: { now: () => NOW } },
    documentOutbox,
    postingOutbox,
    stripeRefunds: {
      client: new StripeClient({
        secretKey: 'sk_test_dummy',
        mode: 'test',
        baseUrl: stub.url,
        http,
      }),
    },
  });
  for (const who of Object.keys(people)) cookies.set(who, await session(who, FRESH));
  cookies.set('staleApprover', await session('approver', STALE));
}, 240_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-09 approving a Stripe refund: step-up, SoD, sent once, GP-006 Stripe variant', () => {
  it('SS-UC11-09 a stepped-up Approver approves a Stripe refund: Stripe is called once, GP-006 (Stripe) posts, a repeat replays', async () => {
    const credit = await seedCredit(f, 'Acme', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    const c = (await created.json()) as { refund_no: string; stripe: unknown };
    expect(c).toMatchObject({ id, method: 'stripe', status: 'requested', approval: 'pending' });
    expect(c.stripe).toEqual({ status: 'not_sent', stripe_refund_id: null, message: null });
    expect(stub.received).toHaveLength(0);
    useVars(credit, id, c.refund_no, 're_1SQbT0172ApiAcme220');

    const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { entry_id: string };
    expect(body).toMatchObject({
      id,
      replayed: false,
      method: 'stripe',
      status: 'paid',
      paid_on: '2026-11-24',
      approval: 'approved',
      approved_by: people.approver?.id,
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220', message: null },
    });
    expect(stub.mismatches).toEqual([]);
    expect(stub.received.map((x) => [x.idempotencyKey, x.matched])).toEqual([
      [`lf-refund-v2-${id}`, 'refund-document-220.00'],
    ]);
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);

    // The journal is GP-006, Stripe variant, line for line.
    const rows = (
      await f.admin.query<{ code: string; debit: string; credit: string; party_id: string | null }>(
        `SELECT a.code, l.debit::text, l.credit::text, l.party_id::text
           FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY l.line_no`,
        [body.entry_id],
      )
    ).rows;
    expect(rows).toHaveLength(gp006?.lines.length ?? -1);
    gp006?.lines.forEach((g, i) => {
      const at = `GP-006 (Stripe variant) line ${String(i + 1)}`;
      const binding =
        g.binding === 'bank:OPERATING' ? 'setting:stripe.clearing_account' : g.binding;
      expect(rows[i]?.code, at).toBe(CODE_OF[binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? credit.partyId : null);
    });

    const again = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      id,
      replayed: true,
      status: 'paid',
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220' },
    });
    expect(stub.received).toHaveLength(1);
    expect(await entriesFor(id)).toBe(1);
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await read.json()).toMatchObject({
      status: 'paid',
      stripe: { status: 'sent', stripe_refund_id: 're_1SQbT0172ApiAcme220' },
    });
  });

  it('SS-UC11-09 approving a Stripe refund without a fresh step-up is 401 step_up_required (300 s); a bank refund needs none', async () => {
    const credit = await seedCredit(f, 'Beta', profiles);
    const id = randomUUID();
    expect(
      (await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId, '100.00')))
        .status,
    ).toBe(201);
    const before = stub.received.length;
    const stale = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'staleApprover');
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required', max_age: 300 });
    expect(stub.received.length).toBe(before);
    expect(await (await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk')).json()).toMatchObject({
      approval: 'pending',
      status: 'requested',
    });
    expect(await eventsFor(id)).toEqual([]);

    // A bank refund (paid later by a released batch, itself under step-up) needs no step-up here.
    const bank = randomUUID();
    expect(
      (
        await call('PUT', `/ar/refunds/${bank}`, 'arClerk', {
          ...stripeBody(credit.partyId, '20.00'),
          method: 'bank_batch',
        })
      ).status,
    ).toBe(201);
    const ok = await call('POST', `/ar/refunds/${bank}/approve?${q()}`, 'staleApprover');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ approval: 'approved', status: 'requested' });
  });

  it('SS-UC11-09 the person who requested a Stripe refund is refused its approval (SOD_REFUND_SELF_APPROVAL), even stepped up', async () => {
    const credit = await seedCredit(f, 'Gamma', profiles);
    const id = randomUUID();
    expect(
      (await call('PUT', `/ar/refunds/${id}`, 'financeAdmin', stripeBody(credit.partyId))).status,
    ).toBe(201);
    const before = stub.received.length;
    const own = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'financeAdmin');
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({
      error: 'sod_violation',
      rule: 'SOD_REFUND_SELF_APPROVAL',
    });
    expect(stub.received.length).toBe(before);
    expect(await entriesFor(id)).toBe(0);
  });

  it("SS-UC11-09 another tenant's Stripe refund is 404; a Stripe refund with no Stripe payment behind it is 422 NO_STRIPE_PAYMENT", async () => {
    const foreign = await call('POST', `/ar/refunds/${foreignRefund}/approve?${q()}`, 'approver');
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: 'not_found' });

    // A customer whose credit comes from a bank-paid invoice has no card to refund to.
    const [party = ''] = await seedBillableCustomers(f, profiles, {
      count: 1,
      prefix: 'Bank',
      billDate: '2026-11-01',
    });
    await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
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
        { outbox: { publish: async () => {} } },
      );
      await approveInvoice(
        trx,
        { companyId: f.companyId, invoiceId: d.invoiceId },
        { outbox: { publish: async () => {} } },
      );
      await recordReceipt(trx, {
        companyId: f.companyId,
        partyId: party,
        receiptDate: '2026-11-10',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: `t0172-eft-${party}`,
        allocations: [{ invoiceId: d.invoiceId, amount: '1375.00' }],
      });
      const cn = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: d.invoiceId,
        id: randomUUID(),
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      await approveCreditNote(trx, { companyId: f.companyId, creditNoteId: cn.creditNoteId });
    });
    const none = await call('PUT', `/ar/refunds/${randomUUID()}`, 'arClerk', stripeBody(party));
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ error: 'NO_STRIPE_PAYMENT' });
  });
});

describe('SS-UC11-10 a Stripe refund that cannot be sent at approval is retried, never posted twice', () => {
  it('SS-UC11-10 Stripe unreachable: the approval and its outbox event commit, nothing is posted, the answer says it will be retried', async () => {
    const credit = await seedCredit(f, 'Delta', profiles);
    const id = randomUUID();
    const created = await call('PUT', `/ar/refunds/${id}`, 'arClerk', stripeBody(credit.partyId));
    expect(created.status).toBe(201);
    stripeDown = true;
    try {
      const ok = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        id,
        status: 'requested',
        approval: 'approved',
        entry_id: null,
        stripe: { status: 'pending', stripe_refund_id: null },
      });
    } finally {
      stripeDown = false;
    }
    expect(await entriesFor(id)).toBe(0);
    expect(await eventsFor(id)).toEqual([STRIPE_REFUND_APPROVED]);
    const read = await call('GET', `/ar/refunds/${id}?${q()}`, 'arClerk');
    expect(await read.json()).toMatchObject({
      approval: 'approved',
      status: 'requested',
      stripe: { status: 'pending' },
    });
    // A repeated approve does not send again from the request: the outbox owns the retry.
    const again = await call('POST', `/ar/refunds/${id}/approve?${q()}`, 'approver');
    expect(await again.json()).toMatchObject({ replayed: true, stripe: { status: 'pending' } });
    expect(await entriesFor(id)).toBe(0);
  });
});
