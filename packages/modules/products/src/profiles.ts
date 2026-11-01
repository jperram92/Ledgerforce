/**
 * Posting profiles and products (T-0038, design §4.4, DL-0266).
 *
 * Party profile (who): customer or supplier, its control account (the company's AR_CONTROL /
 * AP_CONTROL account) and default tax code. Product profile (what): revenue, expense, COGS and
 * discount accounts and a default tax code. These rules are checked here, where profiles are
 * created; the database keeps every account inside the company (composite foreign keys).
 * Template profiles are seeded onto the chart loaded from the same template; Salesforce
 * Product2.Family / Account.Type values map to profiles through app.salesforce_profile_mapping.
 * The party × product override matrix and the gap check are T-0039.
 */
import type { Database } from '@ledgerforce/db';
import type { ChartTemplate } from '@ledgerforce/gl';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type ProfileErrorCode = 'PROFILE_ACCOUNT' | 'PROFILE_KIND' | 'INVALID_PRODUCT';

export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  constructor(code: ProfileErrorCode, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

export interface PartyProfileInput {
  code: string;
  name: string;
  kind: 'customer' | 'supplier';
  controlAccountId: string;
  defaultTaxCode: string;
}

export interface ProductProfileInput {
  code: string;
  name: string;
  revenueAccountId: string;
  expenseAccountId?: string | null;
  cogsAccountId?: string | null;
  discountAccountId?: string | null;
  defaultTaxCode: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  productProfileId: string;
  description?: string;
  /** Decimal string, ≥ 0, at most 4 decimals. */
  unitPrice?: string;
  currency?: string;
  taxCode?: string;
  /** 18-character Salesforce Id. */
  salesforceProduct2Id?: string;
}

interface AccountFacts {
  type: string;
  postable: boolean;
  is_control: boolean;
  status: string;
  roles: string[];
}

async function accountFacts(
  trx: Trx,
  companyId: string,
  id: string,
): Promise<AccountFacts | undefined> {
  const r = await sql<AccountFacts>`
    SELECT a.type, a.postable, a.is_control, a.status,
           coalesce(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
      FROM app.account a
      LEFT JOIN app.account_system_role r ON r.tenant_id = a.tenant_id AND r.account_id = a.id
     WHERE a.company_id = ${companyId} AND a.id = ${id}::uuid
     GROUP BY a.id`.execute(trx);
  return r.rows[0];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAccount(
  trx: Trx,
  companyId: string,
  profile: string,
  what: string,
  id: string,
  ok: (a: AccountFacts) => boolean,
  rule: string,
): Promise<void> {
  const a = UUID_RE.test(id) ? await accountFacts(trx, companyId, id) : undefined;
  if (!a || a.status !== 'active' || !ok(a)) {
    throw new ProfileError(
      'PROFILE_ACCOUNT',
      `profile ${profile}: ${what} account ${id} must be ${rule} of this company`,
    );
  }
}

/** Create a party posting profile; its control account must carry the matching control role. */
export async function createPartyProfile(
  trx: Trx,
  companyId: string,
  p: PartyProfileInput,
): Promise<string> {
  const role = p.kind === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL';
  await requireAccount(
    trx,
    companyId,
    p.code,
    'control',
    p.controlAccountId,
    (a) => a.roles.includes(role),
    `the active ${role} account`,
  );
  const row = await trx
    .insertInto('app.party_posting_profile')
    .values({
      company_id: companyId,
      code: p.code,
      name: p.name,
      kind: p.kind,
      control_account_id: p.controlAccountId,
      default_tax_code: p.defaultTaxCode,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Create a product posting profile with accounts of the right type (revenue / expense). */
export async function createProductProfile(
  trx: Trx,
  companyId: string,
  p: ProductProfileInput,
): Promise<string> {
  const postable = (types: string[]) => (a: AccountFacts) =>
    types.includes(a.type) && a.postable && !a.is_control;
  await requireAccount(
    trx,
    companyId,
    p.code,
    'revenue',
    p.revenueAccountId,
    postable(['revenue']),
    'a postable revenue account',
  );
  for (const [what, id, types] of [
    ['expense', p.expenseAccountId, ['expense']],
    ['cogs', p.cogsAccountId, ['expense']],
    ['discount', p.discountAccountId, ['revenue', 'expense']],
  ] as const) {
    if (id) {
      await requireAccount(
        trx,
        companyId,
        p.code,
        what,
        id,
        postable([...types]),
        `a postable ${types.join(' or ')} account`,
      );
    }
  }
  const row = await trx
    .insertInto('app.product_posting_profile')
    .values({
      company_id: companyId,
      code: p.code,
      name: p.name,
      revenue_account_id: p.revenueAccountId,
      expense_account_id: p.expenseAccountId ?? null,
      cogs_account_id: p.cogsAccountId ?? null,
      discount_account_id: p.discountAccountId ?? null,
      default_tax_code: p.defaultTaxCode,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface SeededProfiles {
  /** profile code → id, in template order. */
  partyProfiles: Map<string, string>;
  productProfiles: Map<string, string>;
}

/**
 * Seed a template's profiles and Salesforce mappings onto a company whose chart was loaded from
 * the same template (`accounts`: account code → id, as loadChartTemplate returns).
 */
export async function seedPostingProfiles(
  trx: Trx,
  companyId: string,
  template: ChartTemplate,
  accounts: ReadonlyMap<string, string>,
): Promise<SeededProfiles> {
  const id = (code: string | null) => {
    if (code === null) return null;
    const v = accounts.get(code);
    if (!v)
      throw new ProfileError('PROFILE_ACCOUNT', `template account ${code} is not in the chart`);
    return v;
  };
  const partyProfiles = new Map<string, string>();
  for (const p of template.partyProfiles) {
    partyProfiles.set(
      p.code,
      await createPartyProfile(trx, companyId, {
        code: p.code,
        name: p.name,
        kind: p.kind,
        controlAccountId: id(p.controlAccount) ?? '',
        defaultTaxCode: p.defaultTaxCode,
      }),
    );
  }
  const productProfiles = new Map<string, string>();
  for (const p of template.productProfiles) {
    productProfiles.set(
      p.code,
      await createProductProfile(trx, companyId, {
        code: p.code,
        name: p.name,
        revenueAccountId: id(p.revenueAccount) ?? '',
        expenseAccountId: id(p.expenseAccount),
        cogsAccountId: id(p.cogsAccount),
        discountAccountId: id(p.discountAccount),
        defaultTaxCode: p.defaultTaxCode,
      }),
    );
  }
  const mappings = [
    ...Object.entries(template.profileMappings.productFamily).map(([value, code]) => ({
      company_id: companyId,
      kind: 'product_family' as const,
      source_value: value,
      product_profile_id: productProfiles.get(code) ?? null,
      party_profile_id: null,
    })),
    ...Object.entries(template.profileMappings.accountType).map(([value, code]) => ({
      company_id: companyId,
      kind: 'account_type' as const,
      source_value: value,
      product_profile_id: null,
      party_profile_id: partyProfiles.get(code) ?? null,
    })),
  ];
  if (mappings.length > 0)
    await trx.insertInto('app.salesforce_profile_mapping').values(mappings).execute();
  return { partyProfiles, productProfiles };
}

/** The product profile a Salesforce Product2.Family maps to, or undefined. */
export async function productProfileForFamily(
  trx: Trx,
  companyId: string,
  family: string,
): Promise<string | undefined> {
  const r = await trx
    .selectFrom('app.salesforce_profile_mapping')
    .select('product_profile_id')
    .where('company_id', '=', companyId)
    .where('kind', '=', 'product_family')
    .where('source_value', '=', family)
    .executeTakeFirst();
  return r?.product_profile_id ?? undefined;
}

/** The party profile a Salesforce Account.Type maps to, or undefined. */
export async function partyProfileForAccountType(
  trx: Trx,
  companyId: string,
  accountType: string,
): Promise<string | undefined> {
  const r = await trx
    .selectFrom('app.salesforce_profile_mapping')
    .select('party_profile_id')
    .where('company_id', '=', companyId)
    .where('kind', '=', 'account_type')
    .where('source_value', '=', accountType)
    .executeTakeFirst();
  return r?.party_profile_id ?? undefined;
}

/** Set a party's customer and/or supplier profile; each must be an active profile of its kind. */
export async function setPartyProfiles(
  trx: Trx,
  companyId: string,
  partyId: string,
  p: { customerProfileId?: string; supplierProfileId?: string },
): Promise<void> {
  for (const [kind, id] of [
    ['customer', p.customerProfileId],
    ['supplier', p.supplierProfileId],
  ] as const) {
    if (id === undefined) continue;
    const row = await trx
      .selectFrom('app.party_posting_profile')
      .select(['kind', 'status'])
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.kind !== kind || row.status !== 'active') {
      throw new ProfileError(
        'PROFILE_KIND',
        `profile ${id} is not an active ${kind} profile of this company`,
      );
    }
  }
  await trx
    .updateTable('app.party')
    .set({
      ...(p.customerProfileId !== undefined ? { customer_profile_id: p.customerProfileId } : {}),
      ...(p.supplierProfileId !== undefined ? { supplier_profile_id: p.supplierProfileId } : {}),
    })
    .where('company_id', '=', companyId)
    .where('id', '=', partyId)
    .execute();
}

const PRICE_RE = /^\d{1,15}(\.\d{1,4})?$/;

/** Create a product. The price is a non-negative decimal string (no floating point). */
export async function createProduct(trx: Trx, companyId: string, p: ProductInput): Promise<string> {
  if (p.unitPrice !== undefined && !PRICE_RE.test(p.unitPrice)) {
    throw new ProfileError(
      'INVALID_PRODUCT',
      `unit price ${p.unitPrice} must be ≥ 0 with ≤ 4 decimals`,
    );
  }
  const row = await trx
    .insertInto('app.product')
    .values({
      company_id: companyId,
      sku: p.sku,
      name: p.name,
      description: p.description ?? null,
      product_profile_id: p.productProfileId,
      unit_price: p.unitPrice ?? null,
      currency: p.currency ?? null,
      tax_code: p.taxCode ?? null,
      salesforce_product2_id: p.salesforceProduct2Id ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
