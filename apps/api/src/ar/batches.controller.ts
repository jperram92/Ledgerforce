/**
 * Batch billing run over HTTP (T-0043, UC-02, DL-0271). Thin: validates the request and calls
 * @ledgerforce/ar. POST /ar/batches/preview needs ar.batch.run and an idempotency key (a repeat
 * returns the stored preview with 200); GET /ar/batches/:id needs ar.read. Money is returned as
 * decimal strings. Approval and posting of a batch are T-0044.
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
import { BatchError, loadBatchPreview, previewBatch, type BatchPreview } from '@ledgerforce/ar';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_batch_request', message });
};

const refusal = (e: unknown): never => {
  if (e instanceof BatchError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};

function viewOf(p: BatchPreview) {
  return {
    id: p.batchId,
    replayed: p.replayed,
    period_from: p.periodFrom,
    period_to: p.periodTo,
    issue_date: p.issueDate,
    items: p.items.map((i) => ({
      item_no: i.itemNo,
      party_id: i.partyId,
      party_name: i.partyName,
      line_count: i.lineCount,
      net: i.net,
      tax: i.tax,
      gross: i.gross,
      warnings: i.warnings,
    })),
    totals: p.totals,
  };
}

@Controller('ar/batches')
export class ArBatchesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  @Post('preview')
  @HttpCode(201)
  @RequirePermission('ar.batch.run')
  async preview(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const companyId = b['company_id'];
    const from = b['period_from'];
    const to = b['period_to'];
    const issue = b['issue_date'];
    if (typeof companyId !== 'string' || !UUID.test(companyId)) bad('company_id must be a uuid');
    if (typeof from !== 'string' || !DATE.test(from)) bad('period_from must be YYYY-MM-DD');
    if (typeof to !== 'string' || !DATE.test(to)) bad('period_to must be YYYY-MM-DD');
    if (issue !== undefined && (typeof issue !== 'string' || !DATE.test(issue))) {
      bad('issue_date must be YYYY-MM-DD');
    }
    const createdBy = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
    const p = await previewBatch(this.tx.get(), {
      companyId: companyId as string,
      periodFrom: from as string,
      periodTo: to as string,
      ...(typeof issue === 'string' ? { issueDate: issue } : {}),
      idempotencyKey: key,
      ...(createdBy ? { createdBy } : {}),
    }).catch(refusal);
    if (p.replayed) {
      res.status(200);
    } else {
      this.audit.describe({
        entityType: 'billing_batch',
        entityId: p.batchId,
        after: { ...p.totals, period_from: p.periodFrom, period_to: p.periodTo },
      });
    }
    return viewOf(p);
  }

  @Get(':id')
  @RequirePermission('ar.read')
  async get(@Param('id') id: string, @Query('company_id') companyId: string | undefined) {
    if (!UUID.test(id)) bad('id must be a uuid');
    if (typeof companyId !== 'string' || !UUID.test(companyId)) bad('company_id must be a uuid');
    const p = await loadBatchPreview(this.tx.get(), (companyId as string).toLowerCase(), id).catch(
      refusal,
    );
    return viewOf(p);
  }
}
