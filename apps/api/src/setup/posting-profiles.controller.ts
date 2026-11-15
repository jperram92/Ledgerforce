/**
 * The posting-profile matrix over HTTP (T-0187, ADR-0082, design §4.4, SS-PLAT-133). Routes:
 * - `GET /posting-profiles/matrix?company_id=&as_of=` (settings.read) returns every active party ×
 *   product cell, resolved by the module (`profileMatrix`, the rule that posting and the wizard's
 *   gap check use), with the profiles and the accounts an override may name. `as_of` defaults to
 *   today in the tenant's report time zone (as for the wizard, ADR-0075).
 * - `PUT /posting-profiles/overrides` (settings.chart.manage, Idempotency-Key) sets one
 *   combination's override through `fillOverride`. A field left out keeps its value; null clears it.
 *   Setting a value is idempotent by nature (as for the system-role rebind, T-0146): a repeat
 *   answers 200 changed:false and writes nothing. A change is audited with the values before and
 *   after.
 * Refusals: 400 malformed; 404 unknown company or profile (PROFILE_UNKNOWN); 422 unusable account
 * (PROFILE_ACCOUNT) or tax code (PROFILE_TAX_CODE). No ledger row is written.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Put,
  Query,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  fillOverride,
  ProfileError,
  profileMatrix,
  type MatrixAccount,
  type OverrideInput,
  type OverrideView,
} from '@ledgerforce/products';
import { sql } from 'kysely';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const day = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
    ? v
    : bad('as_of must be YYYY-MM-DD');
};
/** undefined = leave as is; null = clear; else a uuid (or a tax code). */
const optional = (v: unknown, name: string, kind: 'uuid' | 'code'): string | null | undefined => {
  if (v === undefined || v === null) return v;
  if (kind === 'uuid') return uuid(v, name);
  return typeof v === 'string' && v.length > 0 && v.length <= 40
    ? v
    : bad(`${name} must be a tax code`);
};

const refusal = (e: unknown): never => {
  if (e instanceof ProfileError) {
    const body = { error: e.code, message: e.message };
    if (e.code === 'PROFILE_UNKNOWN') throw new NotFoundException(body);
    throw new UnprocessableEntityException(body);
  }
  throw e;
};

const account = (a: MatrixAccount | null) => (a ? { id: a.id, code: a.code, name: a.name } : null);
const overrideView = (o: OverrideView) => ({
  revenue_account_id: o.revenueAccountId,
  expense_account_id: o.expenseAccountId,
  cogs_account_id: o.cogsAccountId,
  discount_account_id: o.discountAccountId,
  tax_code: o.taxCode,
});

@Controller('posting-profiles')
export class PostingProfilesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
  ) {}

  /** Today in the tenant's report time zone (app.sod_report_timezone, ADR-0026). */
  private async today(): Promise<string> {
    const { rows } = await sql<{ d: string }>`
      SELECT to_char(now() AT TIME ZONE app.sod_report_timezone(), 'YYYY-MM-DD') AS d`.execute(
      this.tx.get(),
    );
    return rows[0]?.d ?? bad('as_of is required');
  }

  @Get('matrix')
  @RequirePermission('settings.read')
  async matrix(@Query('company_id') companyId: unknown, @Query('as_of') asOfIn: unknown) {
    const company = uuid(companyId, 'company_id');
    const asOf = day(asOfIn) ?? (await this.today());
    const m = await profileMatrix(this.tx.get(), company, asOf);
    if (!m) throw new NotFoundException({ error: 'UNKNOWN_COMPANY', message: 'no such company' });
    return {
      company_id: company,
      as_of: asOf,
      parties: m.parties.map((x) => ({
        id: x.id,
        code: x.code,
        name: x.name,
        kind: x.kind,
        control_account: account(x.controlAccount),
        default_tax_code: x.defaultTaxCode,
      })),
      products: m.products.map((x) => ({
        id: x.id,
        code: x.code,
        name: x.name,
        revenue_account: account(x.revenueAccount),
        expense_account: account(x.expenseAccount),
        cogs_account: account(x.cogsAccount),
        default_tax_code: x.defaultTaxCode,
      })),
      cells: m.cells.map((c) => ({
        party_profile_id: c.partyProfileId,
        product_profile_id: c.productProfileId,
        purpose: c.purpose,
        account: account(c.account),
        account_source: c.accountSource,
        tax_code: c.taxCode,
        tax_code_source: c.taxCodeSource,
        override: c.override,
        gap: c.gap,
      })),
      choices: m.choices.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
    };
  }

  @Put('overrides')
  @RequirePermission('settings.chart.manage')
  async override(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown) {
    if (!key || key.length > 200)
      throw new BadRequestException({ error: 'idempotency_key_required' });
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const company = uuid(b['company_id'], 'company_id');
    const party = uuid(b['party_profile_id'], 'party_profile_id');
    const product = uuid(b['product_profile_id'], 'product_profile_id');
    const fields = {
      revenueAccountId: optional(b['revenue_account_id'], 'revenue_account_id', 'uuid'),
      expenseAccountId: optional(b['expense_account_id'], 'expense_account_id', 'uuid'),
      cogsAccountId: optional(b['cogs_account_id'], 'cogs_account_id', 'uuid'),
      taxCode: optional(b['tax_code'], 'tax_code', 'code'),
    };
    const input: OverrideInput = {
      partyProfileId: party,
      productProfileId: product,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    };
    const r = await fillOverride(this.tx.get(), company, input).catch(refusal);
    const view = {
      party_profile_id: party,
      product_profile_id: product,
      ...overrideView(r.after),
      changed: r.changed,
    };
    if (r.changed)
      this.audit.describe({
        entityType: 'posting_profile_override',
        entityId: `${party}:${product}`,
        before: r.before ? overrideView(r.before) : null,
        after: { company_id: company, ...overrideView(r.after) },
      });
    return view;
  }
}
