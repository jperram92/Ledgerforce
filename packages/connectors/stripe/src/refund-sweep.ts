/**
 * The nightly sweep for Stripe refunds that no refund document records (T-0208, ADR-0103,
 * RQ-0185; review r8 R2, r10 M1(c)).
 *
 * A stray is a live Stripe refund (pending, requires_action or succeeded) carrying a document's
 * `lf_refund_id` while that document is not approved, is approved but not recorded, or is
 * cancelled — or two live refunds for one document. `checkStripeCustomerRefund` finds one only
 * when a person checks that document; the sweep looks at every candidate each night.
 *
 * Money-out safety: the sweep and its handler only *look*. They never call a Stripe create, never
 * record a refund (no journal, no `stripe_refund` row, no status change) and never call
 * `checkStripeCustomerRefund` (which records). Recording stays a person's action: "Check with
 * Stripe" in the refund region, or approving an unapproved document (which adopts and sends
 * nothing).
 *
 *  - `stripeRefundSweepCandidates`: the company's Stripe documents that are requested, or were
 *    cancelled in the last SWEEP_CANCELLED_DAYS days (RQ-0185 finding 1).
 *  - `sweepStripeRefund`: one document, in the caller's tenant transaction (one per document): the
 *    party lock (an in-flight send has committed or rolled back), a re-read, the read-only lookup,
 *    and one outbox event `ar.refund.stripe_unrecorded` per stray document. Nothing is published
 *    while an earlier event of the document has not been delivered successfully to the handler
 *    (an open, ignored or retried Sync issue, or a delivery still queued): one report per document.
 *  - `stripeRefundUnrecordedHandler`: the event's handler repeats the look. While the stray is
 *    there it throws HELD_AT_STRIPE (permanent, `retryable: false`), so the dead letter becomes the
 *    Sync issue with a plain message; once the document is recorded or the stray is gone it
 *    succeeds and a retried issue resolves.
 */
import {
  getCustomerRefund,
  lockCustomerRefundParty,
  type CustomerRefundView,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import type { StripeClient } from './client.ts';
import { refundsAtStripe, StripeRefundError } from './refund.ts';

type Trx = Transaction<Database>;

/** Outbox topic of a stray found by the sweep (ADR-0103). */
export const STRIPE_REFUND_UNRECORDED = 'ar.refund.stripe_unrecorded';
/** Its handler: the read-only re-check whose dead letter is the Sync issue. Never rename. */
export const STRIPE_REFUND_UNRECORDED_HANDLER = 'stripe.refund.unrecorded_check';
/** Cancelled documents are swept for this many days after their last change (RQ-0185). */
export const SWEEP_CANCELLED_DAYS = 30;

export type UnrecordedFinding =
  /** Review r8 R2: Stripe holds a live refund for a document nobody approved. */
  | 'held_unapproved'
  /** An approved, requested document Stripe holds a live refund for that is not recorded. */
  | 'held_unrecorded'
  /** Review r10 M1(c): Stripe holds a live refund for a cancelled document. */
  | 'held_cancelled'
  /** Two or more live refunds for one document (never adopted; checked by hand). */
  | 'several_live';

export interface UnrecordedStripeRefund {
  readonly refundId: string;
  readonly refundNo: string;
  readonly finding: UnrecordedFinding;
  readonly stripeRefundIds: readonly string[];
}

/** The company's Stripe refund documents the sweep looks at, oldest first. */
export async function stripeRefundSweepCandidates(trx: Trx, companyId: string): Promise<string[]> {
  const rows = (
    await sql<{ id: string }>`
      SELECT id::text FROM app.customer_refund
       WHERE company_id = ${companyId.toLowerCase()}::uuid AND method = 'stripe'
         AND (status = 'requested'
              OR (status = 'cancelled'
                  AND updated_at > clock_timestamp() - make_interval(days => ${SWEEP_CANCELLED_DAYS})))
       ORDER BY created_at, id`.execute(trx)
  ).rows;
  return rows.map((r) => r.id);
}

/**
 * What Stripe holds for one document that no document records, or null. Read-only at Stripe and in
 * the database; under the party lock, so it never races a send of the same customer.
 */
export async function findUnrecordedStripeRefund(
  trx: Trx,
  client: StripeClient,
  c: { companyId: string; refundId: string },
): Promise<UnrecordedStripeRefund | null> {
  const companyId = c.companyId.toLowerCase();
  const before = await getCustomerRefund(trx, companyId, c.refundId);
  if (before.method !== 'stripe') return null;
  await lockCustomerRefundParty(trx, companyId, before.partyId);
  const r = await getCustomerRefund(trx, companyId, before.refundId);
  if (r.status === 'paid') return null;
  const found = (finding: UnrecordedFinding, ids: readonly string[]) => ({
    refundId: r.refundId,
    refundNo: r.refundNo,
    finding,
    stripeRefundIds: ids,
  });
  try {
    const at = await refundsAtStripe(trx, client, companyId, r);
    if (!at.live) return null;
    return found(findingOf(r), [at.live.id]);
  } catch (e) {
    // Two live refunds for one document: the lookup refuses to choose (SENT_NOT_POSTED).
    if (e instanceof StripeRefundError && e.code === 'SENT_NOT_POSTED') {
      const ids = /\(([^)]*)\)/.exec(e.message)?.[1]?.split(', ') ?? [];
      return found(
        'several_live',
        ids.length > 0 ? ids : e.stripeRefundId ? [e.stripeRefundId] : [],
      );
    }
    throw e;
  }
}

