/**
 * Company details and fiscal years over HTTP: setup wizard step 1 (T-0176, SS-PLAT-129, ADR-0081,
 * RQ-0161). Routes:
 * - `GET /setup/company?company_id=` (settings.read): legal name, ABN, base currency, whether
 *   the base currency is locked, and the fiscal years.
 * - `PUT /setup/company {company_id, legal_name, abn, base_currency}` (settings.setup.manage,
 *   Idempotency-Key, audited): the same values again answer 200 `changed:false` and write nothing.
 *   A different base currency once the company has a journal entry is 409 BASE_CURRENCY_LOCKED
 *   (DL-0641); an ABN failing the ABR checksum is 422 INVALID_ABN.
 * - `POST /setup/company/fiscal-years {company_id, start}` (settings.setup.manage,
 *   Idempotency-Key, audited): adds a fiscal year of twelve monthly periods through the ledger's
 *   generateFiscalYear. The same start again is a replay (200); another overlap is 409.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Database } from '@ledgerforce/db';
import { fiscalYearPlan, generateFiscalYear } from '@ledgerforce/ledger';
import type { Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { bad, bodyOf, companyOf, requireKey, uuid } from './settings-common.ts';

const MONTH_START = /^(\d{4})-(0[1-9]|1[0-2])-01$/;

async function locked(trx: Transaction<Database>, companyId: string): Promise<boolean> {
  const r = await trx
    .selectFrom('app.journal_entry')
    .select('id')
    .where('company_id', '=', companyId)
    .limit(1)
    .executeTakeFirst();
  return r !== undefined;
}

interface FiscalYearView {
  label: string;
  start_date: string;
  end_date: string;
}

/** app.fiscal_year is not in the Kysely schema (ledger reads it with SQL, period.ts). */
async function fiscalYears(
  trx: Transaction<Database>,
  companyId: string,
): Promise<FiscalYearView[]> {
  const r = await sql<FiscalYearView>`
    SELECT label, to_char(start_date, 'YYYY-MM-DD') AS start_date,
           to_char(end_date, 'YYYY-MM-DD') AS end_date
      FROM app.fiscal_year WHERE company_id = ${companyId} ORDER BY start_date`.execute(trx);
  return r.rows;
}

@Controller('setup/company')
export class CompanySettingsController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  private async view(companyId: string) {
    const trx = this.tx.get();
    const c = await companyOf(trx, companyId);
    return {
      company_id: c.id,
      name: c.name,
      legal_name: c.legal_name,
      abn: c.abn,
      base_currency: c.base_currency,
      base_currency_locked: await locked(trx, c.id),
      fiscal_years: await fiscalYears(trx, c.id),
    };
  }

  @Get()
  @RequirePermission('settings.read')
  get(@Query('company_id') companyId: unknown) {
    return this.view(uuid(companyId, 'company_id'));
  }

  @Put()
  @RequirePermission('settings.setup.manage')
  async save(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const legalName = typeof b['legal_name'] === 'string' ? b['legal_name'].trim() : '';
    if (legalName.length < 1 || legalName.length > 200) bad('legal_name must be 1–200 characters');
    const abn = typeof b['abn'] === 'string' ? b['abn'].replace(/\s+/g, '') : '';
    if (!/^\d{11}$/.test(abn)) bad('abn must be 11 digits');
    const currency = b['base_currency'];
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      bad('base_currency must be an ISO 4217 code such as AUD');
    const trx = this.tx.get();
    const before = await companyOf(trx, companyId);
    const valid = await sql<{ ok: boolean }>`SELECT app.abn_is_valid(${abn}) AS ok`.execute(trx);
    if (!valid.rows[0]?.ok)
      throw new UnprocessableEntityException({
        error: 'INVALID_ABN',
        message: 'the ABN does not pass the ABR checksum: check the 11 digits',
      });
    if (currency !== before.base_currency && (await locked(trx, companyId)))
      throw new ConflictException({
        error: 'BASE_CURRENCY_LOCKED',
        message:
          'the base currency cannot change once the company has journal entries: posted history is kept in it',
      });
    const changed =
      before.legal_name !== legalName || before.abn !== abn || before.base_currency !== currency;
    if (changed) {
      await trx
        .updateTable('app.company')
        .set({ legal_name: legalName, abn, base_currency: currency as string })
        .where('id', '=', companyId)
        .execute();
      this.audit.describe({
        entityType: 'company',
        entityId: companyId,
        before: {
          legal_name: before.legal_name,
          abn: before.abn,
          base_currency: before.base_currency,
        },
        after: { legal_name: legalName, abn, base_currency: currency },
      });
    }
    return { ...(await this.view(companyId)), changed };
  }

  @Post('fiscal-years')
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  async addYear(
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const start = typeof b['start'] === 'string' ? b['start'] : '';
    const m = MONTH_START.exec(start);
    if (!m) bad('start must be the 1st of a month (YYYY-MM-01)');
    const plan = fiscalYearPlan({ startMonth: Number(m?.[2]) }, Number(m?.[1]));
    const trx = this.tx.get();
    await companyOf(trx, companyId);
    const years = await fiscalYears(trx, companyId);
    const same = years.find((y) => y.start_date === plan.start && y.end_date === plan.end);
    if (same) {
      res.status(200);
      return { ...same, periods: 12, replayed: true };
    }
    const clash = years.find((y) => y.start_date <= plan.end && plan.start <= y.end_date);
    if (clash)
      throw new ConflictException({
        error: 'FISCAL_YEAR_OVERLAP',
        message: `a fiscal year from ${plan.start} to ${plan.end} would overlap ${clash.label} (${clash.start_date} to ${clash.end_date})`,
      });
    const fy = await generateFiscalYear(trx, {
      companyId,
      convention: { startMonth: Number(m?.[2]) },
      startYear: Number(m?.[1]),
      createdBy: this.authz.userId(),
    });
    const out = {
      label: fy.label,
      start_date: plan.start,
      end_date: plan.end,
      periods: fy.periods.length,
    };
    this.audit.describe({ entityType: 'fiscal_year', entityId: fy.fiscalYearId, after: out });
    return { ...out, replayed: false };
  }
}
