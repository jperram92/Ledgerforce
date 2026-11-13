/**
 * Supplier payment batches over HTTP (T-0054, UC-06, design §6.5 rule 1, DL-0291). Thin: validates
 * and calls @ledgerforce/ap. PUT /ap/payment-batches/:id builds a batch from the bills due by a
 * date (client-chosen id; SoD step payment_batch.create recorded against it). POST
 * /ap/payment-batches/:id/release needs a fresh step-up (ADR-0025) and passes the SoD engine with
 * the batch total read from the database: creator ≠ releaser (SOD_BATCH_SELF_RELEASE) and, above
 * the two-releaser threshold, nobody releases twice (SOD_BATCH_SAME_RELEASER).
 * POST /ap/payment-batches/:id/aba returns the ABA (Cemtex) file of a released batch as an
 * attachment (T-0056, DL-0292): it unseals account numbers, so it is a POST — audited like a
 * mutation — and needs ap.payment_batch.release; it changes nothing and can be repeated.
 * POST /ap/payment-batches/:id/confirm records the bank's confirmation of a released batch
 * (T-0057, DL-0304): GP-009 posts (one entry per batch) with its `ledger.entry.posted` outbox
 * event in the same transaction — the event sends the remittance advices — so the route answers
 * 503 queue_not_configured without the posting queue. It needs ap.payment_batch.release (only
 * releasers record that the money left the bank); design §6.5 has no SoD rule for it. A repeat
 * returns the first confirmation (replayed).
 */
import {
  BadRequestException,
  Inject,
  Body,
  NotFoundException,
  Controller,
  Get,
  HttpCode,
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
  AbaExportError,
  confirmPaymentBatch,
  createPaymentBatch,
  exportPaymentBatchAba,
  getPaymentBatch,
  listPaymentBatches,
  PaymentBatchError,
  paymentBatchNames,
  type PaymentBatchNames,
  releasePaymentBatch,
  type PaymentBatchView,
  type PaymentConfirmationView,
} from '@ledgerforce/ap';
import type { PostingOutbox } from '@ledgerforce/ledger';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { KMS, POSTING_OUTBOX } from '../tokens.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_payment_batch', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof PaymentBatchError || e instanceof AbaExportError) {
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
  confirmation: b.confirmation
    ? {
        entry_id: b.confirmation.entryId,
        confirmed_on: b.confirmation.confirmedOn,
        bank_reference: b.confirmation.bankReference,
        confirmed_by: b.confirmation.confirmedBy,
        confirmed_at: b.confirmation.confirmedAt.toISOString(),
      }
    : null,
});

/** The view with names instead of bare ids, payee accounts masked (T-0153, for T-0087). */
const namedViewOf = (b: PaymentBatchView, n: PaymentBatchNames) => {
  const v = viewOf(b);
  return {
    ...v,
    created_by: b.createdBy,
    created_by_name: b.createdBy === null ? null : (n.users.get(b.createdBy) ?? null),
    releases: b.releases.map((r, i) => ({
      ...v.releases[i],
      released_by_name: r.releasedBy === null ? null : (n.users.get(r.releasedBy) ?? null),
    })),
    payments: b.payments.map((p, i) => {
      const a = n.accounts.get(p.bankAccountId);
      return {
        ...v.payments[i],
        bill_no: n.bills.get(p.billId) ?? null,
        party_name: n.parties.get(p.partyId) ?? null,
        bank_account: a ? { bsb: a.bsb, account_number: a.accountNumber } : null,
      };
    }),
    excluded: b.excluded.map((x, i) => ({
      ...v.excluded[i],
      bill_no: n.bills.get(x.billId) ?? null,
      party_name: n.parties.get(x.partyId) ?? null,
    })),
  };
};

