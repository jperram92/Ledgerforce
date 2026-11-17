/**
 * Follow-ups of a Stripe refund document that Stripe refused or that went stale (RQ-0173).
 * Real PostgreSQL as lf_app; Stripe is the local stub replaying the documented follow-ups fixture
 * (never the network).
 *
 * T-0190 (SS-UC11-11): a requested Stripe refund that Stripe refused permanently is cancelled
 * after a lookup at Stripe finds no live refund for it. It then no longer counts as requested,
 * and the outbox handler does nothing. A document Stripe holds a live refund for, or one that is
 * paid, is never cancelled.
 */
import { randomUUID } from 'node:crypto';
import {
  approveCustomerRefund,
  createCustomerRefund,
  customerCredit,
  getCustomerRefund,
  type CustomerRefundView,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StripeClient } from './client.ts';
import {
  assertStripeRefundable,
  cancelStripeCustomerRefund,
  sendStripeCustomerRefund,
  STRIPE_REFUND_APPROVED,
  stripeRefundSendHandler,
  trySendStripeCustomerRefund,
} from './refund.ts';
import {
  loadCassette,
  REFUND_FOLLOWUPS_FIXTURE,
  seedStripePaidCredit,
  startRecordedStripe,
  type RecordedStripe,
  type StripePaidCredit,
} from './testing/index.ts';

/** 2026-11-24 11:00 in Sydney. */
const NOW = new Date('2026-11-24T00:00:00Z');

let f: LedgerFixture;
let stub: RecordedStripe;
let client: StripeClient;
let profiles: SeededProfiles;
const clerk = randomUUID();
const approver = randomUUID();

const creates = () => stub.received.filter((x) => x.method === 'POST');

const seedCredit = async (prefix: string) => {
  const [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix,
    billDate: '2026-11-01',
  });
  return seedStripePaidCredit(f, {
    professionalServicesProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    partyId: party,
    clearingAccountId: f.acct['1210'] ?? '',
  });
};

const requestRefund = (credit: StripePaidCredit) =>
  f.inTenant((trx) =>
    createCustomerRefund(
      trx,
      {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: credit.partyId,
        refundDate: '2026-11-24',
        amount: '220.00',
        method: 'stripe',
        createdBy: clerk,
      },
      { stripeCheck: assertStripeRefundable },
    ),
  );

const approve = (r: CustomerRefundView) =>
  f.inTenant((trx) =>
    approveCustomerRefund(trx, {
      companyId: f.companyId,
      refundId: r.refundId,
      approvedBy: approver,
      today: '2026-11-24',
    }),
  );

const setVars = (prefix: string, credit: StripePaidCredit, r: CustomerRefundView, re = '') =>
  Object.assign(stub.vars, {
    tenantId: f.tenantId,
    companyId: f.companyId,
    [`${prefix}RefundId`]: r.refundId,
    [`${prefix}RefundNo`]: r.refundNo,
    [`${prefix}CreditNoteId`]: credit.creditNoteId,
    [`${prefix}CreditNoteNo`]: credit.creditNoteNo,
    [`${prefix}PaymentIntentId`]: credit.paymentIntentId,
    [`${prefix}StripeRefundId`]: re,
  });

const eventFor = (refundId: string) => ({
  id: randomUUID(),
  tenantId: f.tenantId,
  companyId: f.companyId,
  topic: STRIPE_REFUND_APPROVED,
  aggregateType: 'customer_refund',
  aggregateId: refundId,
  payload: { refundId },
  createdAt: NOW,
});

const cancel = (refundId: string) =>
  f.inTenant((trx) =>
    cancelStripeCustomerRefund(trx, client, { companyId: f.companyId, refundId }),
  );

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

