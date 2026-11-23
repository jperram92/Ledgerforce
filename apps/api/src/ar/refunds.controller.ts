/**
 * Customer refunds over HTTP (T-0152, UC-11, SS-UC11-08, ADR-0074, DL-0477 item 3). Thin: validates
 * and calls @ledgerforce/ar.
 *   PUT  /ar/refunds/:id                   ar.refund.create, SoD refund.create (client id; replay 200)
 *   POST /ar/refunds/:id/approve           ar.refund.approve, SoD refund.approve (the creator is
 *                                          refused, SOD_REFUND_SELF_APPROVAL); a repeat replays
 *   POST /ar/refunds/:id/cancel            ar.refund.create, Idempotency-Key: a requested refund,
 *                                          approved or not — Stripe: none live at Stripe (T-0190);
 *                                          bank: no live payment batch pays it (T-0207,
 *                                          ADR-0107); a repeat replays
 *   POST /ar/refunds/:id/stripe-check      ar.refund.approve: reconcile with Stripe, never a create
 *                                          (T-0189, ADR-0091)
 *   PUT  /ar/refunds/:id/stripe-resends/:r ar.refund.approve, SoD refund_resend.request: ask a resend
 *   POST …/stripe-resends/:r/confirm       ar.refund.approve, step-up 300 s, SoD refund_resend.confirm
 *                                          (another person): sends with lf-refund-v3-<r>
 *   GET  /ar/refunds/:id                   ar.read
 *   GET  /ar/refunds/:id/journal           ar.read: the engine's GP-006 preview, writes nothing
 *   GET  /ar/parties/:id/credit            ar.read: balance / requested / available
 * A bank refund is paid only by the AP payment batch (its own release rules), which takes approved
 * refunds only. Another tenant's (or company's) party or refund is 404.
 *
 * Stripe refunds (T-0172, ADR-0083, DL-0562): `method: stripe` needs the Stripe client and both
 * outboxes (else PUT is 422 METHOD_NOT_AVAILABLE and approve 503). Approving one needs a step-up
 * no older than 300 s (checked by the interceptor through the route's condition) and sends it:
 * the approval and the outbox event `ar.refund.stripe_approved` commit together, the send runs in
 * a savepoint (GP-006 Stripe variant) and, if it fails, the outbox handler retries. A Stripe
 * refund's view carries `stripe: { status: not_sent | pending | sent | failed, ... }`; a failed
 * send also carries `code` — SENT_NOT_POSTED (with `stripe_refund_id`) when Stripe has the money
 * out but the journal could not be written (security review r8 F1, RQ-0164).
 * The handler re-checks that the interceptor verified the step-up before it approves a Stripe
 * refund, so a refund that turned Stripe after the route's condition read it is refused (F3).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  approveCustomerRefund,
  cancelCustomerRefund,
  createCustomerRefund,
  customerCredit,
  getCustomerRefund,
  previewCustomerRefundJournal,
  RefundError,
  type CustomerRefundView,
  type DocumentOutbox,
} from '@ledgerforce/ar';
import {
  assertStripeRefundable,
  cancelStripeCustomerRefund,
  checkStripeCustomerRefund,
  confirmStripeRefundResend,
  requestStripeRefundResend,
  StripeRefundError,
  type StripeRefundResendView,
  STRIPE_REFUND_APPROVED,
  STRIPE_REFUND_SEND_HANDLER,
  STRIPE_REFUND_SEND_WINDOW_MS,
  stripeRefundOf,
  stripeRefundToday,
  trySendStripeCustomerRefund,
  type StripeClient,
  type StripeSendOutcome,
} from '@ledgerforce/connector-stripe';
import type { Database } from '@ledgerforce/db';
import { PostingError, type PostingOutbox } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import type { Clock } from '../auth/session.service.ts';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { StepUpRequired } from '../authz/mfa.ts';
import {
  RequirePermission,
  RequireStepUp,
  type StepUpCondition,
} from '../authz/permission.decorator.ts';
import { requireKey } from '../settings/settings-common.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { CLOCK, DOCUMENT_OUTBOX, POSTING_OUTBOX, STRIPE_REFUNDS } from '../tokens.ts';

/** Stripe refunds (ADR-0083): the client the approve step sends with (test mode unless live). */
export interface StripeRefundsOptions {
  readonly client: StripeClient;
}

