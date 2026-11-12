/**
 * Supplier payment batches over HTTP (T-0054, UC-06, design §6.5 rule 1, DL-0291). Thin: validates
 * and calls @ledgerforce/ap. PUT /ap/payment-batches/:id builds a batch from the bills due by a
 * date (client-chosen id; SoD step payment_batch.create recorded against it). POST
 * /ap/payment-batches/:id/release needs a fresh step-up (ADR-0025) and passes the SoD engine with
 * the batch total read from the database: creator ≠ releaser (SOD_BATCH_SELF_RELEASE) and, above
 * the two-releaser threshold, nobody releases twice (SOD_BATCH_SAME_RELEASER).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createPaymentBatch,
  getPaymentBatch,
  PaymentBatchError,
  releasePaymentBatch,
  type PaymentBatchView,
} from '@ledgerforce/ap';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_payment_batch', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof PaymentBatchError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};
const obj = (v: unknown) =>
  (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const str = (v: unknown, name: string): string =>
  typeof v === 'string' ? v : bad(`${name} is required`);
const actorOf = (req: Request) => principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;

const idFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

/** The batch and its total from the database (the amount the two-releaser threshold applies to). */
const idWithTotal: SubjectFrom = async (req, trx) => {
  const { id } = await idFromParam(req, trx, 'payment_batch.release');
  const companyId = req.query['company_id'];
  if (typeof companyId !== 'string' || !UUID.test(companyId)) throw new InvalidSodSubject();
  const b = await getPaymentBatch(trx, companyId, id).catch(() => null);
  return { id, amount: b?.total ?? null };
};

const viewOf = (b: PaymentBatchView) => ({
  id: b.batchId,
  batch_no: b.batchNo,
  status: b.status,
  payment_date: b.paymentDate,
  account_id: b.accountId,
  total: b.total,
  payment_count: b.paymentCount,
  releases_required: b.releasesRequired,
  releases: b.releases.map((r) => ({
    released_by: r.releasedBy,
    released_at: r.releasedAt.toISOString(),
  })),
  payments: b.payments.map((p) => ({
    bill_id: p.billId,
    party_id: p.partyId,
    amount: p.amount,
    bank_account_id: p.bankAccountId,
  })),
  excluded: b.excluded.map((x) => ({
    bill_id: x.billId,
    party_id: x.partyId,
    amount: x.amount,
    reason: x.reason,
    payable_from: x.payableFrom?.toISOString() ?? null,
  })),
});

@Controller('ap/payment-batches')
export class ApPaymentBatchesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Put(':id')
  @HttpCode(201)
  @RequirePermission('ap.payment_batch.create')
  @SoD('payment_batch.create', idFromParam)
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = obj(body);
    const by = actorOf(req);
    const batch = await createPaymentBatch(this.tx.get(), {
      companyId: uuid(b['company_id'], 'company_id'),
      id: uuid(id, 'id'),
      paymentDate: str(b['payment_date'], 'payment_date'),
      dueBy: str(b['due_by'], 'due_by'),
      accountId: uuid(b['account_id'], 'account_id'),
      ...(by ? { createdBy: by } : {}),
    }).catch(refusal);
    if (batch.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'payment_batch',
        entityId: batch.batchId,
        after: { batch_no: batch.batchNo, total: batch.total, payment_count: batch.paymentCount },
      });
    return viewOf(batch);
  }

  @Get(':id')
  @RequirePermission('ap.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    return viewOf(
      await getPaymentBatch(this.tx.get(), uuid(companyId, 'company_id'), uuid(id, 'id')).catch(
        refusal,
      ),
    );
  }

  @Post(':id/release')
  @HttpCode(200)
  @RequirePermission('ap.payment_batch.release')
  @RequireStepUp(300)
  @SoD('payment_batch.release', idWithTotal)
  async release(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const by = actorOf(req);
    const b = await releasePaymentBatch(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      batchId: uuid(id, 'id'),
      ...(by ? { releasedBy: by } : {}),
    }).catch(refusal);
    this.audit.describe({
      entityType: 'payment_batch',
      entityId: b.batchId,
      after: {
        status: b.status,
        releases: b.releases.length,
        releases_required: b.releasesRequired,
      },
    });
    return viewOf(b);
  }
}
