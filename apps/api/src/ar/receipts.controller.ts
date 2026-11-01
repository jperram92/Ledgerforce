/**
 * Customer receipts over HTTP (T-0046, UC-03, DL-0274). POST /ar/receipts records, posts and
 * allocates a receipt (ar.receipt.record, idempotency key; 201 new / 200 replay);
 * POST /ar/receipts/:id/allocations allocates an unallocated receipt later;
 * GET /ar/invoices/:id/payment-status reads Paid / Partially paid (ar.read).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  allocateReceipt,
  invoicePaymentStatus,
  ReceiptError,
  recordReceipt,
  type ReceiptView,
} from '@ledgerforce/ar';
import { AllocationError, PostingError } from '@ledgerforce/ledger';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METHODS = ['eft', 'cheque', 'cash', 'card'] as const;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_receipt', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof ReceiptError || e instanceof PostingError || e instanceof AllocationError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};
const obj = (v: unknown) =>
  (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v : bad(`${name} must be a uuid`);
const str = (v: unknown, name: string): string =>
  typeof v === 'string' ? v : bad(`${name} is required`);

const viewOf = (r: ReceiptView) => ({
  id: r.receiptId,
  receipt_no: r.receiptNo,
  entry_id: r.entryId,
  replayed: r.replayed,
  amount: r.amount,
  unallocated: r.unallocated,
});

@Controller('ar')
export class ArReceiptsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Post('receipts')
  @HttpCode(201)
  @RequirePermission('ar.receipt.record')
  async record(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = obj(body);
    const method = str(b['method'], 'method');
    if (!(METHODS as readonly string[]).includes(method))
      bad(`method must be one of ${METHODS.join(', ')}`);
    const date = str(b['receipt_date'], 'receipt_date');
    if (!DATE.test(date)) bad('receipt_date must be YYYY-MM-DD');
    const deposit = obj(b['deposit_to']);
    const allocations = Array.isArray(b['allocations']) ? (b['allocations'] as unknown[]) : [];
    const createdBy = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
    const r = await recordReceipt(this.tx.get(), {
      companyId: uuid(b['company_id'], 'company_id'),
      partyId: uuid(b['party_id'], 'party_id'),
      receiptDate: date,
      amount: str(b['amount'], 'amount'),
      method: method as (typeof METHODS)[number],
      depositTo:
        deposit['undeposited'] === true
          ? { undeposited: true }
          : { accountId: uuid(deposit['account_id'], 'deposit_to.account_id') },
      ...(typeof b['reference'] === 'string' ? { reference: b['reference'] } : {}),
      idempotencyKey: key,
      ...(createdBy ? { createdBy } : {}),
      allocations: allocations.map((a) => ({
        invoiceId: uuid(obj(a)['invoice_id'], 'allocations[].invoice_id'),
        amount: str(obj(a)['amount'], 'allocations[].amount'),
      })),
    }).catch(refusal);
    if (r.replayed) res.status(200);
    else
      this.audit.describe({
        entityType: 'customer_receipt',
        entityId: r.receiptId,
        after: viewOf(r),
      });
    return viewOf(r);
  }

  @Post('receipts/:id/allocations')
  @HttpCode(200)
  @RequirePermission('ar.receipt.record')
  async allocate(@Param('id') id: string, @Body() body: unknown) {
    const b = obj(body);
    const date = str(b['allocation_date'], 'allocation_date');
    if (!DATE.test(date)) bad('allocation_date must be YYYY-MM-DD');
    const r = await allocateReceipt(this.tx.get(), {
      companyId: uuid(b['company_id'], 'company_id'),
      receiptId: uuid(id, 'id'),
      invoiceId: uuid(b['invoice_id'], 'invoice_id'),
      amount: str(b['amount'], 'amount'),
      allocationDate: date,
    }).catch(refusal);
    this.audit.describe({
      entityType: 'customer_receipt',
      entityId: r.receiptId,
      after: viewOf(r),
    });
    return viewOf(r);
  }

  @Get('invoices/:id/payment-status')
  @RequirePermission('ar.read')
  async paymentStatus(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    return invoicePaymentStatus(this.tx.get(), uuid(companyId, 'company_id'), uuid(id, 'id')).catch(
      refusal,
    );
  }
}
