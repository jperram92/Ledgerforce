/**
 * Refund customer credit through Stripe (T-0074, SS-UC11-04, GP-006 Stripe variant, RQ-0104 Q5).
 *
 * A posted credit note's open credit (e.g. CN-000007 on a paid invoice, GP-005) is refunded to the
 * card that paid the invoice: the invoice's Stripe payment (stored by the webhook) is refunded with
 * `POST /v1/refunds` (`payment_intent`, integer cents, Idempotency-Key
 * `lf-refund-v1-<credit note id>-<cents>`), then the engine posts Dr AR control (party) /
 * Cr Stripe clearing (source ar_refund), and the refund's open item is allocated against the
 * credit note's. The refund nets in the next Stripe payout (T-0075). Everything that can be
 * checked locally is checked before Stripe is called; a repeat returns the first result. The
 * Stripe call runs inside the caller's transaction (as ADR-0048's link creation does): a rollback
 * after the call is retried with the same key and gets the same refund back. Money via decimal.js.
 */
import type { Database } from '@ledgerforce/db';
import { allocate, post, subledgerEntriesOf, type PostOptions } from '@ledgerforce/ledger';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import type { StripeClient } from './client.ts';

type Trx = Transaction<Database>;

export type StripeRefundErrorCode =
  | 'INVALID_REFUND'
  | 'NOT_POSTED'
  | 'EXCEEDS_CREDIT'
  | 'NO_STRIPE_PAYMENT'
  | 'EXCEEDS_PAYMENT'
  | 'NOT_CONFIGURED'
  | 'REFUND_FAILED';

export class StripeRefundError extends Error {
  readonly code: StripeRefundErrorCode;
  constructor(code: StripeRefundErrorCode, message: string) {
    super(message);
    this.name = 'StripeRefundError';
    this.code = code;
  }
}

export interface StripeRefundInput {
  readonly companyId: string;
  readonly creditNoteId: string;
  /** Decimal string > 0 with ≤ 2 decimals. */
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

const AMOUNT_RE = /^\d{1,15}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSTABLE_STATUS = new Set(['pending', 'requires_action', 'succeeded']);

export const refundIdempotencyKey = (creditNoteId: string, cents: string) =>
  `lf-refund-v1-${creditNoteId}-${cents}`;

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
  const amount = new Decimal(c.amount);
  const cents = amount.times(100).toFixed(0);
  const key = refundIdempotencyKey(c.creditNoteId, cents);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stripe_refund:${c.creditNoteId}`}, 0))`.execute(
    trx,
  );
  const done = await trx
    .selectFrom('app.stripe_refund')
    .select(['id', 'stripe_refund_id', 'entry_id', 'amount'])
    .where('company_id', '=', companyId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (done) {
    return {
      refundId: done.id,
      stripeRefundId: done.stripe_refund_id,
      entryId: done.entry_id,
      amount: new Decimal(done.amount).toFixed(4),
      replayed: true,
    };
  }

  const cn = await trx
    .selectFrom('app.credit_note')
    .select(['party_id', 'invoice_id', 'status', 'entry_id', 'credit_note_no'])
    .where('company_id', '=', companyId)
    .where('id', '=', c.creditNoteId)
    .executeTakeFirst();
  if (!cn || cn.status !== 'posted' || !cn.entry_id) {
    throw new StripeRefundError(
      'NOT_POSTED',
      `credit note ${c.creditNoteId} is not a posted credit note of this company`,
    );
  }
  const [cnItem] = await subledgerEntriesOf(trx, cn.entry_id);
  const credit = new Decimal(cnItem?.openAmount ?? '0').negated();
  if (!cnItem || amount.gt(credit)) {
    throw new StripeRefundError(
      'EXCEEDS_CREDIT',
      `refund ${amount.toFixed(2)} exceeds the credit note's open credit ${Decimal.max(0, credit).toFixed(2)}`,
    );
  }
  const payment = await trx
    .selectFrom('app.stripe_webhook_event')
    .select(['payment_intent_id', 'amount', 'currency'])
    .where('company_id', '=', companyId)
    .where('invoice_id', '=', cn.invoice_id)
    .orderBy('received_at')
    .executeTakeFirst();
  if (!payment) {
    throw new StripeRefundError(
      'NO_STRIPE_PAYMENT',
      `invoice ${cn.invoice_id} was not paid through Stripe; refund it by bank payment instead`,
    );
  }
  const refunded = (
    await sql<{ s: string }>`
      SELECT coalesce(sum(amount), 0)::text AS s FROM app.stripe_refund
       WHERE company_id = ${companyId}::uuid AND payment_intent_id = ${payment.payment_intent_id}`.execute(
      trx,
    )
  ).rows[0]?.s;
  const refundable = new Decimal(payment.amount).minus(refunded ?? '0');
  if (amount.gt(refundable)) {
    throw new StripeRefundError(
      'EXCEEDS_PAYMENT',
      `refund ${amount.toFixed(2)} exceeds what is left of the Stripe payment (${refundable.toFixed(2)})`,
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

  const refund = await client.createRefund(
    {
      paymentIntentId: payment.payment_intent_id,
      amountCents: cents,
      reason: 'requested_by_customer',
      metadata: {
        lf_tenant_id: tenant ?? '',
        lf_company_id: companyId,
        lf_credit_note_id: c.creditNoteId,
        lf_credit_note_no: cn.credit_note_no ?? '',
      },
    },
    key,
  );
  if (
    !POSTABLE_STATUS.has(refund.status) ||
    refund.amountCents !== cents ||
    refund.currency !== payment.currency
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
      idempotencyKey: `stripe-refund:${key}`,
      entryDate: c.refundDate,
      sourceType: 'ar_refund',
      memo: `Stripe refund ${refund.id} of ${cn.credit_note_no ?? c.creditNoteId}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        { account: { role: 'AR_CONTROL' }, debit: amount.toFixed(2), partyId: cn.party_id },
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
    fromEntryId: cnItem.id,
    toEntryId: refundItem.id,
    amount: amount.toFixed(4),
    allocationDate: c.refundDate,
  });
  const row = await trx
    .insertInto('app.stripe_refund')
    .values({
      company_id: companyId,
      credit_note_id: c.creditNoteId,
      payment_intent_id: payment.payment_intent_id,
      amount: amount.toFixed(4),
      currency: payment.currency,
      refund_date: c.refundDate,
      stripe_refund_id: refund.id,
      stripe_status: refund.status as 'pending' | 'requires_action' | 'succeeded',
      idempotency_key: key,
      entry_id: posted.entryId,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    refundId: row.id,
    stripeRefundId: refund.id,
    entryId: posted.entryId,
    amount: amount.toFixed(4),
    replayed: false,
  };
}
