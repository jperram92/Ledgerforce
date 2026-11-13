/**
 * Opening balances over HTTP (T-0080, design §4.1 step 9, GP-037, DL-0314). The wizard's step 9:
 *   POST /setup/opening-balances/preview  — the GP-037 journal the files would post; writes nothing
 *   POST /setup/opening-balances          — posts it (idempotency key; 201 new / 200 replay), audited
 *   GET  /setup/opening-balances?company_id= — the live opening balance (404 when none)
 * Body: { company_id, conversion_date, trial_balance_csv, ar_items_csv?, ap_items_csv? } — the CSV
 * files are read by @ledgerforce/setup (refusals name the row). All need settings.chart.manage
 * (setting up the books; GET too, since it lists every open document). Refusals are 422 with the
 * module's or the engine's code.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PostingError } from '@ledgerforce/ledger';
import {
  OpeningBalanceError,
  openingBalanceOf,
  parseOpenItemsCsv,
  parseTrialBalanceCsv,
  postOpeningBalance,
  previewOpeningBalance,
  type OpeningBalanceCommand,
  type OpeningBalanceView,
} from '@ledgerforce/setup';
import type { Request, Response } from 'express';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CSV = 5_000_000;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_opening_balance', message });
};
const refusal = (e: unknown): never => {
  if (e instanceof OpeningBalanceError || e instanceof PostingError) {
    throw new UnprocessableEntityException({
      error: e.code,
      message: e.message,
      ...(e instanceof OpeningBalanceError && e.row !== undefined ? { row: e.row } : {}),
      ...(e instanceof PostingError && e.line !== undefined ? { line: e.line } : {}),
    });
  }
  throw e;
};
const obj = (v: unknown) =>
  (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v : bad(`${name} must be a uuid`);
const csv = (v: unknown, name: string, required: boolean): string => {
  if (v === undefined || v === null) return required ? bad(`${name} is required`) : '';
  if (typeof v !== 'string' || v.length > MAX_CSV) return bad(`${name} must be CSV text`);
  return v;
};

const viewOf = (
  v: OpeningBalanceView | (Omit<OpeningBalanceView, 'id'> & { openingBalanceId: string }),
) => ({
  id: 'id' in v ? v.id : v.openingBalanceId,
  company_id: v.companyId,
  conversion_date: v.conversionDate,
  balance_date: v.balanceDate,
  entry_id: v.entryId,
  entry_no: v.entryNo,
  items: v.items.map((i) => ({
    kind: i.kind,
    party_id: i.partyId,
    document_no: i.documentNo,
    document_date: i.documentDate,
    due_date: i.dueDate,
    line_no: i.lineNo,
    amount: i.amount,
    gst_amount: i.gstAmount,
  })),
});

@Controller('setup/opening-balances')
export class OpeningBalancesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  /** Parse the body into the module command (CSV refusals become 422 through refusal()). */
  private command(req: Request, body: unknown, key: string): OpeningBalanceCommand {
    const b = obj(body);
    const conversionDate = b['conversion_date'];
    if (typeof conversionDate !== 'string' || !DATE.test(conversionDate))
      bad('conversion_date must be YYYY-MM-DD');
    const tb = csv(b['trial_balance_csv'], 'trial_balance_csv', true);
    const ar = csv(b['ar_items_csv'], 'ar_items_csv', false);
    const ap = csv(b['ap_items_csv'], 'ap_items_csv', false);
    const createdBy = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
    try {
      return {
        companyId: uuid(b['company_id'], 'company_id'),
        conversionDate: conversionDate as string,
        trialBalance: parseTrialBalanceCsv(tb),
        items: [
          ...(ar ? parseOpenItemsCsv(ar, 'ar') : []),
          ...(ap ? parseOpenItemsCsv(ap, 'ap') : []),
        ],
        idempotencyKey: key,
        ...(createdBy ? { createdBy } : {}),
      };
    } catch (e) {
      return refusal(e);
    }
  }

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('settings.chart.manage')
  async preview(@Req() req: Request, @Body() body: unknown) {
    const c = this.command(req, body, 'preview');
    const p = await previewOpeningBalance(this.tx.get(), c).catch(refusal);
    return {
      balance_date: p.balanceDate,
      entry_date: p.entry.entryDate,
      total: p.entry.total,
      lines: p.entry.lines.map((l) => ({
        line_no: l.lineNo,
        account_code: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        party_id: l.partyId,
        due_date: p.entry.subledgerItems.find((s) => s.lineNo === l.lineNo)?.dueDate ?? null,
        memo: l.memo,
      })),
    };
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('settings.chart.manage')
  async post(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || key.length > 190)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const r = await postOpeningBalance(this.tx.get(), this.command(req, body, key)).catch(refusal);
    const view = viewOf(r);
    if (r.replayed) res.status(200);
    else this.audit.describe({ entityType: 'opening_balance', entityId: view.id, after: view });
    return { ...view, replayed: r.replayed };
  }

  @Get()
  @RequirePermission('settings.chart.manage')
  async get(@Query('company_id') companyId: string | undefined) {
    const v = await openingBalanceOf(this.tx.get(), uuid(companyId, 'company_id'));
    if (!v) throw new NotFoundException({ error: 'no_opening_balance' });
    return viewOf(v);
  }
}
