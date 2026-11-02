/**
 * Stripe webhook → card receipt into Stripe clearing (T-0074, GP-003, RQ-0104, ADR-0049).
 *
 * handleStripeWebhook verifies the raw body's signature and timestamp before anything is parsed
 * or read (WebhookSignatureError → HTTP 400), then acts only on `payment_intent.succeeded`
 * carrying the `lf_*` metadata LedgerForce put on the invoice's Payment Link (T-0073). The
 * tenant comes from that signed metadata and the work runs in withTenant (RLS FORCE); the invoice
 * must have a Payment Link stored in that tenant and company, and currency and livemode must
 * match. A receipt is then posted through the AR receipt service (posting engine, source type
 * payments_stripe_charge): Dr the company's Stripe clearing account / Cr AR control (party),
 * allocated to the invoice up to its open amount — any excess stays as customer credit.
 *
 * Replay protection: the event id is stored once (UNIQUE) with the receipt; the receipt is keyed
 * by the PaymentIntent id; a transaction-scoped advisory lock serialises deliveries of one
 * PaymentIntent. A repeat answers `duplicate` and changes nothing. Money via decimal.js; the
 * amount is integer cents from Stripe, divided exactly.
 */
import type { DocumentOutbox } from '@ledgerforce/ar';
import { PAYMENT_RECEIVED, receiptWriteBack, recordReceipt } from '@ledgerforce/ar';
import { withTenant, type Database } from '@ledgerforce/db';
import type { PostOptions } from '@ledgerforce/ledger';
import { Decimal } from 'decimal.js';
import { sql, type Kysely, type Transaction } from 'kysely';
import { parseStripeEvent, verifyStripeSignature, type StripeEvent } from './webhook-signature.ts';

type Trx = Transaction<Database>;

export const PAYMENT_SUCCEEDED = 'payment_intent.succeeded';

export class StripeWebhookError extends Error {
  readonly code: 'NOT_CONFIGURED';
  constructor(code: StripeWebhookError['code'], message: string) {
    super(message);
    this.name = 'StripeWebhookError';
    this.code = code;
  }
}

export interface StripeWebhookConfig {
  /** Endpoint signing secrets (whsec_…); several during a roll. From configuration only. */
  readonly secrets: readonly string[];
  /** The deployment's Stripe mode; an event of the other mode is not posted. */
  readonly mode: 'test' | 'live';
  /** Document events (the `payment.received` write-back snapshot), same transaction. */
  readonly outbox: DocumentOutbox;
  /** The posting engine's outbox. */
  readonly posting?: PostOptions;
  /** Unix seconds; defaults to the system clock. */
  readonly now?: () => number;
}

export type IgnoredReason =
  | 'unhandled_event_type'
  | 'not_ledgerforce'
  | 'malformed_payment_intent'
  | 'livemode_mismatch'
  | 'unknown_invoice'
  | 'no_payment_link'
  | 'currency_mismatch';

