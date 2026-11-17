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
 * approval (or its latest confirmed resend) creates nothing: Stripe may have pruned the key
 * (RQ-0115 S5). It still looks at Stripe and records a live refund it holds (dated its Stripe
 * date); with none it is refused (KEY_EXPIRED). T-0189 / ADR-0091: checkStripeCustomerRefund
 * reconciles without ever creating; a resend is asked by one person and confirmed by another
 * (requestStripeRefundResend, confirmStripeRefundResend) and uses its own recorded key
 * `lf-refund-v3-<resend id>`. A failed or canceled Stripe refund is never adopted (RQ-0173).
 *
 * Money leaves at most once per refund document (security review r8 F1, RQ-0164, ADR-0083
 * addendum): before any create, the send lists the refunds of every Stripe payment of the party
 * (whatever the state of its invoices and credit notes, re-review R1) and adopts one whose
 * metadata `lf_refund_id` is this document (a commit lost after an earlier send,
 * or a key Stripe pruned, can never cause a second refund). Before money leaves, the journal is
 * checked by the engine's own preview and the allocation's rules: a refusal is NOT_POSTABLE
 * ("not sent to Stripe"). Anything that fails after Stripe accepted (or was adopted) is
 * SENT_NOT_POSTED — permanent, never retried silently — so the Sync issue says the money is out
 * and the books do not show it yet; its retry adopts and posts once. The entry is the approver's
 * when the caller names nobody (F5: the worker's retry).
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
  cancelCustomerRefund,
  getCustomerRefund,
  lockCustomerRefundParty,
  markCustomerRefundPaid,
  RefundError,
  type CustomerRefundView,
  type StripeRefundCheck,
} from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import {
  allocate,
  AllocationError,
  openItem,
  PeriodLockedError,
  post,
  PostingError,
  preview,
  subledgerEntriesOf,
  type PostingCommand,
  type PostOptions,
} from '@ledgerforce/ledger';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { StripeApiError, type ListedRefund, type StripeClient } from './client.ts';

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
  | 'KEY_EXPIRED'
  /** The journal would be refused, so nothing was sent to Stripe (RQ-0164). */
  | 'NOT_POSTABLE'
  /** Stripe has the refund (money out) but the journal could not be written (RQ-0164). */
  | 'SENT_NOT_POSTED'
  /** ADR-0091: a resend is refused while Stripe holds a live refund for the document. */
  | 'AT_STRIPE'
  /** ADR-0091: a resend is only for a send that is blocked (expired, or failed at Stripe). */
  | 'NOT_BLOCKED'
  | 'RESEND_NOT_FOUND'
  | 'INVALID_RESEND'
  /** ADR-0091 (SOD_REFUND_RESEND_SELF_CONFIRM): whoever asked cannot confirm. */
  | 'SELF_CONFIRM'
  | 'ALREADY_CONFIRMED';

