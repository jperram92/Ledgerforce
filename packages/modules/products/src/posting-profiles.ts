/**
 * Loading posting profiles and products for a company (design §4.4, migration 0032). Runs inside
 * the caller's tenant transaction (withTenant), so RLS stamps tenant_id and every insert is checked
 * by the migration 0032 triggers. A template is validated against the company's actual chart and
 * tax codes before anything is written.
 *
 * Resolution of party × product (overrides, gap check) is T-0039; this module only stores the
 * profiles and the Salesforce mapping hooks (the connector is T-0065). Nothing here posts.
 */
import type { AccountType, Database } from '@ledgerforce/db';
import type { ChartTemplate } from '@ledgerforce/gl';
import { findTaxCode, type TaxCodeTemplate, type TaxCodeVersion } from '@ledgerforce/tax';
import type { Transaction } from 'kysely';
import { validateProfileTemplate, type PostingProfileTemplate } from './profiles.template.ts';

export class InvalidProfileTemplateError extends Error {
  readonly problems: readonly string[];
  constructor(id: string, problems: string[]) {
    super(`posting-profile template ${id} is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidProfileTemplateError';
    this.problems = problems;
  }
}

export interface LoadedProfiles {
  /** party profile code → id */
  partyProfiles: Map<string, string>;
  /** product profile code → id */
  productProfiles: Map<string, string>;
}

export async function loadPostingProfileTemplate(
  trx: Transaction<Database>,
  companyId: string,
  template: PostingProfileTemplate,
): Promise<LoadedProfiles> {
  const accounts = await trx
    .selectFrom('app.account')
    .select([
      'id',
      'code',
      'name',
      'type',
      'subtype',
      'normal_balance',
      'postable',
      'is_control',
      'status',
    ])
    .where('company_id', '=', companyId)
    .execute();
  const taxCodes = await trx
    .selectFrom('app.tax_code')
    .select('code')
    .distinct()
    .where('company_id', '=', companyId)
    .execute();
  // The company's chart and codes as the validator's template shapes.
  const chart: ChartTemplate = {
    id: `company:${companyId}`,
    name: 'company chart',
    country: '',
    version: 0,
    suggestedSettings: {},
    accounts: accounts.map((a) => ({
      code: a.code,
      name: a.name,
      type: a.type as AccountType,
      subtype: a.subtype,
      normalBalance: a.normal_balance as 'debit' | 'credit',
      postable: a.postable && a.status === 'active',
      control: a.is_control,
    })),
  };
  const codes: TaxCodeTemplate = {
    id: `company:${companyId}`,
    country: '',
    version: 0,
    codes: taxCodes.map((c) => ({
      code: c.code,
      name: c.code,
      kind: 'gst_free',
      rate: '0',
      validFrom: '',
    })),
  };
  const problems = validateProfileTemplate(template, chart, codes);
  if (problems.length > 0) throw new InvalidProfileTemplateError(template.id, problems);

  const accountId = new Map(accounts.map((a) => [a.code, a.id]));
  const slotId = (code: string | undefined) =>
    code === undefined ? null : (accountId.get(code) ?? null);

  const party = await trx
    .insertInto('app.party_posting_profile')
    .values(
      template.partyProfiles.map((p) => ({
        company_id: companyId,
        code: p.code,
        name: p.name,
        party_kind: p.partyKind,
        control_role: p.controlRole,
        default_tax_code: p.defaultTaxCode ?? null,
      })),
    )
    .returning(['id', 'code'])
    .execute();
  const product = await trx
    .insertInto('app.product_posting_profile')
    .values(
      template.productProfiles.map((p) => ({
        company_id: companyId,
        code: p.code,
        name: p.name,
        revenue_account_id: slotId(p.accounts.revenue),
        discount_account_id: slotId(p.accounts.discount),
        expense_account_id: slotId(p.accounts.expense),
        cogs_account_id: slotId(p.accounts.cogs),
        asset_account_id: slotId(p.accounts.asset),
      })),
    )
    .returning(['id', 'code'])
    .execute();
  const partyProfiles = new Map(party.map((r) => [r.code, r.id]));
  const productProfiles = new Map(product.map((r) => [r.code, r.id]));

  const need = (m: Map<string, string>, code: string) => {
    const id = m.get(code);
    if (id === undefined) throw new Error(`profile ${code} was not written`); // validated above
    return id;
  };
  if (template.salesforce.account.length > 0) {
    await trx
      .insertInto('app.party_profile_mapping')
      .values(
        template.salesforce.account.map((m) => ({
          company_id: companyId,
          sf_field: m.field,
          sf_value: m.value,
          party_posting_profile_id: need(partyProfiles, m.profile),
        })),
      )
      .execute();
  }
  if (template.salesforce.product.length > 0) {
    await trx
      .insertInto('app.product_profile_mapping')
      .values(
        template.salesforce.product.map((m) => ({
          company_id: companyId,
          sf_field: m.field,
          sf_value: m.value,
          product_posting_profile_id: need(productProfiles, m.profile),
        })),
      )
      .execute();
  }
  return { partyProfiles, productProfiles };
}

export interface NewProduct {
  companyId: string;
  name: string;
  code?: string | undefined;
  description?: string | undefined;
  /** Product posting profile by code (e.g. PROFESSIONAL_SERVICES). */
  productPostingProfileCode?: string | undefined;
  /** Tax code key (e.g. GST); resolved by date through app.tax_code. */
  defaultTaxCode?: string | undefined;
  /** 18-character Product2 Id. */
  salesforceProductId?: string | undefined;
  salesforceFamily?: string | undefined;
}

export class UnknownProfileError extends Error {
  constructor(kind: string, code: string) {
    super(`${kind} posting profile ${code} does not exist in this company`);
    this.name = 'UnknownProfileError';
  }
}

export async function createProduct(
  trx: Transaction<Database>,
  p: NewProduct,
): Promise<{ id: string }> {
  let profileId: string | null = null;
  if (p.productPostingProfileCode !== undefined) {
    const row = await trx
      .selectFrom('app.product_posting_profile')
      .select('id')
      .where('company_id', '=', p.companyId)
      .where('code', '=', p.productPostingProfileCode)
      .executeTakeFirst();
    if (!row) throw new UnknownProfileError('product', p.productPostingProfileCode);
    profileId = row.id;
  }
  return trx
    .insertInto('app.product')
    .values({
      company_id: p.companyId,
      name: p.name,
      code: p.code ?? null,
      description: p.description ?? null,
      product_posting_profile_id: profileId,
      default_tax_code: p.defaultTaxCode ?? null,
      salesforce_product_id: p.salesforceProductId ?? null,
      salesforce_family: p.salesforceFamily ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

/**
 * The version of the product's default tax code valid on `on` (YYYY-MM-DD), with its GST
 * accounts, through the T-0034 effective-dated app.tax_code; null when the product has none.
 * Which tax code wins against the party profile's default is the resolver's job (T-0039/T-0040).
 */
export async function findProductTaxCode(
  trx: Transaction<Database>,
  q: { companyId: string; productId: string; on: string },
): Promise<TaxCodeVersion | null> {
  const product = await trx
    .selectFrom('app.product')
    .select('default_tax_code')
    .where('company_id', '=', q.companyId)
    .where('id', '=', q.productId)
    .executeTakeFirstOrThrow();
  if (product.default_tax_code === null) return null;
  return findTaxCode(trx, { companyId: q.companyId, code: product.default_tax_code, on: q.on });
}

export interface ProfileRef {
  id: string;
  code: string;
  name: string;
}

/** Party profile for a Salesforce Account field value (Account.Type or a custom field); exact match. */
export async function findPartyProfileForSalesforce(
  trx: Transaction<Database>,
  q: { companyId: string; field: string; value: string },
): Promise<ProfileRef | null> {
  const row = await trx
    .selectFrom('app.party_profile_mapping as m')
    .innerJoin('app.party_posting_profile as p', 'p.id', 'm.party_posting_profile_id')
    .select(['p.id', 'p.code', 'p.name'])
    .where('m.company_id', '=', q.companyId)
    .where('m.sf_field', '=', q.field)
    .where('m.sf_value', '=', q.value)
    .executeTakeFirst();
  return row ?? null;
}

/** Product profile for a Salesforce Product2 field value (Product2.Family or a custom field); exact match. */
export async function findProductProfileForSalesforce(
  trx: Transaction<Database>,
  q: { companyId: string; field: string; value: string },
): Promise<ProfileRef | null> {
  const row = await trx
    .selectFrom('app.product_profile_mapping as m')
    .innerJoin('app.product_posting_profile as p', 'p.id', 'm.product_posting_profile_id')
    .select(['p.id', 'p.code', 'p.name'])
    .where('m.company_id', '=', q.companyId)
    .where('m.sf_field', '=', q.field)
    .where('m.sf_value', '=', q.value)
    .executeTakeFirst();
  return row ?? null;
}