const findingOf = (r: CustomerRefundView): UnrecordedFinding =>
  r.status === 'cancelled'
    ? 'held_cancelled'
    : r.approval === 'approved'
      ? 'held_unrecorded'
      : 'held_unapproved';

/** An earlier report of this document that has not been delivered successfully to the handler. */
async function reportOpen(trx: Trx, companyId: string, refundId: string): Promise<boolean> {
  const rows = (
    await sql<{ id: string }>`
      SELECT e.id::text FROM app.outbox_event e
       WHERE e.company_id = ${companyId}::uuid AND e.topic = ${STRIPE_REFUND_UNRECORDED}
         AND e.aggregate_id = ${refundId}::uuid
         AND NOT EXISTS (SELECT 1 FROM app.outbox_inbox i
                          WHERE i.event_id = e.id AND i.handler = ${STRIPE_REFUND_UNRECORDED_HANDLER})
       LIMIT 1`.execute(trx)
  ).rows;
  return rows.length > 0;
}

/**
 * Sweep one document: report it once (an outbox event) when Stripe holds a live refund no document
 * records. Returns the finding (null when there is none) and whether a report was published now.
 */
export async function sweepStripeRefund(
  trx: Trx,
  client: StripeClient,
  outbox: DocumentOutbox,
  c: { companyId: string; refundId: string },
): Promise<{ finding: UnrecordedFinding | null; published: boolean }> {
  const companyId = c.companyId.toLowerCase();
  const refundId = c.refundId.toLowerCase();
  const found = await findUnrecordedStripeRefund(trx, client, { companyId, refundId });
  if (!found) return { finding: null, published: false };
  if (await reportOpen(trx, companyId, found.refundId)) {
    return { finding: found.finding, published: false };
  }
  await outbox.publish(trx, {
    companyId,
    topic: STRIPE_REFUND_UNRECORDED,
    aggregateType: 'customer_refund',
    aggregateId: found.refundId,
    payload: {
      refundId: found.refundId,
      refundNo: found.refundNo,
      finding: found.finding,
      stripeRefundIds: [...found.stripeRefundIds],
    },
  });
  return { finding: found.finding, published: true };
}

/** The Sync issue's message: what Stripe holds and what a person does about it. */
export function unrecordedMessage(u: UnrecordedStripeRefund): string {
  const ids = u.stripeRefundIds.join(', ');
  const m =
    u.finding === 'held_unapproved'
      ? `Stripe holds refund ${ids} for refund ${u.refundNo}, which is not approved: the money has left or is leaving, but the books do not show it. An Approver approves ${u.refundNo} to record this Stripe refund (nothing more is sent), or it is dealt with in Stripe.`
      : u.finding === 'held_unrecorded'
        ? `Stripe holds refund ${ids} for approved refund ${u.refundNo}, but LedgerForce has not recorded it. An Approver opens the refund and chooses "Check with Stripe" to record it once; nothing more is sent.`
        : u.finding === 'held_cancelled'
          ? `Stripe holds refund ${ids} for cancelled refund ${u.refundNo}: money has left that no document records. Deal with it in Stripe; LedgerForce refunds nothing more to this customer through Stripe until then.`
          : `Stripe holds several live refunds (${ids}) for refund ${u.refundNo}; nothing was recorded or sent. Check them in Stripe by hand.`;
  return m.slice(0, 1000);
}

interface UnrecordedEvent {
  readonly companyId: string | null;
  readonly aggregateId: string;
}

/** The report's handler (ADR-0103): read-only; fails permanently while the stray is there. */
export function stripeRefundUnrecordedHandler(deps: { client: StripeClient }): {
  readonly name: string;
  readonly topics: readonly string[];
  handle(trx: Trx, event: UnrecordedEvent): Promise<void>;
} {
  return {
    name: STRIPE_REFUND_UNRECORDED_HANDLER,
    topics: [STRIPE_REFUND_UNRECORDED],
    async handle(trx, event) {
      if (!event.companyId) throw new StripeRefundError('INVALID_REFUND', 'event has no company');
      const found = await findUnrecordedStripeRefund(trx, deps.client, {
        companyId: event.companyId,
        refundId: event.aggregateId,
      });
      if (found) {
        throw new StripeRefundError(
          'HELD_AT_STRIPE',
          unrecordedMessage(found),
          found.stripeRefundIds[0] ?? null,
        );
      }
    },
  };
}