export class StripeRefundError extends Error {
  readonly code: StripeRefundErrorCode;
  /** The outbox reads it: a local refusal never succeeds by retrying (dead letter → Sync issue). */
  readonly retryable = false;
  readonly errorCode: string;
  /** SENT_NOT_POSTED: the Stripe refund that is out. */
  readonly stripeRefundId: string | null;
  constructor(code: StripeRefundErrorCode, message: string, stripeRefundId: string | null = null) {
    super(message);
    this.name = 'StripeRefundError';
    this.code = code;
    this.errorCode = code;
    this.stripeRefundId = stripeRefundId;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The refusals of the engine and the allocation: a journal that cannot be written. */
const isLedgerRefusal = (e: unknown) =>
  e instanceof PostingError || e instanceof PeriodLockedError || e instanceof AllocationError;
const reasonOf = (e: unknown) =>
  e instanceof Error
    ? `${(e as { code?: unknown }).code ? `${String((e as { code?: unknown }).code)}: ` : ''}${e.message}`
    : String(e);

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

/**
 * Every Stripe payment of the party in this company (security re-review R1): each PaymentIntent
 * stored for any of the party's invoices, whatever the state of the invoice or of the credit
 * notes against it. The lookup must search them all — a refund sent for a credit note that was
 * voided afterwards is still money out. (Choosing the payment to create against keeps RQ-0163's
 * rules in stripeRefundTarget.)
 */
async function partyPaymentIntents(
  trx: Trx,
  companyId: string,
  partyId: string,
): Promise<string[]> {
  const rows = (
    await sql<{ pi: string }>`
      SELECT DISTINCT e.payment_intent_id AS pi
        FROM app.stripe_webhook_event e
        JOIN app.sales_invoice i ON i.company_id = e.company_id AND i.id = e.invoice_id
       WHERE e.company_id = ${companyId}::uuid AND i.party_id = ${partyId}::uuid
       ORDER BY 1`.execute(trx)
  ).rows;
  return rows.map((r) => r.pi);
}

/**
 * A refund Stripe holds for this document that has moved or may still move money (RQ-0173):
 * `failed` gives the money back to the balance and `canceled` moved none, so those are not.
 */
const isLive = (x: ListedRefund) => POSTABLE_STATUS.has(x.status);

interface AtStripe {
  /** The one live refund Stripe holds for this document, or null. */
  readonly live: ListedRefund | null;
  /** Its failed or canceled refunds (no money out under them; never adopted). */
  readonly dead: readonly ListedRefund[];
}

/**
 * What Stripe holds for this refund document (metadata `lf_refund_id`, `lf_company_id`) across
 * every Stripe payment of the party: the lookup before every create (RQ-0164) and every cancel,
 * check or resend (RQ-0173). Read-only at Stripe. Two live refunds for one document should never
 * exist; if they do, nothing is adopted or sent and the caller is told (SENT_NOT_POSTED).
 */
async function refundsAtStripe(
  trx: Trx,
  client: StripeClient,
  companyId: string,
  refund: CustomerRefundView,
): Promise<AtStripe> {
  const all: ListedRefund[] = [];
  for (const pi of await partyPaymentIntents(trx, companyId, refund.partyId)) {
    all.push(
      ...(await client.findRefunds(
        pi,
        (x) =>
          x.metadata['lf_refund_id'] === refund.refundId &&
          x.metadata['lf_company_id'] === companyId,
      )),
    );
  }
  const live = all.filter(isLive);
  if (live.length > 1) {
    throw new StripeRefundError(
      'SENT_NOT_POSTED',
      `Stripe holds ${String(live.length)} live refunds for refund ${refund.refundNo} (${live.map((x) => x.id).join(', ')}); nothing was recorded or sent. Check them in Stripe by hand`,
      live[0]?.id ?? null,
    );
  }
  return { live: live[0] ?? null, dead: all.filter((x) => !isLive(x)) };
}

/**
 * Cancel a requested Stripe refund document (T-0190, RQ-0173) once Stripe, asked under the party
 * lock, holds no live refund for it (else AT_STRIPE). Read-only at Stripe; fails closed when
 * Stripe cannot be asked.
 */
export async function cancelStripeCustomerRefund(
  trx: Trx,
  client: StripeClient,
  c: { companyId: string; refundId: string },
): Promise<CustomerRefundView> {
  const companyId = c.companyId.toLowerCase();
  return cancelCustomerRefund(
    trx,
    { companyId, refundId: c.refundId },
    {
      heldAtStripe: async (t, r) =>
        (await refundsAtStripe(t, client, companyId, r)).live?.id ?? null,
    },
  );
}

/**
 * Everything that could refuse the journal, checked before money leaves (RQ-0164): the engine's
 * own preview of the posting (period, accounts, party, user) and the allocation's rules against
 * the credit note's open item. Throws the engine's or the allocation's error.
 */
async function assertPostable(
  trx: Trx,
  command: PostingCommand,
  creditItemId: string,
  allocationDate: string,
): Promise<void> {
  const built = await preview(trx, command);
  const mine = built.subledgerItems[0];
  if (!mine) {
    throw new AllocationError('UNKNOWN_OPEN_ITEM', 'the refund journal has no open item');
  }
  const cn = await openItem(trx, creditItemId);
  if (cn.accountId !== mine.accountId) {
    throw new AllocationError('ACCOUNT_MISMATCH', 'the credit note is on another control account');
  }
  if (cn.partyId !== mine.partyId) {
    throw new AllocationError('PARTY_MISMATCH', 'the credit note is of another party');
  }
  if (cn.currency !== mine.currency) {
    throw new AllocationError('CURRENCY_MISMATCH', `the credit note is in ${cn.currency}`);
  }
  if (!new Decimal(cn.originalAmount).isNegative() || !new Decimal(mine.originalAmount).gt(0)) {
    throw new AllocationError('SAME_SIDE', 'the refund and the credit note are on the same side');
  }
  const later = [cn.documentDate, mine.documentDate].sort().at(-1) ?? allocationDate;
  if (allocationDate < later) {
    throw new AllocationError(
      'DATE_BEFORE_DOCUMENT',
      `allocation date ${allocationDate} is before ${later}`,
    );
  }
  if (new Decimal(mine.originalAmount).gt(new Decimal(cn.openAmount).negated())) {
    throw new AllocationError('OVER_ALLOCATION', `the credit note has ${cn.openAmount} open`);
  }
}

/** The latest confirmed resend of a refund document (ADR-0091), or null. */
async function confirmedResend(
  trx: Trx,
  companyId: string,
  refundId: string,
): Promise<{ id: string; key: string; ageMs: string } | null> {
  return (
    (
      await sql<{ id: string; key: string; ageMs: string }>`
        SELECT id::text, idempotency_key AS key,
               (extract(epoch FROM clock_timestamp() - confirmed_at) * 1000)::bigint::text AS "ageMs"
          FROM app.customer_refund_stripe_resend
         WHERE company_id = ${companyId}::uuid AND refund_id = ${refundId}::uuid
           AND confirmed_by IS NOT NULL
         ORDER BY confirmed_at DESC, id DESC
         LIMIT 1`.execute(trx)
    ).rows[0] ?? null
  );
}

/** Send one approved Stripe refund document (see the header). */
export async function sendStripeCustomerRefund(
  trx: Trx,
  client: StripeClient,
  c: StripeSendInput,
  opts: PostOptions = {},
): Promise<StripeCustomerRefundSent> {
  const sent = await sendOrRecord(trx, client, c, opts, false);
  if (!sent) throw new Error('unreachable: a send never stops at the lookup');
  return sent;
}

/**
 * The send (`recordOnly` false) or the check's recording (`recordOnly` true: adopt a live refund
 * Stripe holds, else return null; never create). See the header.
 */
async function sendOrRecord(
  trx: Trx,
  client: StripeClient,
  c: StripeSendInput,
  opts: PostOptions,
  recordOnly: boolean,
): Promise<StripeCustomerRefundSent | null> {
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
  // The window runs from the approval, or from the latest confirmed resend (ADR-0091), on the
  // database's clock, the one that stamped them. Past it only an adoption may happen (T-0189).
  const resend = await confirmedResend(trx, companyId, r.refundId);
  const age =
    resend?.ageMs ??
    (
      await sql<{ ms: string }>`
        SELECT (extract(epoch FROM clock_timestamp() - approved_at) * 1000)::bigint::text AS ms
          FROM app.customer_refund_approval
         WHERE company_id = ${companyId}::uuid AND refund_id = ${r.refundId}::uuid`.execute(trx)
    ).rows[0]?.ms;
  const expired = age === undefined || Number(age) > STRIPE_REFUND_SEND_WINDOW_MS;
  const sendOn = c.sentOn ?? (await stripeRefundToday(trx, c.now));
  if (!DATE_RE.test(sendOn) || sendOn < r.refundDate) {
    throw new StripeRefundError(
      'INVALID_REFUND',
      `refund ${r.refundNo} is dated ${r.refundDate} and cannot be sent on ${sendOn}`,
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
  const key = resend?.key ?? stripeRefundKey(r.refundId);
  // F5: the journal is the approver's when the caller names nobody (the worker's retry).
  const createdBy = c.createdBy ?? r.approvedBy ?? undefined;
  const sentNotPosted = (id: string, reason: string) =>
    new StripeRefundError(
      'SENT_NOT_POSTED',
      `refund ${r.refundNo} was sent to Stripe as ${id} (the money has left), but it was not posted: ${reason}. The books do not show it yet; fix the cause and retry it from Sync issues (the retry records this Stripe refund and never sends another)`,
      id,
    );

  // Never a second refund: adopt the live one Stripe already holds for this document (RQ-0164);
  // a failed or canceled one moved no money and is never adopted (RQ-0173, review r8 R3).
  const existing = (await refundsAtStripe(trx, client, companyId, r)).live;
  if (!existing && recordOnly) return null;
  if (!existing && expired) {
    throw new StripeRefundError(
      'KEY_EXPIRED',
      `refund ${r.refundNo} was approved${resend ? ' (or its resend confirmed)' : ''} more than 23 hours ago and Stripe holds no refund for it; it is not sent automatically. Someone who approves refunds asks for a resend and another person confirms it (ADR-0091), or the refund is cancelled (T-0190)`,
    );
  }
  // An adopted refund is dated the day Stripe made it (the money left then), in the tenant's
  // report time zone, never before the refund document's date.
  const madeOn = existing ? await stripeRefundToday(trx, new Date(existing.created * 1000)) : null;
  const sentOn = madeOn === null ? sendOn : madeOn < r.refundDate ? r.refundDate : madeOn;
  const sentFor = existing?.metadata['lf_credit_note_id'];
  if (existing && (!sentFor || !UUID_RE.test(sentFor))) {
    throw sentNotPosted(existing.id, 'the Stripe refund names no credit note');
  }
  const target = await stripeRefundTarget(trx, {
    companyId,
    partyId: r.partyId,
    amount: r.amount,
    ...(existing && sentFor
      ? { creditNoteId: sentFor }
      : c.creditNoteId
        ? { creditNoteId: c.creditNoteId }
        : {}),
  });
  if (existing && target?.payment_intent_id !== existing.paymentIntentId) {
    throw sentNotPosted(
      existing.id,
      'the credit note and payment it was sent for no longer cover it',
    );
  }
  if (!target) {
    throw new StripeRefundError(
      'NO_STRIPE_PAYMENT',
      `no card payment through Stripe of this customer covers refund ${r.refundNo} of ${new Decimal(r.amount).toFixed(2)}`,
    );
  }
  const command = (memo: string): PostingCommand => ({
    companyId,
    idempotencyKey: `ar-refund:${r.refundId}`,
    entryDate: sentOn,
    sourceType: 'ar_refund',
    sourceId: r.refundId,
    memo,
    ...(createdBy ? { createdBy } : {}),
    lines: [
      {
        account: { role: 'AR_CONTROL' },
        debit: amount.toFixed(2),
        partyId: r.partyId,
        memo: r.refundNo,
      },
      { account: { id: settings.clearing_account_id }, credit: amount.toFixed(2) },
    ],
  });
  const memoOf = (id: string) =>
    `Stripe refund ${id} for ${r.refundNo} of ${target.credit_note_no ?? target.credit_note_id}`;

  // Everything that could refuse the journal, before money leaves.
  try {
    await assertPostable(
      trx,
      command(memoOf(existing?.id ?? 're_pending')),
      target.item_id,
      sentOn,
    );
  } catch (e) {
    if (!isLedgerRefusal(e)) throw e;
    if (existing) throw sentNotPosted(existing.id, reasonOf(e));
    throw new StripeRefundError(
      'NOT_POSTABLE',
      `refund ${r.refundNo} was not sent to Stripe: its journal would be refused (${reasonOf(e)}); fix that, then retry it from Sync issues`,
    );
  }

  const refund =
    existing ??
    (await client.createRefund(
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
    ));
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

  // Stripe has the refund: from here on any failure says so and is never retried silently.
  try {
    const posted = await post(trx, command(memoOf(refund.id)), opts);
    const [refundItem] = await subledgerEntriesOf(trx, posted.entryId);
    if (!refundItem) throw new Error(`refund entry ${posted.entryId} has no open item`);
    await allocate(trx, {
      companyId,
      idempotencyKey: `stripe-refund-alloc:${key}`,
      fromEntryId: target.item_id,
      toEntryId: refundItem.id,
      amount: amount.toFixed(4),
      allocationDate: sentOn,
      ...(createdBy ? { createdBy } : {}),
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
        created_by: createdBy ?? null,
      })
      .execute();
    const paid = await markCustomerRefundPaid(trx, {
      companyId,
      refundId: r.refundId,
      entryId: posted.entryId,
      paidOn: sentOn,
    });
    return { refund: paid, stripeRefundId: refund.id, entryId: posted.entryId, replayed: false };
  } catch (e) {
    throw sentNotPosted(refund.id, reasonOf(e));
  }
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
  /**
   * A permanent failure: reported (Sync issues via the outbox), not retried automatically. With
   * SENT_NOT_POSTED, `stripeRefundId` is the Stripe refund that is out (RQ-0164).
   */
  | {
      readonly status: 'failed';
      readonly code: string;
      readonly message: string;
      readonly stripeRefundId: string | null;
    };

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
    const message = e instanceof Error ? e.message.slice(0, 600) : String(e).slice(0, 600);
    if (isTransient(e)) return { status: 'pending', message };
    const code =
      e instanceof StripeRefundError || e instanceof RefundError
        ? e.code
        : e instanceof StripeApiError
          ? (e.stripeCode ?? 'stripe_error')
          : 'error';
    const stripeRefundId = e instanceof StripeRefundError ? e.stripeRefundId : null;
    return { status: 'failed', code, message, stripeRefundId };
  }
}

export interface StripeRefundReconciliation {
  /**
   * recorded: the document is paid by a Stripe refund (now or before; `replayed` when before);
   * held_unapproved: Stripe holds a live refund for a document that is not approved (review r8
   * R2: approving it records that refund and sends nothing); not_at_stripe: no live refund.
   */
  readonly outcome: 'recorded' | 'held_unapproved' | 'not_at_stripe';
  readonly stripeRefundId: string | null;
  readonly entryId: string | null;
  readonly replayed: boolean;
  /** Failed or canceled refunds Stripe holds for the document (no money out under them). */
  readonly failedAtStripe: readonly string[];
  /** A resend may be asked (ADR-0091): approved, nothing live at Stripe, and the send blocked. */
  readonly resendable: boolean;
  readonly refund: CustomerRefundView;
}

/**
 * Reconcile a Stripe refund document with Stripe (T-0189, RQ-0173): read-only at Stripe, never a
 * create. A live refund carrying the document's `lf_refund_id` is recorded once (GP-006 Stripe
 * variant, dated the Stripe refund date) when the document is approved, or reported when it is
 * not; otherwise it says whether a resend may be asked.
 */
export async function checkStripeCustomerRefund(
  trx: Trx,
  client: StripeClient,
  c: { companyId: string; refundId: string; now: Date; createdBy?: string },
  opts: PostOptions = {},
): Promise<StripeRefundReconciliation> {
  const companyId = c.companyId.toLowerCase();
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  await lockCustomerRefundParty(trx, companyId, before.partyId);
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.method !== 'stripe') {
    throw new StripeRefundError('NOT_PAYABLE', `refund ${r.refundNo} is not a Stripe refund`);
  }
  if (r.status === 'paid') {
    const done = await stripeRefundOf(trx, companyId, r.entryId);
    return {
      outcome: 'recorded',
      stripeRefundId: done?.stripeRefundId ?? null,
      entryId: r.entryId,
      replayed: true,
      failedAtStripe: [],
      resendable: false,
      refund: r,
    };
  }
  if (r.status !== 'requested') {
    throw new StripeRefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status}`);
  }
  const at = await refundsAtStripe(trx, client, companyId, r);
  const failedAtStripe = at.dead.map((x) => x.id);
  if (at.live && r.approval !== 'approved') {
    return {
      outcome: 'held_unapproved',
      stripeRefundId: at.live.id,
      entryId: null,
      replayed: false,
      failedAtStripe,
      resendable: false,
      refund: r,
    };
  }
  if (at.live) {
    const sent = await sendOrRecord(
      trx,
      client,
      {
        companyId,
        refundId: r.refundId,
        now: c.now,
        ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      },
      opts,
      true,
    );
    if (!sent) throw new Error('unreachable: Stripe holds a live refund');
    return {
      outcome: 'recorded',
      stripeRefundId: sent.stripeRefundId,
      entryId: sent.entryId,
      replayed: false,
      failedAtStripe,
      resendable: false,
      refund: sent.refund,
    };
  }
  return {
    outcome: 'not_at_stripe',
    stripeRefundId: null,
    entryId: null,
    replayed: false,
    failedAtStripe,
    resendable:
      r.approval === 'approved' && (await sendBlocked(trx, companyId, r.refundId, failedAtStripe)),
    refund: r,
  };
}

/** The normal send cannot go on (ADR-0091): its window passed, or Stripe failed its refund. */
async function sendBlocked(
  trx: Trx,
  companyId: string,
  refundId: string,
  failedAtStripe: readonly string[],
): Promise<boolean> {
  if (failedAtStripe.length > 0) return true;
  const resend = await confirmedResend(trx, companyId, refundId);
  const age =
    resend?.ageMs ??
    (
      await sql<{ ms: string }>`
        SELECT (extract(epoch FROM clock_timestamp() - approved_at) * 1000)::bigint::text AS ms
          FROM app.customer_refund_approval
         WHERE company_id = ${companyId}::uuid AND refund_id = ${refundId}::uuid`.execute(trx)
    ).rows[0]?.ms;
  return age === undefined || Number(age) > STRIPE_REFUND_SEND_WINDOW_MS;
}

export interface StripeRefundResendView {
  readonly resendId: string;
  readonly refundId: string;
  readonly status: 'requested' | 'confirmed';
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  /** The resend's own Stripe Idempotency-Key, recorded before any call. */
  readonly idempotencyKey: string;
  readonly replayed: boolean;
}

async function resendOf(
  trx: Trx,
  companyId: string,
  resendId: string,
  replayed = false,
): Promise<StripeRefundResendView | null> {
  const row = (
    await sql<{
      id: string;
      refund_id: string;
      requested_by: string;
      requested_at: string;
      reason: string;
      confirmed_by: string | null;
      confirmed_at: string | null;
      idempotency_key: string;
    }>`
      SELECT id::text, refund_id::text, requested_by::text, reason, confirmed_by::text,
             idempotency_key,
             to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
             to_char(confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at
        FROM app.customer_refund_stripe_resend
       WHERE company_id = ${companyId}::uuid AND id = ${resendId}::uuid`.execute(trx)
  ).rows[0];
  return row
    ? {
        resendId: row.id,
        refundId: row.refund_id,
        status: row.confirmed_by ? 'confirmed' : 'requested',
        requestedBy: row.requested_by,
        requestedAt: row.requested_at,
        reason: row.reason,
        confirmedBy: row.confirmed_by,
        confirmedAt: row.confirmed_at,
        idempotencyKey: row.idempotency_key,
        replayed,
      }
    : null;
}

/** The resend of a refund document, or RESEND_NOT_FOUND (another company's is not there). */
export async function getStripeRefundResend(
  trx: Trx,
  c: { companyId: string; refundId: string; resendId: string },
): Promise<StripeRefundResendView> {
  const companyId = c.companyId.toLowerCase();
  const v = UUID_RE.test(c.resendId)
    ? await resendOf(trx, companyId, c.resendId.toLowerCase())
    : null;
  if (!v || v.refundId !== c.refundId.toLowerCase()) {
    throw new StripeRefundError(
      'RESEND_NOT_FOUND',
      `there is no resend ${c.resendId} of this refund`,
    );
  }
  return v;
}

/**
 * Ask for a resend of an approved, requested Stripe refund document (T-0189, ADR-0091): only when
 * its normal send is blocked (past the 23-hour window, or Stripe failed its refund) and Stripe,
 * asked now under the party lock, holds no live refund for it (else AT_STRIPE: record it with the
 * check). Records the resend's own key `lf-refund-v3-<resend id>`. Nothing is sent until another
 * person confirms. A repeat by the same person for the same refund replays.
 */
export async function requestStripeRefundResend(
  trx: Trx,
  client: StripeClient,
  c: {
    companyId: string;
    refundId: string;
    resendId: string;
    requestedBy: string;
    reason: string;
    now: Date;
  },
): Promise<StripeRefundResendView> {
  const companyId = c.companyId.toLowerCase();
  if (!UUID_RE.test(c.resendId) || !UUID_RE.test(c.requestedBy)) {
    throw new StripeRefundError('INVALID_RESEND', 'the resend id and the person are uuids');
  }
  const reason = c.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new StripeRefundError('INVALID_RESEND', 'the reason is 1–500 characters');
  }
  const resendId = c.resendId.toLowerCase();
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  await lockCustomerRefundParty(trx, companyId, before.partyId);
  const prior = await resendOf(trx, companyId, resendId, true);
  if (prior) {
    if (prior.refundId !== before.refundId || prior.requestedBy !== c.requestedBy.toLowerCase()) {
      throw new StripeRefundError('INVALID_RESEND', `resend ${resendId} is another request`);
    }
    return prior;
  }
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.method !== 'stripe' || r.status !== 'requested') {
    throw new StripeRefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status} (${r.method})`);
  }
  if (r.approval !== 'approved') {
    throw new StripeRefundError(
      'NOT_APPROVED',
      `refund ${r.refundNo} is not approved; approve it, which sends it`,
    );
  }
  const open = (
    await sql<{ id: string }>`
      SELECT id::text FROM app.customer_refund_stripe_resend
       WHERE company_id = ${companyId}::uuid AND refund_id = ${r.refundId}::uuid
         AND confirmed_by IS NULL`.execute(trx)
  ).rows[0];
  if (open) {
    throw new StripeRefundError(
      'INVALID_RESEND',
      `refund ${r.refundNo} already has resend ${open.id} waiting for confirmation`,
    );
  }
  const at = await refundsAtStripe(trx, client, companyId, r);
  if (at.live) {
    throw new StripeRefundError(
      'AT_STRIPE',
      `Stripe holds refund ${at.live.id} for refund ${r.refundNo}; it is recorded by checking with Stripe, never sent again`,
      at.live.id,
    );
  }
  if (
    !(await sendBlocked(
      trx,
      companyId,
      r.refundId,
      at.dead.map((x) => x.id),
    ))
  ) {
    throw new StripeRefundError(
      'NOT_BLOCKED',
      `refund ${r.refundNo} can still be sent normally (LedgerForce retries it); a resend is only for a send past 23 hours or one Stripe failed`,
    );
  }
  await trx
    .insertInto('app.customer_refund_stripe_resend')
    .values({
      company_id: companyId,
      id: resendId,
      refund_id: r.refundId,
      requested_by: c.requestedBy.toLowerCase(),
      reason,
      idempotency_key: `lf-refund-v3-${resendId}`,
    })
    .execute();
  const view = await resendOf(trx, companyId, resendId);
  if (!view) throw new Error('resend not readable');
  return view;
}

/**
 * Confirm a resend (T-0189, ADR-0091): another person than the one who asked (SELF_CONFIRM; the
 * database refuses it too). The caller then sends in the same transaction (the approve route's
 * pattern: outbox event, then a savepointed send that uses the resend's key). A repeat by the
 * same person replays; anyone else gets ALREADY_CONFIRMED.
 */
export async function confirmStripeRefundResend(
  trx: Trx,
  c: { companyId: string; refundId: string; resendId: string; confirmedBy: string },
): Promise<StripeRefundResendView> {
  const companyId = c.companyId.toLowerCase();
  const confirmedBy = c.confirmedBy.toLowerCase();
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  await lockCustomerRefundParty(trx, companyId, before.partyId);
  const v = await getStripeRefundResend(trx, {
    companyId,
    refundId: before.refundId,
    resendId: c.resendId,
  });
  if (v.status === 'confirmed') {
    if (v.confirmedBy === confirmedBy) return { ...v, replayed: true };
    throw new StripeRefundError('ALREADY_CONFIRMED', `resend ${v.resendId} is already confirmed`);
  }
  if (v.requestedBy === confirmedBy) {
    throw new StripeRefundError(
      'SELF_CONFIRM',
      `the person who asked for resend ${v.resendId} cannot confirm it (SOD_REFUND_RESEND_SELF_CONFIRM)`,
    );
  }
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.status !== 'requested') {
    throw new StripeRefundError('NOT_PAYABLE', `refund ${r.refundNo} is ${r.status}`);
  }
  await trx
    .updateTable('app.customer_refund_stripe_resend')
    .set({ confirmed_by: confirmedBy })
    .where('company_id', '=', companyId)
    .where('id', '=', v.resendId)
    .execute();
  const after = await resendOf(trx, companyId, v.resendId);
  if (!after) throw new Error('resend not readable');
  return after;
}

/** The outbox event shape the handler reads (structurally @ledgerforce/outbox's OutboxEvent). */
export interface StripeRefundApprovedEvent {
  readonly companyId: string | null;
  readonly aggregateId: string;
}

/**
 * Outbox handler (apps/worker): sends the refund named by an `ar.refund.stripe_approved` event.
 * Its effect and the inbox row commit together (ADR-0008); a paid refund is a no-op. The journal
 * is the approver's (F5).
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
      // T-0190: a cancelled refund is done; nothing is sent (checked under the party lock).
      const r = await getCustomerRefund(trx, event.companyId, event.aggregateId).catch(() => null);
      if (r) {
        await lockCustomerRefundParty(trx, event.companyId, r.partyId);
        const now = await getCustomerRefund(trx, event.companyId, r.refundId);
        if (now.status === 'cancelled') return;
      }
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
