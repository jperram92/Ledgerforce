/**
 * Refund customer credit through Stripe (T-0074, T-0172, ADR-0074, ADR-0083, RQ-0104 Q5,
 * RQ-0163; GP-006 Stripe variant; SS-UC11-04, SS-UC11-09, SS-UC11-10).
 *
 * A Stripe refund is a refund document (`app.customer_refund`, method `stripe`) that another person
 * approved (maker-checker, ADR-0074). Nothing reaches Stripe before that approval.
 *
 * sendStripeCustomerRefund sends one approved, requested Stripe refund:
 *  1. the payment to refund: the party's oldest posted credit note whose open credit and whose
 *     invoice's Stripe payment (stored by the webhook) both cover the amount (RQ-0163 Q1);
 *  2. `POST /v1/refunds` (`payment_intent`, integer cents, Idempotency-Key
 *     `lf-refund-v2-<refund id>`: one Stripe request per refund document, however often retried);
 *  3. the engine posts Dr AR control (party) / Cr Stripe clearing (source ar_refund, source id =
 *     the refund id, posting key `ar-refund:<refund id>` — the same key as the bank path, so one
 *     entry per refund ever), dated the send date in the tenant's report time zone;
 *  4. the refund's open item is allocated against the credit note's, a `stripe_refund` row records
 *     the Stripe refund with the same entry, and the refund document is marked paid.
 * A paid refund is a replay: no Stripe call, no posting. A send later than 23 hours after the
 * approval is refused (KEY_EXPIRED): Stripe may have pruned the key (RQ-0115 S5), so a resend
 * could refund twice; someone must check Stripe first (T-0189).
 *
 * trySendStripeCustomerRefund runs the send in a savepoint for the approve route: a failure rolls
 * back only the send, so the approval and its outbox event `ar.refund.stripe_approved` commit and
 * the outbox handler (stripeRefundSendHandler) retries. Permanent failures (Stripe 4xx, local
 * refusals, KEY_EXPIRED) carry `retryable: false`, so the worker dead-letters them to Sync issues.
 *
 * refundCreditViaStripe (T-0074's direct path) now requires an approved Stripe refund document and
 * goes through the same send (AC-3). Money via decimal.js; amounts are decimal strings.
 */
import {
  getCustomerRefund,
  lockCustomerRefundParty,
  markCustomerRefundPaid,
  RefundError,
  type CustomerRefundView,
  type StripeRefundCheck,
} from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import { allocate, post, subledgerEntriesOf, type PostOptions } from '@ledgerforce/ledger';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { StripeApiError, type StripeClient } from './client.ts';

type Trx = Transaction<Database>;

export type StripeRefundErrorCode =
  | 'INVALID_REFUND'
  | 'NOT_POSTED'
  | 'EXCEEDS_CREDIT'
  | 'NO_STRIPE_PAYMENT'
  | 'EXCEEDS_PAYMENT'
  | 'NOT_CONFIGURED'
  | 'REFUND_FAILED'
  | 'NOT_APPROVED'
  | 'NOT_PAYABLE'
  | 'KEY_EXPIRED';

export class StripeRefundError extends Error {
  readonly code: StripeRefundErrorCode;
  /** The outbox reads it: a local refusal never succeeds by retrying (dead letter → Sync issue). */
  readonly retryable = false;
  readonly errorCode: string;
  constructor(code: StripeRefundErrorCode, message: string) {
    super(message);
    this.name = 'StripeRefundError';
    this.code = code;
    this.errorCode = code;
  }
}

/** Outbox topic written with the approval of a Stripe refund (ADR-0083). */
export const STRIPE_REFUND_APPROVED = 'ar.refund.stripe_approved';
/** The outbox handler's stable name (its inbox key). */
export const STRIPE_REFUND_SEND_HANDLER = 'stripe.refund.send';
/** No automatic send after this long from the approval: Stripe keeps keys ≥ 24 h (RQ-0163). */
export const STRIPE_REFUND_SEND_WINDOW_MS = 23 * 60 * 60 * 1000;
const DEFAULT_ZONE = 'Australia/Sydney';
const POSTABLE_STATUS = new Set(['pending', 'requires_action', 'succeeded']);
const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const stripeRefundKey = (refundId: string) => `lf-refund-v2-${refundId.toLowerCase()}`;