const confirmationOf = (c: PaymentConfirmationView) => ({
  batch_id: c.batchId,
  batch_no: c.batchNo,
  entry_id: c.entryId,
  confirmed_on: c.confirmedOn,
  bank_reference: c.bankReference,
  confirmed_by: c.confirmedBy,
  total: c.total,
  replayed: c.replayed,
  payments: c.payments.map((x) => ({
    bill_id: x.billId,
    bill_no: x.billNo,
    party_id: x.partyId,
    amount: x.amount,
  })),
  remittance_missing: c.remittanceMissing,
});

@Controller('ap/payment-batches')
export class ApPaymentBatchesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(KMS) private readonly kms: Kms | null,
    @Inject(POSTING_OUTBOX) private readonly outbox: PostingOutbox | null,
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

  /** The company's batches, newest first (T-0153): what the release screen lists. */
  @Get()
  @RequirePermission('ap.read')
  async list(@Query('company_id') companyId: string | undefined) {
    const rows = await listPaymentBatches(this.tx.get(), uuid(companyId, 'company_id'));
    return {
      batches: rows.map((b) => ({
        id: b.batchId,
        batch_no: b.batchNo,
        status: b.status,
        payment_date: b.paymentDate,
        total: b.total,
        payment_count: b.paymentCount,
        excluded_count: b.excludedCount,
        releases_required: b.releasesRequired,
        release_count: b.releaseCount,
        created_by_name: b.createdByName,
        created_at: b.createdAt.toISOString(),
      })),
    };
  }

  /** One batch with names (T-0153); a batch not in the caller's company is 404. */
  @Get(':id')
  @RequirePermission('ap.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    const trx = this.tx.get();
    const b = await getPaymentBatch(trx, uuid(companyId, 'company_id'), uuid(id, 'id')).catch(
      (e: unknown) => {
        if (e instanceof PaymentBatchError && e.code === 'INVALID_BATCH') {
          throw new NotFoundException({ error: 'not_found' });
        }
        return refusal(e);
      },
    );
    return namedViewOf(b, await paymentBatchNames(trx, b));
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

  @Post(':id/aba')
  @HttpCode(200)
  @RequirePermission('ap.payment_batch.release')
  async aba(
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ): Promise<string> {
    if (!this.kms) throw new ServiceUnavailableException({ error: 'kms_not_configured' });
    const file = await exportPaymentBatchAba(this.tx.get(), this.kms, {
      companyId: uuid(companyId, 'company_id'),
      batchId: uuid(id, 'id'),
    }).catch(refusal);
    this.audit.describe({
      entityType: 'payment_batch',
      entityId: file.batchId,
      after: { aba_file: file.fileName, payment_count: file.paymentCount, total: file.total },
    });
    res.setHeader('Content-Type', 'text/plain; charset=us-ascii');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return file.content;
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('ap.payment_batch.release')
  async confirm(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
    @Body() body: unknown,
  ) {
    const b = obj(body);
    const confirmedOn = str(b['confirmed_on'], 'confirmed_on');
    const ref = b['bank_reference'];
    if (ref !== undefined && ref !== null && typeof ref !== 'string') {
      bad('bank_reference must be a string');
    }
    if (!this.outbox) throw new ServiceUnavailableException({ error: 'queue_not_configured' });
    const by = actorOf(req);
    const c = await confirmPaymentBatch(
      this.tx.get(),
      {
        companyId: uuid(companyId, 'company_id'),
        batchId: uuid(id, 'id'),
        confirmedOn,
        ...(typeof ref === 'string' ? { bankReference: ref } : {}),
        ...(by ? { confirmedBy: by } : {}),
      },
      { outbox: this.outbox },
    ).catch(refusal);
    if (!c.replayed) {
      this.audit.describe({
        entityType: 'payment_batch',
        entityId: c.batchId,
        after: {
          entry_id: c.entryId,
          confirmed_on: c.confirmedOn,
          bank_reference: c.bankReference,
          total: c.total,
        },
      });
    }
    return confirmationOf(c);
  }
}
