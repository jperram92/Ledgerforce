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
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
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
} from '@ledgerforce/ar';
import { PostingError } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

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

function viewOf(r: CustomerRefundView) {
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
  };
}

@Controller('ar')
export class ArRefundsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

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
    const r = await createCustomerRefund(this.tx.get(), {
      companyId,
      id: uuid(id, 'id'),
      partyId,
      refundDate: refundDate as string,
      amount: amount as string,
      method: method as 'bank_batch' | 'stripe',
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(createdBy ? { createdBy } : {}),
    }).catch(refusal);
    if (r.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'customer_refund',
        entityId: r.refundId,
        after: viewOf(r),
      });
    return viewOf(r);
  }

  @Post('refunds/:id/approve')
  @HttpCode(200)
  @RequirePermission('ar.refund.approve')
  @SoD('refund.approve', idFromParam)
  async approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('company_id') companyId: string | undefined,
  ) {
    const approvedBy = actorOf(req);
    if (!approvedBy) bad('an approval needs a signed-in user');
    const r = await approveCustomerRefund(this.tx.get(), {
      companyId: uuid(companyId, 'company_id'),
      refundId: uuid(id, 'id'),
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
    return viewOf(
      await getCustomerRefund(this.tx.get(), uuid(companyId, 'company_id'), uuid(id, 'id')).catch(
        refusal,
      ),
    );
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
