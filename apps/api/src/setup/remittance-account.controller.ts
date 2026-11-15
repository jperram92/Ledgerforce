/**
 * The bank account printed on customer invoices over HTTP (T-0180, SS-UC01-17, ADR-0079 control 2,
 * ADR-0080). Thin: validates and calls @ledgerforce/ar. Changing it is maker-checker:
 *   GET  /setup/remittance-account?company_id=            settings.read: account in force and the
 *                                                         pending change, masked
 *   PUT  /setup/remittance-account/changes/:id            settings.setup.manage + step-up (300 s),
 *        {company_id, bank_account_id | null}             SoD remittance_change.request; client id;
 *                                                         201 new, 200 replay
 *   POST /setup/remittance-account/changes/:id/approve    settings.setup.manage + step-up, SoD
 *        {company_id}                                     remittance_change.approve (the requester is
 *                                                         refused, SOD_REMITTANCE_SELF_APPROVAL);
 *                                                         a repeat by the approver replays
 *   POST /setup/remittance-account/changes/:id/reject     settings.setup.manage; {company_id, reason}
 * Every change is audited with the accounts masked to the last 3 digits; no route ever returns or
 * logs a clear account number (ADR-0018). Another tenant's (or company's) data is 404.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
  approveRemittanceAccountChange,
  rejectRemittanceAccountChange,
  remittanceAccountOf,
  RemittanceAccountError,
  requestRemittanceAccountChange,
  type MaskedRemittanceAccount,
  type RemittanceChangeView,
} from '@ledgerforce/ar';
import type { Request, Response } from 'express';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { InvalidSodSubject, SoD, type SubjectFrom } from '../sod/sod.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

/** Step-up window, as for supplier bank-detail changes (design §6.2, ADR-0025). */
const STEP_UP_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const bodyOf = (b: unknown) =>
  (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>;

const refusal = (e: unknown): never => {
  if (e instanceof RemittanceAccountError) {
    const body = { error: e.code, message: e.message };
    switch (e.code) {
      case 'INVALID_REMITTANCE_CHANGE':
        throw new BadRequestException({ ...body, error: 'invalid_request' });
      case 'UNKNOWN_COMPANY':
      case 'BANK_ACCOUNT_NOT_FOUND':
      case 'CHANGE_NOT_FOUND':
        throw new NotFoundException(body);
      case 'CHANGE_PENDING':
      case 'CHANGE_ID_CONFLICT':
      case 'NOT_PENDING':
      case 'STALE_REQUEST':
        throw new ConflictException(body);
      case 'BANK_ACCOUNT_ARCHIVED':
      case 'NO_CHANGE':
        throw new UnprocessableEntityException(body);
    }
  }
  throw e;
};

const changeFromParam: SubjectFrom = (req) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidSodSubject();
  return { id: id.toLowerCase() };
};

const accountOf = (a: MaskedRemittanceAccount | null) =>
  a && {
    id: a.id,
    name: a.name,
    bsb: a.bsb,
    account_name: a.accountName,
    account_number: a.accountNumber,
    currency: a.currency,
    status: a.status,
  };

const viewOf = (v: RemittanceChangeView) => ({
  id: v.changeId,
  company_id: v.companyId,
  status: v.status,
  replayed: v.replayed,
  bank_account: accountOf(v.bankAccount),
  previous_bank_account: accountOf(v.previousBankAccount),
  requested_by: v.requestedBy,
  requested_at: v.requestedAt.toISOString(),
  decided_by: v.decidedBy,
  decided_at: v.decidedAt?.toISOString() ?? null,
  reason: v.reason,
});

/** What the audit row keeps: masked accounts and the decision, never a clear number. */
const auditOf = (v: RemittanceChangeView) => ({
  status: v.status,
  bank_account: accountOf(v.bankAccount),
  previous_bank_account: accountOf(v.previousBankAccount),
  ...(v.reason === null ? {} : { reason: v.reason }),
});

const actorOf = (req: Request): string => {
  const id = principalOf(req)?.userId;
  if (!id) throw new ForbiddenException({ error: 'forbidden' });
  return id;
};

@Controller('setup/remittance-account')
export class RemittanceAccountController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Get()
  @RequirePermission('settings.read')
  async get(@Query('company_id') companyId: unknown) {
    const r = await remittanceAccountOf(this.tx.get(), uuid(companyId, 'company_id')).catch(
      refusal,
    );
    return { account: accountOf(r.account), pending: r.pending && viewOf(r.pending) };
  }

  @Put('changes/:id')
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('remittance_change.request', changeFromParam)
  async request(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    if (!Object.hasOwn(b, 'bank_account_id')) bad('bank_account_id is required (null removes it)');
    const target =
      b['bank_account_id'] === null ? null : uuid(b['bank_account_id'], 'bank_account_id');
    const v = await requestRemittanceAccountChange(this.tx.get(), {
      companyId,
      changeId: uuid(id, 'id'),
      bankAccountId: target,
      requestedBy: actorOf(req),
    }).catch(refusal);
    if (v.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'remittance_account_change',
        entityId: v.changeId,
        after: auditOf(v),
      });
    return viewOf(v);
  }

  @Post('changes/:id/approve')
  @HttpCode(200)
  @RequirePermission('settings.setup.manage')
  @RequireStepUp(STEP_UP_SECONDS)
  @SoD('remittance_change.approve', changeFromParam)
  async approve(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const v = await approveRemittanceAccountChange(this.tx.get(), {
      companyId: uuid(bodyOf(body)['company_id'], 'company_id'),
      changeId: uuid(id, 'id'),
      approvedBy: actorOf(req),
    }).catch(refusal);
    if (!v.replayed)
      this.audit.describe({
        entityType: 'remittance_account_change',
        entityId: v.changeId,
        before: { status: 'requested' },
        after: auditOf(v),
      });
    return viewOf(v);
  }

  @Post('changes/:id/reject')
  @HttpCode(200)
  @RequirePermission('settings.setup.manage')
  async reject(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const b = bodyOf(body);
    const reason = b['reason'];
    if (typeof reason !== 'string' || reason.trim() === '') bad('a reason is required');
    const v = await rejectRemittanceAccountChange(this.tx.get(), {
      companyId: uuid(b['company_id'], 'company_id'),
      changeId: uuid(id, 'id'),
      rejectedBy: actorOf(req),
      reason: reason as string,
    }).catch(refusal);
    if (!v.replayed)
      this.audit.describe({
        entityType: 'remittance_account_change',
        entityId: v.changeId,
        before: { status: 'requested' },
        after: auditOf(v),
      });
    return viewOf(v);
  }
}