/** DL-0562: approving a Stripe refund moves money at once, so it needs a fresh step-up. */
const STRIPE_REFUND_STEP_UP_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_refund', message });
};
const notFound = (what: string): never => {
  throw new NotFoundException({ error: 'not_found', message: `${what} not found` });
};
const refusal = (e: unknown): never => {
  if (e instanceof RefundError && e.code === 'REFUND_NOT_FOUND') notFound('refund');
  if (e instanceof StripeRefundError && e.code === 'RESEND_NOT_FOUND') notFound('resend');
  if (
    e instanceof StripeRefundError &&
    (e.code === 'AT_STRIPE' || e.code === 'ALREADY_CONFIRMED')
  ) {
    throw new ConflictException({
      error: e.code,
      message: e.message,
      ...(e.stripeRefundId ? { stripe_refund_id: e.stripeRefundId } : {}),
    });
  }
  if (e instanceof StripeRefundError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  if (e instanceof RefundError && e.code === 'AT_STRIPE') {
    throw new ConflictException({ error: e.code, message: e.message });
  }
  if (e instanceof RefundError && e.code === 'PARTY_NOT_FOUND') notFound('party');
  if (e instanceof RefundError || e instanceof PostingError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);

const idFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

/** ADR-0091: the subject of the resend's SoD steps is the resend (its client id). */
const resendFromParam: SubjectFrom = (req) => {
  const id = req.params['resendId'];
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

const resendView = (v: StripeRefundResendView) => ({
  id: v.resendId,
  refund_id: v.refundId,
  replayed: v.replayed,
  status: v.status,
  requested_by: v.requestedBy,
  requested_at: v.requestedAt,
  reason: v.reason,
  confirmed_by: v.confirmedBy,
  confirmed_at: v.confirmedAt,
  idempotency_key: v.idempotencyKey,
});

const actorOf = (req: Request) => principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;

/**
 * The approve route's step-up condition (ADR-0083): only a Stripe refund of the company needs it.
 * Read under RLS: another tenant's (or a malformed) refund needs none here and the handler answers
 * 400/404; a refund's method never changes (0055 guard).
 */
export const stripeRefundOnly: StepUpCondition = async (req, trx) => {
  const id = req.params['id'];
  const companyId = req.query['company_id'];
  if (typeof id !== 'string' || !UUID.test(id)) return false;
  if (typeof companyId !== 'string' || !UUID.test(companyId)) return false;
  const r = await trx
    .selectFrom('app.customer_refund')
    .select('method')
    .where('company_id', '=', companyId.toLowerCase())
    .where('id', '=', id.toLowerCase())
    .executeTakeFirst();
  return r?.method === 'stripe';
};

interface StripeView {
  status: 'not_sent' | 'pending' | 'sent' | 'failed';
  stripe_refund_id: string | null;
  message: string | null;
  /** Only when failed: why (e.g. SENT_NOT_POSTED: Stripe has the refund, the books do not). */
  code?: string;
}

/**
 * What is known of a Stripe refund's send, from what is stored (no Stripe call). An approved,
 * requested refund whose send is an open (or ignored) Sync issue is `failed` with that issue's
 * code and message (T-0190), so the refund region can offer Cancel after a reload.
 */
async function storedStripeView(
  trx: Transaction<Database>,
  companyId: string,
  r: CustomerRefundView,
): Promise<StripeView | undefined> {
  if (r.method !== 'stripe') return undefined;
  if (r.status === 'paid') {
    const s = await stripeRefundOf(trx, companyId, r.entryId);
    return { status: 'sent', stripe_refund_id: s?.stripeRefundId ?? null, message: null };
  }
  if (r.status === 'requested' && r.approval === 'approved') {
    const issue = (
      await sql<{ code: string; message: string }>`
        SELECT coalesce(i.error_code, i.error_name) AS code, i.error_message AS message
          FROM app.sync_issue i JOIN app.outbox_event e ON e.id = i.event_id
         WHERE e.company_id = ${companyId}::uuid AND e.topic = ${STRIPE_REFUND_APPROVED}
           AND e.aggregate_id = ${r.refundId} AND i.handler = ${STRIPE_REFUND_SEND_HANDLER}
           AND i.status IN ('open', 'ignored')
         ORDER BY i.last_failed_at DESC, i.id DESC
         LIMIT 1`.execute(trx)
    ).rows[0];
    if (issue)
      return { status: 'failed', stripe_refund_id: null, message: issue.message, code: issue.code };
    // Security review r10 L1: past its window the send has finished (KEY_EXPIRED) even when no
    // worker attempt recorded it, so the region and the cancel rule agree.
    const age = (
      await sql<{ ms: string | null }>`
        SELECT (extract(epoch FROM clock_timestamp() - coalesce(
                  (SELECT max(confirmed_at) FROM app.customer_refund_stripe_resend
                    WHERE company_id = ${companyId}::uuid AND refund_id = ${r.refundId}::uuid),
                  (SELECT approved_at FROM app.customer_refund_approval
                    WHERE company_id = ${companyId}::uuid AND refund_id = ${r.refundId}::uuid)))
                * 1000)::bigint::text AS ms`.execute(trx)
    ).rows[0]?.ms;
    if (age !== null && age !== undefined && Number(age) > STRIPE_REFUND_SEND_WINDOW_MS)
      return {
        status: 'failed',
        stripe_refund_id: null,
        code: 'KEY_EXPIRED',
        message:
          'it was not sent within 23 hours of its approval, so it is no longer sent automatically; check it with Stripe, then resend or cancel it',
      };
    return { status: 'pending', stripe_refund_id: null, message: null };
  }
  return { status: 'not_sent', stripe_refund_id: null, message: null };
}

const sentView = (o: StripeSendOutcome): StripeView =>
  o.status === 'sent'
    ? { status: 'sent', stripe_refund_id: o.stripeRefundId, message: null }
    : o.status === 'failed'
      ? { status: 'failed', stripe_refund_id: o.stripeRefundId, message: o.message, code: o.code }
      : { status: 'pending', stripe_refund_id: null, message: o.message };

function viewOf(r: CustomerRefundView, stripe?: StripeView) {
  return {
    id: r.refundId,
    replayed: r.replayed,
    refund_no: r.refundNo,
    party_id: r.partyId,
    refund_date: r.refundDate,
    amount: r.amount,
    method: r.method,
    status: r.status,
    approval: r.approval,
    created_by: r.createdBy,
    approved_by: r.approvedBy,
    approved_at: r.approvedAt,
    entry_id: r.entryId,
    paid_on: r.paidOn,
    // T-0207 (ADR-0107): the live payment batch paying a bank refund, so Cancel is offered only
    // when no batch pays it.
    ...(r.method === 'bank_batch'
      ? {
          payment_batch: r.paymentBatch
            ? {
                id: r.paymentBatch.batchId,
                batch_no: r.paymentBatch.batchNo,
                status: r.paymentBatch.status,
              }
            : null,
        }
      : {}),
    ...(stripe ? { stripe } : {}),
  };
}

@Controller('ar')
export class ArRefundsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STRIPE_REFUNDS) private readonly stripe: StripeRefundsOptions | null,
    @Inject(DOCUMENT_OUTBOX) private readonly documents: DocumentOutbox | null,
    @Inject(POSTING_OUTBOX) private readonly posting: PostingOutbox | null,
  ) {}

  /** Stripe refunds need the client and both outboxes (the retry path); null when not configured. */
  private stripeDeps() {
    return this.stripe && this.documents && this.posting
      ? { client: this.stripe.client, documents: this.documents, posting: this.posting }
      : null;
  }

  @Put('refunds/:id')
  @HttpCode(201)
  @RequirePermission('ar.refund.create')
  @SoD('refund.create', idFromParam)
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const companyId = uuid(b['company_id'], 'company_id');
    const partyId = uuid(b['party_id'], 'party_id');
    const refundDate = b['refund_date'];
    const amount = b['amount'];
    const method = b['method'];
    const reason = b['reason'];
    if (typeof refundDate !== 'string' || !DATE.test(refundDate))
      bad('refund_date must be YYYY-MM-DD');
    if (typeof amount !== 'string') bad('amount must be a decimal string');
    if (method !== 'bank_batch' && method !== 'stripe') bad('method is bank_batch or stripe');
    if (reason !== undefined && typeof reason !== 'string') bad('reason must be text');
    const createdBy = actorOf(req);
    const trx = this.tx.get();
    const r = await createCustomerRefund(
      trx,
      {
        companyId,
        id: uuid(id, 'id'),
        partyId,
        refundDate: refundDate as string,
        amount: amount as string,
        method: method as 'bank_batch' | 'stripe',
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(createdBy ? { createdBy } : {}),
      },
      this.stripeDeps() ? { stripeCheck: assertStripeRefundable } : {},
    ).catch(refusal);
    const view = viewOf(r, await storedStripeView(trx, companyId, r));
    if (r.replayed) res.status(200);
    else this.audit.describe({ entityType: 'customer_refund', entityId: r.refundId, after: view });
    return view;
  }

  @Post('refunds/:id/approve')
  @HttpCode(200)
  @RequirePermission('ar.refund.approve')
  @RequireStepUp(STRIPE_REFUND_STEP_UP_SECONDS, stripeRefundOnly)
  @SoD('refund.approve', idFromParam)
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const approvedBy = actorOf(req);
    if (!approvedBy) bad('an approval needs a signed-in user');
    const cid = uuid(companyId, 'company_id');
    const refundId = uuid(id, 'id');
    const trx = this.tx.get();
    const current = await getCustomerRefund(trx, cid, refundId).catch(refusal);
    if (current.method !== 'stripe') {
      const r = await approveCustomerRefund(trx, {
        companyId: cid,
        refundId,
        approvedBy: approvedBy as string,
      }).catch(refusal);
      if (!r.replayed)
        this.audit.describe({
          entityType: 'customer_refund',
          entityId: r.refundId,
          after: viewOf(r),
        });
      return viewOf(r);
    }
    // A Stripe refund (ADR-0083) moves money: refuse unless the interceptor verified the step-up
    // for this request, whatever the route's condition read before (security review r8 F3).
    if (!this.tx.stepUpVerified(STRIPE_REFUND_STEP_UP_SECONDS)) {
      throw new StepUpRequired(STRIPE_REFUND_STEP_UP_SECONDS);
    }
    // Approve, record the outbox event, then send in a savepoint.
    const deps = this.stripeDeps();
    if (!deps) throw new ServiceUnavailableException({ error: 'stripe_refunds_unavailable' });
    const now = this.clock.now();
    const approved = await approveCustomerRefund(trx, {
      companyId: cid,
      refundId,
      approvedBy: approvedBy as string,
      today: await stripeRefundToday(trx, now),
    }).catch(refusal);
    // A repeat replays what is stored; the outbox handler owns any retry of the send.
    if (approved.replayed) return viewOf(approved, await storedStripeView(trx, cid, approved));
    await deps.documents.publish(trx, {
      companyId: cid,
      topic: STRIPE_REFUND_APPROVED,
      aggregateType: 'customer_refund',
      aggregateId: approved.refundId,
      payload: { refundId: approved.refundId, refundNo: approved.refundNo },
    });
    const outcome = await trySendStripeCustomerRefund(
      trx,
      deps.client,
      { companyId: cid, refundId: approved.refundId, now, createdBy: approvedBy as string },
      { outbox: deps.posting },
    );
    const r = await getCustomerRefund(trx, cid, approved.refundId);
    const view = viewOf(r, sentView(outcome));
    this.audit.describe({ entityType: 'customer_refund', entityId: r.refundId, after: view });
    return view;
  }

  /**
   * Cancel a requested refund (T-0190, T-0207; RQ-0173, RQ-0189, ADR-0107), approved or not. A
   * Stripe one: Stripe is asked first under the party lock (409 AT_STRIPE when Stripe holds one;
   * 503 without the Stripe client). A bank one: 422 NOT_CANCELLABLE while a live payment batch
   * pays it. Paid: 422 NOT_CANCELLABLE. A repeat replays (200). Permission `ar.refund.create`:
   * whoever may ask for a refund may take the request back; no SoD step and no step-up, because
   * cancelling moves no money and only lowers what can leave. Idempotency-Key required (not
   * stored: the route is idempotent by state). Audited.
   */
  @Post('refunds/:id/cancel')
  @HttpCode(200)
  @RequirePermission('ar.refund.create')
  async cancel(
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    requireKey(key);
    const cid = uuid(companyId, 'company_id');
    const refundId = uuid(id, 'id');
    const trx = this.tx.get();
    const current = await getCustomerRefund(trx, cid, refundId).catch(refusal);
    const deps = this.stripeDeps();
    if (current.method === 'stripe' && current.status === 'requested' && !deps) {
      throw new ServiceUnavailableException({ error: 'stripe_refunds_unavailable' });
    }
    const r = await (
      deps
        ? cancelStripeCustomerRefund(trx, deps.client, { companyId: cid, refundId })
        : cancelCustomerRefund(trx, { companyId: cid, refundId })
    ).catch(refusal);
    const view = viewOf(r, await storedStripeView(trx, cid, r));
    if (!r.replayed)
      this.audit.describe({
        entityType: 'customer_refund',
        entityId: r.refundId,
        before: viewOf(current),
        after: view,
      });
    return view;
  }

  /**
   * Check a Stripe refund with Stripe (T-0189, ADR-0091): read-only at Stripe, never a create. A
   * live refund carrying the document's id is recorded once (GP-006 Stripe variant, dated the
   * Stripe refund date) when the document is approved; otherwise the answer says what Stripe
   * holds and whether a resend may be asked. No step-up: no money moves.
   */
  @Post('refunds/:id/stripe-check')
  @HttpCode(200)
  @RequirePermission('ar.refund.approve')
  async stripeCheck(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const cid = uuid(companyId, 'company_id');
    const refundId = uuid(id, 'id');
    const trx = this.tx.get();
    await getCustomerRefund(trx, cid, refundId).catch(refusal);
    const deps = this.stripeDeps();
    if (!deps) throw new ServiceUnavailableException({ error: 'stripe_refunds_unavailable' });
    const actor = actorOf(req);
    const c = await checkStripeCustomerRefund(
      trx,
      deps.client,
      { companyId: cid, refundId, now: this.clock.now(), ...(actor ? { createdBy: actor } : {}) },
      { outbox: deps.posting },
    ).catch(refusal);
    const refund = viewOf(c.refund, await storedStripeView(trx, cid, c.refund));
    if (c.outcome === 'recorded' && !c.replayed)
      this.audit.describe({
        entityType: 'customer_refund',
        entityId: c.refund.refundId,
        after: refund,
      });
    return {
      outcome: c.outcome,
      stripe_refund_id: c.stripeRefundId,
      failed_at_stripe: c.failedAtStripe,
      cancelled_held_at_stripe: c.cancelledHeldAtStripe.map((x) => ({
        refund_id: x.refundId,
        stripe_refund_id: x.stripeRefundId,
      })),
      resendable: c.resendable,
      refund,
    };
  }

  /**
   * Ask for a resend of a Stripe refund (T-0189, ADR-0091): client id; only when the normal send is
   * blocked and Stripe holds no live refund (409 AT_STRIPE). SoD step refund_resend.request.
   */
  @Put('refunds/:id/stripe-resends/:resendId')
  @HttpCode(201)
  @RequirePermission('ar.refund.approve')
  @SoD('refund_resend.request', resendFromParam)
  async requestResend(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Param('resendId') resendId: string,
    @Query('company_id') companyId: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = actorOf(req);
    if (!actor) bad('a resend needs a signed-in user');
    const cid = uuid(companyId, 'company_id');
    const refundId = uuid(id, 'id');
    const rid = uuid(resendId, 'resendId');
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const reason = b['reason'];
    if (typeof reason !== 'string' || reason.trim().length < 1 || reason.trim().length > 500)
      bad('reason is 1–500 characters');
    const trx = this.tx.get();
    await getCustomerRefund(trx, cid, refundId).catch(refusal);
    const deps = this.stripeDeps();
    if (!deps) throw new ServiceUnavailableException({ error: 'stripe_refunds_unavailable' });
    const v = await requestStripeRefundResend(trx, deps.client, {
      companyId: cid,
      refundId,
      resendId: rid,
      requestedBy: actor as string,
      reason: reason as string,
      now: this.clock.now(),
    }).catch(refusal);
    const view = resendView(v);
    if (v.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'customer_refund_stripe_resend',
        entityId: v.resendId,
        after: view,
      });
    return view;
  }

  /**
   * Confirm a resend (T-0189, ADR-0091): another person (SoD SOD_REFUND_RESEND_SELF_CONFIRM, no
   * small-team exception; the database refuses it too), with a step-up no older than 300 s, since
   * it sends money. Then, as the approve route: an outbox event `ar.refund.stripe_approved` and the
   * send in a savepoint with the resend's recorded key. A repeat replays without a Stripe call.
   */
  @Post('refunds/:id/stripe-resends/:resendId/confirm')
  @HttpCode(200)
  @RequirePermission('ar.refund.approve')
  @RequireStepUp(STRIPE_REFUND_STEP_UP_SECONDS)
  @SoD('refund_resend.confirm', resendFromParam)
  async confirmResend(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('resendId') resendId: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const actor = actorOf(req);
    if (!actor) bad('a confirmation needs a signed-in user');
    const cid = uuid(companyId, 'company_id');
    const refundId = uuid(id, 'id');
    const rid = uuid(resendId, 'resendId');
    const trx = this.tx.get();
    await getCustomerRefund(trx, cid, refundId).catch(refusal);
    const deps = this.stripeDeps();
    if (!deps) throw new ServiceUnavailableException({ error: 'stripe_refunds_unavailable' });
    // Security review r10 L3: this route sends money, so, as approve, refuse unless the interceptor
    // verified the step-up for this request (DL-0692: the handler check is the final gate).
    if (!this.tx.stepUpVerified(STRIPE_REFUND_STEP_UP_SECONDS)) {
      throw new StepUpRequired(STRIPE_REFUND_STEP_UP_SECONDS);
    }
    const v = await confirmStripeRefundResend(trx, {
      companyId: cid,
      refundId,
      resendId: rid,
      confirmedBy: actor as string,
    }).catch(refusal);
    if (v.replayed) {
      const r = await getCustomerRefund(trx, cid, refundId);
      return { resend: resendView(v), refund: viewOf(r, await storedStripeView(trx, cid, r)) };
    }
    await deps.documents.publish(trx, {
      companyId: cid,
      topic: STRIPE_REFUND_APPROVED,
      aggregateType: 'customer_refund',
      aggregateId: refundId,
      payload: { refundId, resendId: v.resendId },
    });
    const outcome = await trySendStripeCustomerRefund(
      trx,
      deps.client,
      { companyId: cid, refundId, now: this.clock.now(), createdBy: actor as string },
      { outbox: deps.posting },
    );
    const r = await getCustomerRefund(trx, cid, refundId);
    const refund = viewOf(r, sentView(outcome));
    this.audit.describe({
      entityType: 'customer_refund_stripe_resend',
      entityId: v.resendId,
      after: { resend: resendView(v), refund },
    });
    return { resend: resendView(v), refund };
  }

  /** "Show me the journal" (SS-UC11-08): GP-006 as the engine previews it; writes nothing. */
  @Get('refunds/:id/journal')
  @RequirePermission('ar.read')
  async journal(
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
    @Query('account_id') accountId: string | undefined,
  ) {
    const p = await previewCustomerRefundJournal(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      refundId: uuid(id, 'id'),
      ...(accountId === undefined ? {} : { accountId: uuid(accountId, 'account_id') }),
    }).catch(refusal);
    return {
      entry_date: p.entryDate,
      requested_date: p.requestedDate,
      redirected: p.redirected,
      needs_override: p.needsOverride,
      base_currency: p.baseCurrency,
      total: p.total,
      bank_account_source: p.bankAccountSource,
      lines: p.lines.map((l) => ({
        line_no: l.lineNo,
        account_id: l.accountId,
        account_code: l.accountCode,
        account_name: l.accountName,
        account_type: l.accountType,
        debit: l.debit,
        credit: l.credit,
        party_id: l.partyId,
      })),
    };
  }

  @Get('refunds/:id')
  @RequirePermission('ar.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    const cid = uuid(companyId, 'company_id');
    const trx = this.tx.get();
    const r = await getCustomerRefund(trx, cid, uuid(id, 'id')).catch(refusal);
    return viewOf(r, await storedStripeView(trx, cid, r));
  }

  @Get('parties/:id/credit')
  @RequirePermission('ar.read')
  async credit(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    const cid = uuid(companyId, 'company_id');
    const partyId = uuid(id, 'id');
    const trx = this.tx.get();
    const party = await trx
      .selectFrom('app.party')
      .select('id')
      .where('company_id', '=', cid)
      .where('id', '=', partyId)
      .executeTakeFirst();
    if (!party) notFound('party');
    const c = await customerCredit(trx, cid, partyId);
    return {
      party_id: partyId,
      balance: c.balance,
      requested: c.requested,
      available: c.available,
    };
  }
}
