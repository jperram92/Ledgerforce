/**
 * Tax settings and the standard tax codes over HTTP: setup wizard step 3 (T-0176, SS-PLAT-129,
 * ADR-0081, RQ-0161, RQ-0153). Routes:
 * - `GET /setup/tax?company_id=` (settings.read): the GST basis and BAS frequency in force
 *   today (tenant time zone), and the company's tax codes (rate as a decimal string).
 * - `PUT /setup/tax {company_id, effective_from, gst_basis, bas_frequency}`
 *   (settings.tax.manage, Idempotency-Key, audited) through the tax module's setTaxSettings. The
 *   same values for the same month again answer 200 `changed:false` and write nothing.
 * - `POST /setup/tax/codes/standard {company_id}` (settings.tax.manage, Idempotency-Key,
 *   audited) adds the standard Australian codes the company lacks (seedTaxCodes): 201 when some
 *   were added, 200 `{inserted:0}` otherwise.
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
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  seedTaxCodes,
  setTaxSettings,
  TaxSettingsError,
  taxSettingsOf,
  type BasFrequency,
  type GstBasis,
  type TaxSettings,
} from '@ledgerforce/tax';
import type { Response } from 'express';
import { sql } from 'kysely';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { bodyOf, companyOf, requireKey, todayIn, uuid } from './settings-common.ts';

const settingsView = (s: TaxSettings | null) =>
  s
    ? { effective_from: s.effectiveFrom, gst_basis: s.gstBasis, bas_frequency: s.basFrequency }
    : null;

const refusal = (e: unknown): never => {
  if (e instanceof TaxSettingsError) {
    if (e.code === 'UNKNOWN_COMPANY')
      throw new NotFoundException({ error: e.code, message: e.message });
    throw new BadRequestException({ error: e.code, message: e.message });
  }
  throw e;
};

@Controller('setup/tax')
export class TaxSettingsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  @Get()
  @RequirePermission('settings.read')
  async get(@Query('company_id') companyIdIn: unknown) {
    const companyId = uuid(companyIdIn, 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const asOf = await todayIn(trx);
    const codes = await trx
      .selectFrom('app.tax_code')
      .select([
        'code',
        'name',
        'kind',
        sql<string>`rate::text`.as('rate'),
        sql<string>`to_char(effective_from, 'YYYY-MM-DD')`.as('effective_from'),
        sql<string | null>`to_char(effective_to, 'YYYY-MM-DD')`.as('effective_to'),
        'status',
      ])
      .where('company_id', '=', companyId)
      .orderBy('code')
      .orderBy('effective_from')
      .execute();
    return {
      company_id: companyId,
      as_of: asOf,
      settings: settingsView(await taxSettingsOf(trx, companyId, asOf)),
      codes,
    };
  }

  @Put()
  @RequirePermission('settings.tax.manage')
  async save(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const effectiveFrom = typeof b['effective_from'] === 'string' ? b['effective_from'] : '';
    const current = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
      ? await taxSettingsOf(trx, companyId, effectiveFrom).catch(refusal)
      : null;
    if (
      current?.effectiveFrom === effectiveFrom &&
      current.gstBasis === b['gst_basis'] &&
      current.basFrequency === b['bas_frequency']
    )
      return { settings: settingsView(current), changed: false };
    const saved = await setTaxSettings(trx, {
      companyId,
      effectiveFrom,
      gstBasis: b['gst_basis'] as GstBasis,
      basFrequency: b['bas_frequency'] as BasFrequency,
      setBy: this.authz.userId(),
    }).catch(refusal);
    this.audit.describe({
      entityType: 'tax_settings',
      entityId: `${companyId}:${saved.effectiveFrom}`,
      ...(current?.effectiveFrom === effectiveFrom ? { before: settingsView(current) } : {}),
      after: settingsView(saved),
    });
    return { settings: settingsView(saved), changed: true };
  }

  @Post('codes/standard')
  @HttpCode(201)
  @RequirePermission('settings.tax.manage')
  async seed(
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const companyId = uuid(bodyOf(body)['company_id'], 'company_id');
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const inserted = await seedTaxCodes(trx, companyId);
    if (inserted === 0) res.status(200);
    else
      this.audit.describe({
        entityType: 'tax_code',
        entityId: `${companyId}:standard`,
        after: { catalogue: 'AU', inserted },
      });
    return { inserted };
  }
}
