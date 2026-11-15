/**
 * Customer refunds over HTTP (T-0152, UC-11, SS-UC11-08, ADR-0074, DL-0477 item 3). Thin: validates
 * and calls @ledgerforce/ar.
 *   PUT  /ar/refunds/:id                   ar.refund.create, SoD refund.create (client id; replay 200)
 *   POST /ar/refunds/:id/approve           ar.refund.approve, SoD refund.approve (the creator is
 *                                          refused, SOD_REFUND_SELF_APPROVAL); a repeat replays
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
 * refund's view carries `stripe: { status: not_sent | pending | sent | failed, ... }`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  STRIPE_REFUND_APPROVED,
  stripeRefundOf,
  stripeRefundToday,
  trySendStripeCustomerRefund,
  type StripeClient,
  type StripeSendOutcome,
} from '@ledgerforce/connector-stripe';
import type { Database } from '@ledgerforce/db';
import { PostingError, type PostingOutbox } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import type { Transaction } from 'kysely';
import type { Clock } from '../auth/session.service.ts';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import {
  RequirePermission,
  RequireStepUp,
  type StepUpCondition,
} from '../authz/permission.decorator.ts';
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
}

/** What is known of a Stripe refund's send, from what is stored (no Stripe call). */
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
  if (r.status === 'requested' && r.approval === 'approved')
    return { status: 'pending', stripe_refund_id: null, message: null };
  return { status: 'not_sent', stripe_refund_id: null, message: null };
}

const sentView = (o: StripeSendOutcome): StripeView =>
  o.status === 'sent'
    ? { status: 'sent', stripe_refund_id: o.stripeRefundId, message: null }
    : { status: o.status, stripe_refund_id: null, message: o.message };

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
    // A Stripe refund (ADR-0083): approve, record the outbox event, then send in a savepoint.
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