beforeAll(async () => {
  stub = await startRecordedStripe(loadCassette(REFUND_FOLLOWUPS_FIXTURE));
  client = new StripeClient({ secretKey: 'sk_test_dummy', mode: 'test', baseUrl: stub.url });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000019001');
  profiles = await seedBillingCompany(f);
  for (const id of [clerk, approver]) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $3, 'active')`,
      [id, f.tenantId, `${id}@t0190.test`],
    );
  }
}, 180_000);

afterAll(async () => {
  await (stub as RecordedStripe | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-11 a Stripe refund Stripe refused permanently is cancelled; its amount stops counting as requested', () => {
  it('SS-UC11-11 refused (charge_disputed), then cancelled after a lookup at Stripe: credit freed, the outbox handler does nothing', async () => {
    const credit = await seedCredit('Refused');
    const r = await requestRefund(credit);
    await approve(r);
    setVars('refused', credit, r);
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(out).toMatchObject({ status: 'failed' });
    expect(out.status === 'failed' ? out.message : '').toMatch(/charged back/);
    const held = await f.inTenant((trx) => customerCredit(trx, f.companyId, credit.partyId));
    expect(held).toMatchObject({ requested: '220.0000', available: '0.0000' });

    const posts = creates().length;
    const lookups = stub.received.length;
    const cancelled = await cancel(r.refundId);
    expect(stub.mismatches).toEqual([]);
    expect(cancelled).toMatchObject({ refundId: r.refundId, status: 'cancelled', replayed: false });
    // The cancel asked Stripe first (read-only) and created nothing.
    expect(stub.received.slice(lookups).map((x) => [x.method, x.matched])).toEqual([
      ['GET', 'list-refunds-refused'],
    ]);
    expect(creates().length).toBe(posts);
    const freed = await f.inTenant((trx) => customerCredit(trx, f.companyId, credit.partyId));
    expect(freed).toMatchObject({ requested: '0.0000', available: '220.0000' });

    // A repeat replays; nothing is asked of Stripe again.
    expect(await cancel(r.refundId)).toMatchObject({ status: 'cancelled', replayed: true });
    expect(stub.received.length).toBe(lookups + 1);

    // The outbox handler treats a cancelled refund as done: no Stripe call, no error, no journal.
    const handler = stripeRefundSendHandler({ client, now: () => NOW });
    await f.inTenant((trx) => handler.handle(trx, eventFor(r.refundId)));
    expect(stub.received.length).toBe(lookups + 1);
    const n = await f.inTenant(
      async (trx) =>
        (
          await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.journal_entry
            WHERE source_type = 'ar_refund' AND source_id = ${r.refundId}`.execute(trx)
        ).rows[0]?.n,
    );
    expect(n).toBe(0);
    // The send itself still refuses a cancelled refund (the approve route and the direct path).
    expect(
      await codeOf(
        f.inTenant((trx) =>
          sendStripeCustomerRefund(trx, client, {
            companyId: f.companyId,
            refundId: r.refundId,
            now: NOW,
          }),
        ),
      ),
    ).toBe('NOT_PAYABLE');
  });

  it('SS-UC11-11 a refund Stripe holds (a commit lost after the send) is never cancelled: AT_STRIPE with the Stripe refund id', async () => {
    const credit = await seedCredit('Held');
    const r = await requestRefund(credit);
    setVars('held', credit, r, 're_1SQbT0190HeldLive');
    // Approve and send, then the transaction fails to commit: Stripe has the money out and the
    // document is unapproved again (security review r8 R2).
    const lost = await f
      .inTenant(async (trx) => {
        await approveCustomerRefund(trx, {
          companyId: f.companyId,
          refundId: r.refundId,
          approvedBy: approver,
          today: '2026-11-24',
        });
        await sendStripeCustomerRefund(trx, client, {
          companyId: f.companyId,
          refundId: r.refundId,
          now: NOW,
        });
        throw new Error('connection lost before COMMIT');
      })
      .catch((e: unknown) => (e as Error).message);
    expect(lost).toBe('connection lost before COMMIT');
    const posts = creates().length;
    const refused = await cancel(r.refundId).catch(
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(stub.mismatches).toEqual([]);
    expect(refused).toMatchObject({ code: 'AT_STRIPE' });
    expect((refused as { message?: string }).message).toMatch(/re_1SQbT0190HeldLive/);
    expect(creates().length).toBe(posts);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'requested' });
  });

  it('SS-UC11-11 a paid (sent) refund and a bank refund are NOT_CANCELLABLE; a cancelled one stays cancelled; another company sees none', async () => {
    const credit = await seedCredit('Paid');
    const r = await requestRefund(credit);
    await approve(r);
    setVars('paid', credit, r, 're_1SQbT0190PaidOut');
    await f.inTenant((trx) =>
      sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    const lookups = stub.received.length;
    expect(await codeOf(cancel(r.refundId))).toBe('NOT_CANCELLABLE');
    expect(stub.received.length).toBe(lookups);
    expect(
      await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId)),
    ).toMatchObject({ status: 'paid' });

    // A bank refund is cancelled elsewhere (T-0207): not by this Stripe path.
    const bankCredit = await seedCredit('Bank');
    const bank = await f.inTenant((trx) =>
      createCustomerRefund(trx, {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: bankCredit.partyId,
        refundDate: '2026-11-24',
        amount: '1.00',
        method: 'bank_batch',
        createdBy: clerk,
      }),
    );
    expect(await codeOf(cancel(bank.refundId))).toBe('NOT_CANCELLABLE');

    // Cancelled is final: the 0055 guard refuses to move it back.
    const refused = await seedCredit('Final');
    const c = await requestRefund(refused);
    setVars('refused', refused, c);
    await cancel(c.refundId);
    const moved = await f.admin
      .query(
        `UPDATE app.customer_refund SET status = 'requested' WHERE tenant_id = $1 AND id = $2`,
        [f.tenantId, c.refundId],
      )
      .then(
        () => 'updated',
        (e: unknown) => String(e),
      );
    expect(moved).toMatch(/cannot move from cancelled to requested/);
    expect(
      await codeOf(
        f.inTenant((trx) =>
          cancelStripeCustomerRefund(trx, client, {
            companyId: randomUUID(),
            refundId: c.refundId,
          }),
        ),
      ),
    ).toBe('REFUND_NOT_FOUND');
  });
});
