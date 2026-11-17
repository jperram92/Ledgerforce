/**
 * Follow-ups of a Stripe refund document that Stripe refused or that went stale (RQ-0173).
 * Real PostgreSQL as lf_app; Stripe is the local stub replaying the documented follow-ups fixture
 * (never the network).
 *
 * T-0190 (SS-UC11-11): a requested Stripe refund that Stripe refused permanently is cancelled
 * after a lookup at Stripe finds no live refund for it. It then no longer counts as requested,
 * and the outbox handler does nothing. A document Stripe holds a live refund for, or one that is
 * paid, is never cancelled.
 *
 * T-0189 (SS-UC11-12, SS-UC11-13; review r8 R2, R3): a send older than 23 hours looks at Stripe
 * first and records a live refund found by `lf_refund_id` once, dated the Stripe refund date, and
 * never creates one. With no live refund at Stripe (none, or only failed ones), a resend needs one
 * person to ask and another to confirm, and it uses a new recorded key `lf-refund-v3-<resend id>`.
 * The database refuses a self-confirm and a resend of an unapproved document.
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
  checkStripeCustomerRefund,
  confirmStripeRefundResend,
  requestStripeRefundResend,
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
const secondApprover = randomUUID();

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
  for (const id of [clerk, approver, secondApprover]) {
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

/** A refund approved `hours` ago (the database's clock), as after the 23-hour window passed. */
async function approvedHoursAgo(r: CustomerRefundView, hours: number) {
  await f.admin.query(
    `INSERT INTO app.customer_refund_approval (tenant_id, company_id, refund_id, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, clock_timestamp() - make_interval(hours => $5))`,
    [f.tenantId, f.companyId, r.refundId, approver, hours],
  );
}

const journalOf = (refundId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ entry_date: string; created_by: string | null }>`
          SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date, created_by::text
            FROM app.journal_entry
           WHERE source_type = 'ar_refund' AND source_id = ${refundId}`.execute(trx)
      ).rows,
  );

const stripeRows = (refundId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ stripe_refund_id: string; idempotency_key: string; refund_date: string }>`
          SELECT s.stripe_refund_id, s.idempotency_key, to_char(s.refund_date, 'YYYY-MM-DD') AS refund_date
            FROM app.stripe_refund s JOIN app.customer_refund r
              ON r.tenant_id = s.tenant_id AND r.entry_id = s.entry_id
           WHERE r.id = ${refundId}::uuid`.execute(trx)
      ).rows,
  );

describe('SS-UC11-12 T-0189 AC-1 / review r8 R2: a refund Stripe already holds is recorded once and never sent again', () => {
  it('SS-UC11-12 approved more than 23 h ago and found at Stripe by lf_refund_id: the retry records it once, dated the Stripe refund date; no create', async () => {
    const credit = await seedCredit('Expired');
    const r = await requestRefund(credit);
    await approvedHoursAgo(r, 30);
    setVars('expired', credit, r, 're_1SQbT0189ExpiredLive');
    const posts = creates().length;
    // The Sync issues retry (the outbox handler) reconciles: adopt, post, never create.
    const handler = stripeRefundSendHandler({ client, now: () => NOW });
    await f.inTenant((trx) => handler.handle(trx, eventFor(r.refundId)));
    expect(stub.mismatches).toEqual([]);
    expect(creates().length).toBe(posts);
    const paid = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId));
    // Stripe created it at 2026-11-25 01:00 UTC: 12:00 in Sydney, the tenant's report time zone.
    expect(paid).toMatchObject({ status: 'paid', paidOn: '2026-11-25' });
    expect(await journalOf(r.refundId)).toEqual([
      { entry_date: '2026-11-25', created_by: approver },
    ]);
    expect(await stripeRows(r.refundId)).toEqual([
      {
        stripe_refund_id: 're_1SQbT0189ExpiredLive',
        idempotency_key: `lf-refund-v2-${r.refundId}`,
        refund_date: '2026-11-25',
      },
    ]);
    // Again (a redelivery, a check): no Stripe call, no second journal.
    const seen = stub.received.length;
    await f.inTenant((trx) => handler.handle(trx, eventFor(r.refundId)));
    const again = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(again).toMatchObject({
      outcome: 'recorded',
      stripeRefundId: 're_1SQbT0189ExpiredLive',
      replayed: true,
    });
    expect(stub.received.length).toBe(seen);
    expect(await journalOf(r.refundId)).toHaveLength(1);
  });

  it('SS-UC11-12 R2 an unapproved document whose refund Stripe holds is reported (never recorded unapproved, never cancelled); approving it adopts, no create', async () => {
    const credit = await seedCredit('Stray');
    const r = await requestRefund(credit);
    setVars('stray', credit, r, 're_1SQbT0189StrayLive');
    const posts = creates().length;
    const check = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(check).toMatchObject({
      outcome: 'held_unapproved',
      stripeRefundId: 're_1SQbT0189StrayLive',
      resendable: false,
    });
    expect(await journalOf(r.refundId)).toEqual([]);
    expect(await codeOf(cancel(r.refundId))).toBe('AT_STRIPE');
    await approve(r);
    const sent = await f.inTenant((trx) =>
      sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(stub.mismatches).toEqual([]);
    expect(sent).toMatchObject({ stripeRefundId: 're_1SQbT0189StrayLive', replayed: false });
    expect(creates().length).toBe(posts);
    expect(await journalOf(r.refundId)).toEqual([
      { entry_date: '2026-11-25', created_by: approver },
    ]);
  });
});