export type WebhookOutcome =
  | {
      readonly kind: 'receipt';
      readonly eventId: string;
      readonly receiptId: string;
      readonly receiptNo: string;
      readonly entryId: string;
      readonly invoiceId: string;
      readonly amount: string;
      readonly unallocated: string;
    }
  | { readonly kind: 'duplicate'; readonly eventId: string; readonly receiptId: string }
  | { readonly kind: 'ignored'; readonly eventId: string; readonly reason: IgnoredReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PI = /^pi_[A-Za-z0-9]{1,250}$/;

interface PaymentIntentFacts {
  readonly id: string;
  readonly cents: number;
  readonly currency: string;
  readonly livemode: boolean;
  readonly tenantId: string;
  readonly companyId: string;
  readonly invoiceId: string;
}

/** The facts this connector needs from a payment_intent.succeeded object, or why it is not ours. */
function paymentIntentOf(event: StripeEvent): PaymentIntentFacts | IgnoredReason {
  const o = event.data.object;
  const meta = (
    typeof o['metadata'] === 'object' && o['metadata'] !== null ? o['metadata'] : {}
  ) as Record<string, unknown>;
  const tenantId = meta['lf_tenant_id'];
  const companyId = meta['lf_company_id'];
  const invoiceId = meta['lf_invoice_id'];
  if (tenantId === undefined && companyId === undefined && invoiceId === undefined) {
    return 'not_ledgerforce';
  }
  const cents = o['amount_received'];
  const currency = o['currency'];
  if (
    o['object'] !== 'payment_intent' ||
    o['status'] !== 'succeeded' ||
    typeof o['id'] !== 'string' ||
    !PI.test(o['id']) ||
    typeof cents !== 'number' ||
    !Number.isSafeInteger(cents) ||
    cents <= 0 ||
    typeof currency !== 'string' ||
    !/^[a-z]{3}$/i.test(currency) ||
    typeof o['livemode'] !== 'boolean' ||
    typeof tenantId !== 'string' ||
    !UUID.test(tenantId) ||
    typeof companyId !== 'string' ||
    !UUID.test(companyId) ||
    typeof invoiceId !== 'string' ||
    !UUID.test(invoiceId)
  ) {
    return 'malformed_payment_intent';
  }
  return {
    id: o['id'],
    cents,
    currency: currency.toUpperCase(),
    livemode: o['livemode'],
    tenantId,
    companyId,
    invoiceId,
  };
}

/** The Stripe connector settings (postings Q2): the clearing account GP-003 debits. */
export async function setStripeSettings(
  trx: Trx,
  companyId: string,
  s: { clearingAccountId: string },
): Promise<void> {
  await trx
    .insertInto('app.stripe_settings')
    .values({ company_id: companyId, clearing_account_id: s.clearingAccountId })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'company_id']).doUpdateSet({
        clearing_account_id: s.clearingAccountId,
        updated_at: sql<Date>`clock_timestamp()`,
      }),
    )
    .execute();
}