/** The calendar date of `now` in the tenant's report time zone (as the daily jobs, ADR-0062). */
export async function stripeRefundToday(trx: Trx, now: Date): Promise<string> {
  const zone = (
    await sql<{ z: string }>`
      SELECT report_timezone AS z FROM app.sod_settings ORDER BY set_at DESC, id DESC LIMIT 1`.execute(
      trx,
    )
  ).rows[0]?.z;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone ?? DEFAULT_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface Target {
  credit_note_id: string;
  credit_note_no: string | null;
  item_id: string;
  payment_intent_id: string;
  currency: string;
}

/** The credit note and Stripe payment a refund of `amount` goes back to (RQ-0163 Q1), or null. */
async function stripeRefundTarget(
  trx: Trx,
  c: { companyId: string; partyId: string; amount: string; creditNoteId?: string },
): Promise<Target | null> {
  const amount = new Decimal(c.amount).toFixed(4);
  const only = c.creditNoteId ? sql`AND cn.id = ${c.creditNoteId}::uuid` : sql``;
  return (
    (
      await sql<Target>`
        SELECT t.credit_note_id, t.credit_note_no, t.item_id, t.payment_intent_id, t.currency
          FROM (
            SELECT cn.id::text AS credit_note_id, cn.credit_note_no, cn.issue_date,
                   s.id::text AS item_id, -s.open_amount AS open,
                   w.payment_intent_id, w.currency,
                   w.amount - coalesce((
                     SELECT sum(r.amount) FROM app.stripe_refund r
                      WHERE r.company_id = cn.company_id
                        AND r.payment_intent_id = w.payment_intent_id), 0) AS refundable
              FROM app.credit_note cn
              JOIN app.subledger_entry s
                ON s.company_id = cn.company_id AND s.entry_id = cn.entry_id
               AND s.control_role = 'AR_CONTROL'
              JOIN LATERAL (
                SELECT e.payment_intent_id, e.amount, e.currency FROM app.stripe_webhook_event e
                 WHERE e.company_id = cn.company_id AND e.invoice_id = cn.invoice_id
                 ORDER BY e.received_at, e.id LIMIT 1) w ON true
             WHERE cn.company_id = ${c.companyId}::uuid AND cn.party_id = ${c.partyId}::uuid
               AND cn.status = 'posted' ${only}
          ) t
         WHERE t.open >= ${amount}::numeric AND t.refundable >= ${amount}::numeric
         ORDER BY t.issue_date, t.credit_note_id
         LIMIT 1`.execute(trx)
    ).rows[0] ?? null
  );
}

/**
 * The check `createCustomerRefund` runs for `method: stripe` (T-0172): a Stripe payment of the
 * party, through one credit note, covers the amount; otherwise RefundError NO_STRIPE_PAYMENT.
 */
export const assertStripeRefundable: StripeRefundCheck = async (trx, c) => {
  if (!(await stripeRefundTarget(trx, c))) {
    throw new RefundError(
      'NO_STRIPE_PAYMENT',
      `no card payment through Stripe of this customer covers a refund of ${new Decimal(c.amount).toFixed(2)} (one refund goes back to one payment); refund by payment batch or split the refund`,
    );
  }
};

export interface StripeSendInput {
  readonly companyId: string;
  readonly refundId: string;
  /** The moment of the send: dates the entry (the retry window uses the database clock). */
  readonly now: Date;
  /** Forces the credit note (T-0074's direct path); otherwise RQ-0163's choice. */
  readonly creditNoteId?: string;
  /** Overrides the entry date (T-0074's direct path); not before the refund date. */
  readonly sentOn?: string;
  readonly createdBy?: string;
}

export interface StripeCustomerRefundSent {
  readonly refund: CustomerRefundView;
  readonly stripeRefundId: string;
  readonly entryId: string;
  readonly replayed: boolean;
}

/** The Stripe refund recorded for a paid Stripe refund document, or null. */
export async function stripeRefundOf(
  trx: Trx,
  companyId: string,
  entryId: string | null,
): Promise<{ stripeRefundId: string; stripeStatus: string } | null> {
  if (!entryId) return null;
  const r = await trx
    .selectFrom('app.stripe_refund')
    .select(['stripe_refund_id', 'stripe_status'])
    .where('company_id', '=', companyId.toLowerCase())
    .where('entry_id', '=', entryId)
    .executeTakeFirst();
  return r ? { stripeRefundId: r.stripe_refund_id, stripeStatus: r.stripe_status } : null;
}

/** Send one approved Stripe refund document (see the header). */
export async function sendStripeCustomerRefund(
  trx: Trx,
  client: StripeClient,
  c: StripeSendInput,
  opts: PostOptions = {},
): Promise<StripeCustomerRefundSent> {
  const companyId = c.companyId.toLowerCase();
  const before = await getCustomerRefund(trx, companyId, c.refundId).catch((e: unknown) => {
    if (e instanceof RefundError && e.code === 'REFUND_NOT_FOUND') {
      throw new StripeRefundError('NOT_APPROVED', `there is no approved refund ${c.refundId}`);
    }
    throw e;
  });
  await lockCustomerRefundParty(trx, companyId, before.partyId);
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.status === 'paid') {
    const done = await stripeRefundOf(trx, companyId, r.entryId);
    if (!done || !r.entryId) {
      throw new StripeRefundError(
        'NOT_PAYABLE',
        `refund ${r.refundNo} was not paid through Stripe`,
      );
    }
    return { refund: r, stripeRefundId: done.stripeRefundId, entryId: r.entryId, replayed: true };
  }
  if (r.method !== 'stripe' || r.status !== 'requested') {
    throw new StripeRefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status} (${r.method})`);
  }
  if (r.approval !== 'approved' || !r.approvedAt) {
    throw new StripeRefundError(
      'NOT_APPROVED',
      `refund ${r.refundNo} is not approved; a Stripe refund is sent only after approval (ADR-0074)`,
    );
  }
  // The database's clock, the one that stamped the approval.
  const age = (
    await sql<{ ms: string }>`
      SELECT (extract(epoch FROM clock_timestamp() - approved_at) * 1000)::bigint::text AS ms
        FROM app.customer_refund_approval
       WHERE company_id = ${companyId}::uuid AND refund_id = ${r.refundId}::uuid`.execute(trx)
  ).rows[0]?.ms;
  if (age === undefined || Number(age) > STRIPE_REFUND_SEND_WINDOW_MS) {
    throw new StripeRefundError(
      'KEY_EXPIRED',
      `refund ${r.refundNo} was approved more than 23 hours ago; check the payment in Stripe before sending it again (T-0189)`,
    );
  }
  const sentOn = c.sentOn ?? (await stripeRefundToday(trx, c.now));
  if (!DATE_RE.test(sentOn) || sentOn < r.refundDate) {
    throw new StripeRefundError(
      'INVALID_REFUND',
      `refund ${r.refundNo} is dated ${r.refundDate} and cannot be sent on ${sentOn}`,
    );
  }
  const target = await stripeRefundTarget(trx, {
    companyId,
    partyId: r.partyId,
    amount: r.amount,
    ...(c.creditNoteId ? { creditNoteId: c.creditNoteId } : {}),
  });
  if (!target) {
    throw new StripeRefundError(
      'NO_STRIPE_PAYMENT',
      `no card payment through Stripe of this customer covers refund ${r.refundNo} of ${new Decimal(r.amount).toFixed(2)}`,
    );
  }
  const settings = await trx
    .selectFrom('app.stripe_settings')
    .select('clearing_account_id')
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (!settings) {
    throw new StripeRefundError('NOT_CONFIGURED', 'the company has no Stripe clearing account');
  }
  const tenant = (
    await sql<{ t: string }>`SELECT current_setting('app.tenant_id') AS t`.execute(trx)
  ).rows[0]?.t;
  const amount = new Decimal(r.amount);
  const cents = amount.times(100).toFixed(0);
  const key = stripeRefundKey(r.refundId);

  const refund = await client.createRefund(
    {
      paymentIntentId: target.payment_intent_id,
      amountCents: cents,
      reason: 'requested_by_customer',
      metadata: {
        lf_tenant_id: tenant ?? '',
        lf_company_id: companyId,
        lf_refund_id: r.refundId,
        lf_refund_no: r.refundNo,
        lf_credit_note_id: target.credit_note_id,
        lf_credit_note_no: target.credit_note_no ?? '',
      },
    },
    key,
  );
  if (
    !POSTABLE_STATUS.has(refund.status) ||
    refund.amountCents !== cents ||
    refund.currency !== target.currency
  ) {
    throw new StripeRefundError(
      'REFUND_FAILED',
      `Stripe refund ${refund.id} is ${refund.status} for ${refund.amountCents} ${refund.currency}`,
    );
  }

  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-refund:${r.refundId}`,
      entryDate: sentOn,
      sourceType: 'ar_refund',
      sourceId: r.refundId,
      memo: `Stripe refund ${refund.id} for ${r.refundNo} of ${target.credit_note_no ?? target.credit_note_id}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        {
          account: { role: 'AR_CONTROL' },
          debit: amount.toFixed(2),
          partyId: r.partyId,
          memo: r.refundNo,
        },
        { account: { id: settings.clearing_account_id }, credit: amount.toFixed(2) },
      ],
    },
    opts,
  );
  const [refundItem] = await subledgerEntriesOf(trx, posted.entryId);
  if (!refundItem) throw new Error(`refund entry ${posted.entryId} has no open item`);
  await allocate(trx, {
    companyId,
    idempotencyKey: `stripe-refund-alloc:${key}`,
    fromEntryId: target.item_id,
    toEntryId: refundItem.id,
    amount: amount.toFixed(4),
    allocationDate: sentOn,
    ...(c.createdBy ? { createdBy: c.createdBy } : {}),
  });
  await trx
    .insertInto('app.stripe_refund')
    .values({
      company_id: companyId,
      credit_note_id: target.credit_note_id,
      payment_intent_id: target.payment_intent_id,
      amount: amount.toFixed(4),
      currency: target.currency,
      refund_date: sentOn,
      stripe_refund_id: refund.id,
      stripe_status: refund.status as 'pending' | 'requires_action' | 'succeeded',
      idempotency_key: key,
      entry_id: posted.entryId,
      created_by: c.createdBy ?? null,
    })
    .execute();
  const paid = await markCustomerRefundPaid(trx, {
    companyId,
    refundId: r.refundId,
    entryId: posted.entryId,
    paidOn: sentOn,
  });
  return { refund: paid, stripeRefundId: refund.id, entryId: posted.entryId, replayed: false };
}

export type StripeSendOutcome =
  | {
      readonly status: 'sent';
      readonly stripeRefundId: string;
      readonly entryId: string;
      readonly replayed: boolean;
    }
  /** A transient failure: the outbox handler retries. */
  | { readonly status: 'pending'; readonly message: string }
  /** A permanent failure: reported (Sync issues via the outbox), not retried automatically. */
  | { readonly status: 'failed'; readonly code: string; readonly message: string };

const isTransient = (e: unknown) =>
  !(e instanceof StripeRefundError || e instanceof RefundError) &&
  !(e instanceof StripeApiError && !e.retryable);

/**
 * The approve route's send (ADR-0083): in a savepoint, so a failure undoes only the send and the
 * approval with its outbox event still commits.
 */
export async function trySendStripeCustomerRefund(
  trx: Trx,
  client: StripeClient,
  c: StripeSendInput,
  opts: PostOptions = {},
): Promise<StripeSendOutcome> {
  await sql`SAVEPOINT lf_stripe_refund_send`.execute(trx);
  try {
    const sent = await sendStripeCustomerRefund(trx, client, c, opts);
    await sql`RELEASE SAVEPOINT lf_stripe_refund_send`.execute(trx);
    return {
      status: 'sent',
      stripeRefundId: sent.stripeRefundId,
      entryId: sent.entryId,
      replayed: sent.replayed,
    };
  } catch (e) {
    await sql`ROLLBACK TO SAVEPOINT lf_stripe_refund_send`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_stripe_refund_send`.execute(trx);
    const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
    if (isTransient(e)) return { status: 'pending', message };
    const code =
      e instanceof StripeRefundError || e instanceof RefundError
        ? e.code
        : e instanceof StripeApiError
          ? (e.stripeCode ?? 'stripe_error')
          : 'error';
    return { status: 'failed', code, message };
  }
}

