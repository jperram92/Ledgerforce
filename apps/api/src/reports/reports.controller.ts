/**
 * Ledger reports over HTTP (T-0077, design §8.1, DL-0290). Read-only and thin: validates the query
 * and calls the module report functions inside the caller's tenant transaction (RLS).
 *
 *  - GET /gl/detail?company_id&(period_id | [from]&to)&account_id*&dimension_value_id*&party_id
 *    → reports.run. account_id and dimension_value_id repeat or take comma-separated lists.
 *  - GET /ap/aged-payables?company_id&as_of → ap.read
 *  - GET /ar/aged-receivables?company_id&as_of → ar.read
 *
 * The routes sit under the API's own prefixes (gl, ap, ar): the web app owns /reports/* (DL-0290).
 * Money in responses is a decimal string ("110.0000"), never a JSON number or object.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import { agedPayables } from '@ledgerforce/ap';
import { agedReceivables } from '@ledgerforce/ar';
import { glDetailReport, ReportError, type GlDetailReport } from '@ledgerforce/reporting';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_report_query', message });
};
const companyOf = (v: unknown): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad('company_id must be a uuid');
const dateOf = (v: unknown, name: string): string =>
  typeof v === 'string' && DATE.test(v) ? v : bad(`${name} must be a date YYYY-MM-DD`);
const optional = (v: unknown, name: string): string | undefined =>
  v === undefined ? undefined : typeof v === 'string' ? v : bad(`${name} must be given once`);
/** `?x=a&x=b` or `?x=a,b` → [a, b]. */
const list = (v: unknown, name: string): string[] => {
  if (v === undefined) return [];
  const parts = (Array.isArray(v) ? v : [v]).flatMap((s) =>
    typeof s === 'string' ? s.split(',') : bad(`${name} must be uuids`),
  );
  return parts.map((s) => s.trim()).filter((s) => s !== '');
};

const refusal = (e: unknown): never => {
  if (e instanceof ReportError) {
    if (e.code === 'INVALID_RANGE' || e.code === 'INVALID_FILTER')
      throw new BadRequestException({ error: e.code, message: e.message });
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  throw e;
};

function glDetailView(r: GlDetailReport) {
  return {
    company_id: r.companyId,
    currency: r.currency,
    from: r.from,
    to: r.to,
    period_id: r.periodId,
    account_ids: r.accountIds,
    dimension_value_ids: r.dimensionValueIds,
    party_id: r.partyId,
    accounts: r.accounts.map((a) => ({
      account_id: a.accountId,
      code: a.code,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      opening: a.opening.toNumericString(),
      lines: a.lines.map((l) => ({
        entry_id: l.entryId,
        entry_no: l.entryNo,
        line_no: l.lineNo,
        date: l.date,
        source_type: l.sourceType,
        memo: l.memo,
        party_id: l.partyId,
        party_name: l.partyName,
        debit: l.debit.toNumericString(),
        credit: l.credit.toNumericString(),
        balance: l.balance.toNumericString(),
        txn_currency: l.txnCurrency,
        txn_amount: l.txnAmount,
      })),
      total_debit: a.totalDebit.toNumericString(),
      total_credit: a.totalCredit.toNumericString(),
      closing: a.closing.toNumericString(),
    })),
    total_debit: r.totalDebit.toNumericString(),
    total_credit: r.totalCredit.toNumericString(),
  };
}

@Controller()
export class ReportsController {
  constructor(private readonly tx: TenantTx) {}

  @Get('gl/detail')
  @RequirePermission('reports.run')
  async glDetail(
    @Query('company_id') companyId: unknown,
    @Query('period_id') periodId: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('account_id') accountIds: unknown,
    @Query('dimension_value_id') dimensionValueIds: unknown,
    @Query('party_id') partyId: unknown,
  ) {
    const period = optional(periodId, 'period_id');
    const f = optional(from, 'from');
    const t = optional(to, 'to');
    const party = optional(partyId, 'party_id');
    const r = await glDetailReport(this.tx.get(), {
      companyId: companyOf(companyId),
      ...(period !== undefined ? { periodId: period } : {}),
      ...(f !== undefined ? { from: f } : {}),
      ...(t !== undefined ? { to: t } : {}),
      accountIds: list(accountIds, 'account_id'),
      dimensionValueIds: list(dimensionValueIds, 'dimension_value_id'),
      ...(party !== undefined ? { partyId: party } : {}),
    }).catch(refusal);
    return glDetailView(r);
  }

  @Get('ap/aged-payables')
  @RequirePermission('ap.read')
  agedPayables(@Query('company_id') companyId: unknown, @Query('as_of') asOf: unknown) {
    return agedPayables(this.tx.get(), {
      companyId: companyOf(companyId),
      asOf: dateOf(asOf, 'as_of'),
    });
  }

  @Get('ar/aged-receivables')
  @RequirePermission('ar.read')
  agedReceivables(@Query('company_id') companyId: unknown, @Query('as_of') asOf: unknown) {
    return agedReceivables(this.tx.get(), {
      companyId: companyOf(companyId),
      asOf: dateOf(asOf, 'as_of'),
    });
  }
}