/** Process one verified payment_intent.succeeded inside its tenant's transaction. */
export async function processPaymentSucceeded(
  trx: Trx,
  event: StripeEvent,
  pi: PaymentIntentFacts,
  cfg: Pick<StripeWebhookConfig, 'mode' | 'outbox' | 'posting'>,
): Promise<WebhookOutcome> {
  const ignored = (reason: IgnoredReason): WebhookOutcome => ({
    kind: 'ignored',
    eventId: event.id,
    reason,
  });
  if (event.livemode !== (cfg.mode === 'live') || pi.livemode !== event.livemode) {
    return ignored('livemode_mismatch');
  }
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`stripe_payment_intent:${pi.id}`}, 0))`.execute(
    trx,
  );
  const seen = await trx
    .selectFrom('app.stripe_webhook_event')
    .select('receipt_id')
    .where((eb) => eb.or([eb('event_id', '=', event.id), eb('payment_intent_id', '=', pi.id)]))
    .executeTakeFirst();
  if (seen) return { kind: 'duplicate', eventId: event.id, receiptId: seen.receipt_id };

  const inv = await trx
    .selectFrom('app.sales_invoice')
    .select(['party_id', 'status', 'entry_id', 'currency'])
    .where('company_id', '=', pi.companyId)
    .where('id', '=', pi.invoiceId)
    .executeTakeFirst();
  if (!inv) return ignored('unknown_invoice');
  const link = await trx
    .selectFrom('app.stripe_payment_link')
    .select('id')
    .where('company_id', '=', pi.companyId)
    .where('invoice_id', '=', pi.invoiceId)
    .executeTakeFirst();
  if (!link) return ignored('no_payment_link');
  if (inv.currency !== pi.currency) return ignored('currency_mismatch');

  const settings = await trx
    .selectFrom('app.stripe_settings')
    .select('clearing_account_id')
    .where('company_id', '=', pi.companyId)
    .executeTakeFirst();
  if (!settings) {
    // Not acknowledged: Stripe retries, and the payment posts once the setting exists.
    throw new StripeWebhookError(
      'NOT_CONFIGURED',
      `company ${pi.companyId} has no Stripe clearing account`,
    );
  }

  const amount = new Decimal(pi.cents).dividedBy(100);
  let open = new Decimal(0);
  if (inv.status === 'posted' && inv.entry_id) {
    const o = (
      await sql<{ open: string }>`
        SELECT coalesce(sum(open_amount), 0)::text AS open FROM app.subledger_entry
         WHERE company_id = ${pi.companyId}::uuid AND entry_id = ${inv.entry_id}::uuid
           AND control_role = 'AR_CONTROL'`.execute(trx)
    ).rows[0]?.open;
    open = Decimal.max(0, new Decimal(o ?? '0'));
  }
  const toInvoice = Decimal.min(amount, open);
  // Stripe's clock (UTC) dates the payment, as GP-028 dates Stripe's fees by UTC month.
  const receiptDate = new Date(event.created * 1000).toISOString().slice(0, 10);
  const receipt = await recordReceipt(
    trx,
    {
      companyId: pi.companyId,
      partyId: inv.party_id,
      receiptDate,
      amount: amount.toFixed(2),
      method: 'card',
      depositTo: { accountId: settings.clearing_account_id },
      reference: pi.id,
      idempotencyKey: `stripe:${pi.id}`,
      sourceType: 'payments_stripe_charge',
      allocations: toInvoice.gt(0)
        ? [{ invoiceId: pi.invoiceId, amount: toInvoice.toFixed(2) }]
        : [],
    },
    cfg.posting,
  );
  await trx
    .insertInto('app.stripe_webhook_event')
    .values({
      company_id: pi.companyId,
      event_id: event.id,
      event_type: PAYMENT_SUCCEEDED,
      livemode: event.livemode,
      event_created_at: new Date(event.created * 1000),
      payment_intent_id: pi.id,
      invoice_id: pi.invoiceId,
      amount: amount.toFixed(4),
      currency: pi.currency,
      receipt_id: receipt.receiptId,
    })
    .execute();
  const writeBack = await receiptWriteBack(trx, {
    companyId: pi.companyId,
    receiptId: receipt.receiptId,
  });
  if (writeBack) {
    await cfg.outbox.publish(trx, {
      companyId: pi.companyId,
      topic: PAYMENT_RECEIVED,
      aggregateType: 'customer_receipt',
      aggregateId: receipt.receiptId,
      payload: {
        receiptId: receipt.receiptId,
        receiptNo: receipt.receiptNo,
        invoiceId: pi.invoiceId,
        stripeEventId: event.id,
        writeBack,
      },
    });
  }
  return {
    kind: 'receipt',
    eventId: event.id,
    receiptId: receipt.receiptId,
    receiptNo: receipt.receiptNo,
    entryId: receipt.entryId,
    invoiceId: pi.invoiceId,
    amount: amount.toFixed(4),
    unallocated: receipt.unallocated,
  };
}

/**
 * Verify, parse, route and process one delivery. Throws WebhookSignatureError (→ 400) before any
 * database access when the signature, timestamp or body is bad; StripeWebhookError NOT_CONFIGURED
 * (→ 503, Stripe retries) when the company has no clearing account.
 */
export async function handleStripeWebhook(
  db: Kysely<Database>,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  cfg: StripeWebhookConfig,
): Promise<WebhookOutcome> {
  const now = cfg.now ? cfg.now() : Math.floor(Date.now() / 1000);
  verifyStripeSignature(rawBody, signatureHeader, cfg.secrets, now);
  const event = parseStripeEvent(rawBody);
  if (event.type !== PAYMENT_SUCCEEDED) {
    return { kind: 'ignored', eventId: event.id, reason: 'unhandled_event_type' };
  }
  const pi = paymentIntentOf(event);
  if (typeof pi === 'string') return { kind: 'ignored', eventId: event.id, reason: pi };
  return withTenant(db, pi.tenantId, (trx) => processPaymentSucceeded(trx, event, pi, cfg));
}