describe('SS-UC11-13 T-0189 AC-2 / review r8 R3: with no live refund at Stripe, a resend needs a second person and a new recorded key', () => {
  it('SS-UC11-13 approved more than 23 h ago and nothing at Stripe: KEY_EXPIRED; a resend asked by one person and confirmed by another sends once with lf-refund-v3-<resend id>', async () => {
    const credit = await seedCredit('Vanished');
    const r = await requestRefund(credit);
    await approvedHoursAgo(r, 30);
    setVars('vanished', credit, r, 're_1SQbT0189VanishedResent');
    const posts = creates().length;
    const handler = stripeRefundSendHandler({ client, now: () => NOW });
    const expired = await f
      .inTenant((trx) => handler.handle(trx, eventFor(r.refundId)))
      .catch((e: unknown) => e as { code?: string; retryable?: boolean; message?: string });
    expect(expired).toMatchObject({ code: 'KEY_EXPIRED', retryable: false });
    expect((expired as { message?: string }).message).toMatch(/Stripe holds no refund for it/);
    expect(creates().length).toBe(posts);

    const check = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(check).toMatchObject({
      outcome: 'not_at_stripe',
      stripeRefundId: null,
      resendable: true,
      failedAtStripe: [],
    });

    const resendId = randomUUID();
    stub.vars['vanishedResendId'] = resendId;
    const asked = await f.inTenant((trx) =>
      requestStripeRefundResend(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        resendId,
        requestedBy: approver,
        reason: 'Checked the payment in Stripe: no refund was made',
        now: NOW,
      }),
    );
    expect(asked).toMatchObject({
      resendId,
      status: 'requested',
      requestedBy: approver,
      idempotencyKey: `lf-refund-v3-${resendId}`,
      replayed: false,
    });
    // The same person cannot confirm (SOD_REFUND_RESEND_SELF_CONFIRM); nothing reaches Stripe.
    const seen = stub.received.length;
    expect(
      await codeOf(
        f.inTenant((trx) =>
          confirmStripeRefundResend(trx, {
            companyId: f.companyId,
            refundId: r.refundId,
            resendId,
            confirmedBy: approver,
          }),
        ),
      ),
    ).toBe('SELF_CONFIRM');
    expect(stub.received.length).toBe(seen);

    const confirmed = await f.inTenant(async (trx) => {
      const c = await confirmStripeRefundResend(trx, {
        companyId: f.companyId,
        refundId: r.refundId,
        resendId,
        confirmedBy: secondApprover,
      });
      const sent = await sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
        createdBy: secondApprover,
      });
      return { c, sent };
    });
    expect(stub.mismatches).toEqual([]);
    expect(confirmed.c).toMatchObject({ status: 'confirmed', confirmedBy: secondApprover });
    expect(confirmed.sent).toMatchObject({
      stripeRefundId: 're_1SQbT0189VanishedResent',
      replayed: false,
    });
    expect(
      creates()
        .slice(posts)
        .map((x) => x.idempotencyKey),
    ).toEqual([`lf-refund-v3-${resendId}`]);
    expect(await stripeRows(r.refundId)).toEqual([
      {
        stripe_refund_id: 're_1SQbT0189VanishedResent',
        idempotency_key: `lf-refund-v3-${resendId}`,
        refund_date: '2026-11-24',
      },
    ]);
    // A replay of the confirm, and the outbox handler: no second create.
    expect(
      await f.inTenant((trx) =>
        confirmStripeRefundResend(trx, {
          companyId: f.companyId,
          refundId: r.refundId,
          resendId,
          confirmedBy: secondApprover,
        }),
      ),
    ).toMatchObject({ status: 'confirmed', replayed: true });
    await f.inTenant((trx) => handler.handle(trx, eventFor(r.refundId)));
    expect(creates().length).toBe(posts + 1);
    expect(await journalOf(r.refundId)).toHaveLength(1);
  });

  it('SS-UC11-13 R3 Stripe reports the refund failed: never adopted (REFUND_FAILED); a confirmed resend creates a new refund with a new key, recorded once', async () => {
    const credit = await seedCredit('Failed');
    const r = await requestRefund(credit);
    await approve(r);
    setVars('failed', credit, r, 're_1SQbT0189FailedFirst');
    stub.vars['failedResentStripeRefundId'] = 're_1SQbT0189FailedResent';
    const out = await f.inTenant((trx) =>
      trySendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(out).toMatchObject({ status: 'failed', code: 'REFUND_FAILED' });
    expect(await journalOf(r.refundId)).toEqual([]);

    const check = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(check).toMatchObject({
      outcome: 'not_at_stripe',
      resendable: true,
      failedAtStripe: ['re_1SQbT0189FailedFirst'],
    });
    const resendId = randomUUID();
    stub.vars['failedResendId'] = resendId;
    await f.inTenant((trx) =>
      requestStripeRefundResend(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        resendId,
        requestedBy: approver,
        reason: 'The card was replaced; Stripe returned the first refund',
        now: NOW,
      }),
    );
    const sent = await f.inTenant(async (trx) => {
      await confirmStripeRefundResend(trx, {
        companyId: f.companyId,
        refundId: r.refundId,
        resendId,
        confirmedBy: secondApprover,
      });
      return sendStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      });
    });
    expect(stub.mismatches).toEqual([]);
    expect(sent).toMatchObject({ stripeRefundId: 're_1SQbT0189FailedResent' });
    expect(await stripeRows(r.refundId)).toEqual([
      expect.objectContaining({
        stripe_refund_id: 're_1SQbT0189FailedResent',
        idempotency_key: `lf-refund-v3-${resendId}`,
      }),
    ]);
    // Later lookups see both: the failed one is never adopted, the live one is already recorded.
    const later = await f.inTenant((trx) =>
      checkStripeCustomerRefund(trx, client, {
        companyId: f.companyId,
        refundId: r.refundId,
        now: NOW,
      }),
    );
    expect(later).toMatchObject({
      outcome: 'recorded',
      replayed: true,
      stripeRefundId: 're_1SQbT0189FailedResent',
    });
    expect(await journalOf(r.refundId)).toHaveLength(1);
  });

  it('SS-UC11-13 a resend is refused while the normal send is not blocked (NOT_BLOCKED) or Stripe holds a live refund (AT_STRIPE); the database refuses a self-confirm and an unapproved document', async () => {
    // Fresh approval, nothing at Stripe, nothing failed: the outbox retry is the way, not a resend.
    const fresh = await seedCredit('Fresh');
    const a = await requestRefund(fresh);
    await approve(a);
    setVars('refused', fresh, a);
    expect(
      await codeOf(
        f.inTenant((trx) =>
          requestStripeRefundResend(trx, client, {
            companyId: f.companyId,
            refundId: a.refundId,
            resendId: randomUUID(),
            requestedBy: approver,
            reason: 'try again',
            now: NOW,
          }),
        ),
      ),
    ).toBe('NOT_BLOCKED');

    // Stripe holds a live refund: record it instead.
    const live = await seedCredit('Live');
    const b = await requestRefund(live);
    await approvedHoursAgo(b, 30);
    setVars('stray', live, b, 're_1SQbT0189LiveHeld');
    expect(
      await codeOf(
        f.inTenant((trx) =>
          requestStripeRefundResend(trx, client, {
            companyId: f.companyId,
            refundId: b.refundId,
            resendId: randomUUID(),
            requestedBy: approver,
            reason: 'try again',
            now: NOW,
          }),
        ),
      ),
    ).toBe('AT_STRIPE');

    // The database: no resend of an unapproved document, no self-confirm, nothing else changes.
    const pending = await requestRefund(await seedCredit('Pending'));
    const unapproved = await f
      .inTenant((trx) =>
        sql`INSERT INTO app.customer_refund_stripe_resend
              (company_id, id, refund_id, requested_by, reason, idempotency_key)
            VALUES (${f.companyId}::uuid, ${randomUUID()}::uuid, ${pending.refundId}::uuid,
                    ${approver}::uuid, 'x', 'lf-refund-v3-x')`.execute(trx),
      )
      .then(
        () => 'inserted',
        (e: unknown) => String(e),
      );
    expect(unapproved).toMatch(/violates check constraint|not approved/);
    const id = randomUUID();
    await f.inTenant((trx) =>
      sql`INSERT INTO app.customer_refund_stripe_resend
            (company_id, id, refund_id, requested_by, reason, idempotency_key)
          VALUES (${f.companyId}::uuid, ${id}::uuid, ${b.refundId}::uuid, ${approver}::uuid,
                  'checked at Stripe', ${`lf-refund-v3-${id}`})`.execute(trx),
    );
    const self = await f
      .inTenant((trx) =>
        sql`UPDATE app.customer_refund_stripe_resend SET confirmed_by = ${approver}::uuid
             WHERE id = ${id}::uuid`.execute(trx),
      )
      .then(
        () => 'updated',
        (e: unknown) => String(e),
      );
    expect(self).toMatch(/SOD_REFUND_RESEND_SELF_CONFIRM/);
    const reason = await f
      .inTenant((trx) =>
        sql`UPDATE app.customer_refund_stripe_resend SET reason = 'changed' WHERE id = ${id}::uuid`.execute(
          trx,
        ),
      )
      .then(
        () => 'updated',
        (e: unknown) => String(e),
      );
    expect(reason).toMatch(/permission denied|cannot be changed/);
  });
});