/** The outbox event shape the handler reads (structurally @ledgerforce/outbox's OutboxEvent). */
export interface StripeRefundApprovedEvent {
  readonly companyId: string | null;
  readonly aggregateId: string;
}

/**
 * Outbox handler (apps/worker): sends the refund named by an `ar.refund.stripe_approved` event.
 * Its effect and the inbox row commit together (ADR-0008); a paid refund is a no-op.
 */
export function stripeRefundSendHandler(deps: {
  client: StripeClient;
  posting?: PostOptions;
  now?: () => Date;
}): {
  readonly name: string;
  readonly topics: readonly string[];
  handle(trx: Trx, event: StripeRefundApprovedEvent): Promise<void>;
} {
  return {
    name: STRIPE_REFUND_SEND_HANDLER,
    topics: [STRIPE_REFUND_APPROVED],
    async handle(trx, event) {
      if (!event.companyId) throw new StripeRefundError('INVALID_REFUND', 'event has no company');
      await sendStripeCustomerRefund(
        trx,
        deps.client,
        {
          companyId: event.companyId,
          refundId: event.aggregateId,
          now: deps.now ? deps.now() : new Date(),
        },
        deps.posting ?? {},
      );
    },
  };
}

export interface StripeRefundInput {
  readonly companyId: string;
  readonly creditNoteId: string;
  /** The approved Stripe refund document this refund pays (ADR-0074, AC-3). */
  readonly refundId: string;
  /** Decimal string > 0 with ≤ 2 decimals; must equal the refund document's amount. */
  readonly amount: string;
  readonly refundDate: string;
  readonly createdBy?: string;
}

export interface StripeRefundView {
  readonly refundId: string;
  readonly stripeRefundId: string;
  readonly entryId: string;
  /** NUMERIC text, 4 decimals. */
  readonly amount: string;
  readonly replayed: boolean;
}

/**
 * T-0074's refund of a named credit note, now only for an approved Stripe refund document of the
 * same customer and amount (T-0172 AC-3): it goes through sendStripeCustomerRefund.
 */
export async function refundCreditViaStripe(
  trx: Trx,
  client: StripeClient,
  c: StripeRefundInput,
  opts: PostOptions = {},
): Promise<StripeRefundView> {
  const companyId = c.companyId.toLowerCase();
  if (!AMOUNT_RE.test(c.amount) || !new Decimal(c.amount).gt(0)) {
    throw new StripeRefundError('INVALID_REFUND', 'the amount must be > 0 with ≤ 2 decimals');
  }
  if (!DATE_RE.test(c.refundDate)) {
    throw new StripeRefundError('INVALID_REFUND', 'the refund date is YYYY-MM-DD');
  }
  const doc = await getCustomerRefund(trx, companyId, c.refundId).catch(() => null);
  if (!doc || doc.method !== 'stripe' || (doc.status !== 'paid' && doc.approval !== 'approved')) {
    throw new StripeRefundError(
      'NOT_APPROVED',
      'a Stripe refund needs an approved Stripe refund document (ADR-0074)',
    );
  }
  if (!new Decimal(doc.amount).eq(c.amount)) {
    throw new StripeRefundError(
      'INVALID_REFUND',
      `refund ${doc.refundNo} is for ${doc.amount}, not ${new Decimal(c.amount).toFixed(4)}`,
    );
  }
  const sent = await sendStripeCustomerRefund(
    trx,
    client,
    {
      companyId,
      refundId: doc.refundId,
      now: new Date(),
      creditNoteId: c.creditNoteId,
      sentOn: c.refundDate,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
    },
    opts,
  );
  return {
    refundId: sent.refund.refundId,
    stripeRefundId: sent.stripeRefundId,
    entryId: sent.entryId,
    amount: new Decimal(sent.refund.amount).toFixed(4),
    replayed: sent.replayed,
  };
}
