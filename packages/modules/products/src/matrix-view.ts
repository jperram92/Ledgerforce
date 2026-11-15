/**
 * The whole posting-profile matrix for the screen, and filling one combination (T-0187, ADR-0082,
 * design §4.4). Every cell is resolved by matrix.ts's resolveRows, the rule that posting and the
 * gap check use, in the gap check's order (party code, then product code). So the screen, the
 * wizard's step 7 and posting cannot disagree. Nothing here writes a ledger table: an override
 * is configuration (app.posting_profile_override, migration 0033).
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import {
  resolveRows,
  setOverride,
  type GapReason,
  type OverrideInput,
  type Purpose,
} from './matrix.ts';
import { ProfileError } from './profiles.ts';

type Trx = Transaction<Database>;

export interface MatrixAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface MatrixParty {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'customer' | 'supplier';
  readonly controlAccount: MatrixAccount | null;
  readonly defaultTaxCode: string;
}

export interface MatrixProduct {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revenueAccount: MatrixAccount | null;
  readonly expenseAccount: MatrixAccount | null;
  readonly cogsAccount: MatrixAccount | null;
  readonly defaultTaxCode: string;
}

export interface MatrixCell {
  readonly partyProfileId: string;
  readonly productProfileId: string;
  readonly purpose: Purpose;
  /** The resolved account; null for a gap. */
  readonly account: MatrixAccount | null;
  readonly accountSource: 'override' | 'product' | null;
  readonly taxCode: string | null;
  readonly taxCodeSource: 'override' | 'party' | 'product' | null;
  /** An override row exists for this combination (whether or not it decides the cell). */
  readonly override: boolean;
  readonly gap: { readonly reason: GapReason; readonly message: string } | null;
}

export interface ProfileMatrix {
  readonly date: string;
  readonly parties: readonly MatrixParty[];
  readonly products: readonly MatrixProduct[];
  /** Party-major, both in code order: the gap check's order. */
  readonly cells: readonly MatrixCell[];
  /** The accounts an override may name: active, postable, non-control revenue and expense. */
  readonly choices: readonly (MatrixAccount & { readonly type: 'revenue' | 'expense' })[];
}

/** The matrix of a company on `date` (YYYY-MM-DD), or null when the company is not visible. */
export async function profileMatrix(
  trx: Trx,
  companyId: string,
  date: string,
): Promise<ProfileMatrix | null> {
  const company = await trx
    .selectFrom('app.company')
    .select('id')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!company) return null;
  const accounts = await trx
    .selectFrom('app.account')
    .select(['id', 'code', 'name', 'type', 'postable', 'is_control', 'status'])
    .where('company_id', '=', companyId)
    .orderBy('code')
    .execute();
  const byId = new Map(accounts.map((a) => [a.id, { id: a.id, code: a.code, name: a.name }]));
  const acct = (id: string | null) => (id ? (byId.get(id) ?? null) : null);
  const parties = await trx
    .selectFrom('app.party_posting_profile')
    .select(['id', 'code', 'name', 'kind', 'control_account_id', 'default_tax_code', 'status'])
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .orderBy('code')
    .execute();
  const products = await trx
    .selectFrom('app.product_posting_profile')
    .select([
      'id',
      'code',
      'name',
      'revenue_account_id',
      'expense_account_id',
      'cogs_account_id',
      'default_tax_code',
      'status',
    ])
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .orderBy('code')
    .execute();
  const overrides = await trx
    .selectFrom('app.posting_profile_override')
    .select(['party_profile_id', 'product_profile_id'])
    .where('company_id', '=', companyId)
    .execute();
  const hasOverride = new Set(
    overrides.map((o) => `${o.party_profile_id}:${o.product_profile_id}`),
  );
  const cells: MatrixCell[] = [];
  for (const party of parties) {
    for (const product of products) {
      const purpose: Purpose = party.kind === 'customer' ? 'sale' : 'purchase';
      const r = await resolveRows(trx, companyId, party, product, purpose, date);
      const base = {
        partyProfileId: party.id,
        productProfileId: product.id,
        purpose,
        override: hasOverride.has(`${party.id}:${product.id}`),
      };
      cells.push(
        r.ok
          ? {
              ...base,
              account: acct(r.accountId),
              accountSource: r.accountSource,
              taxCode: r.taxCode,
              taxCodeSource: r.taxCodeSource,
              gap: null,
            }
          : {
              ...base,
              account: null,
              accountSource: null,
              taxCode: null,
              taxCodeSource: null,
              gap: { reason: r.gap.reason, message: r.gap.message },
            },
      );
    }
  }
  const choices: (MatrixAccount & { type: 'revenue' | 'expense' })[] = [];
  for (const a of accounts) {
    if ((a.type === 'revenue' || a.type === 'expense') && a.postable && !a.is_control)
      if (a.status === 'active')
        choices.push({ id: a.id, code: a.code, name: a.name, type: a.type });
  }
  return {
    date,
    parties: parties.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      kind: x.kind,
      controlAccount: acct(x.control_account_id),
      defaultTaxCode: x.default_tax_code,
    })),
    products: products.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      revenueAccount: acct(x.revenue_account_id),
      expenseAccount: acct(x.expense_account_id),
      cogsAccount: acct(x.cogs_account_id),
      defaultTaxCode: x.default_tax_code,
    })),
    cells,
    choices,
  };
}

export interface OverrideView {
  readonly revenueAccountId: string | null;
  readonly expenseAccountId: string | null;
  readonly cogsAccountId: string | null;
  readonly discountAccountId: string | null;
  readonly taxCode: string | null;
}

/** The override row of one combination, or null when there is none. */
export async function overrideOf(
  trx: Trx,
  companyId: string,
  partyProfileId: string,
  productProfileId: string,
): Promise<OverrideView | null> {
  const o = await trx
    .selectFrom('app.posting_profile_override')
    .select([
      'revenue_account_id',
      'expense_account_id',
      'cogs_account_id',
      'discount_account_id',
      'tax_code',
    ])
    .where('company_id', '=', companyId)
    .where('party_profile_id', '=', partyProfileId)
    .where('product_profile_id', '=', productProfileId)
    .executeTakeFirst();
  return o
    ? {
        revenueAccountId: o.revenue_account_id,
        expenseAccountId: o.expense_account_id,
        cogsAccountId: o.cogs_account_id,
        discountAccountId: o.discount_account_id,
        taxCode: o.tax_code,
      }
    : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = [
  'revenueAccountId',
  'expenseAccountId',
  'cogsAccountId',
  'discountAccountId',
  'taxCode',
] as const;

/**
 * Set one combination's override (ADR-0082). Both profiles must be active profiles of the company
 * (PROFILE_UNKNOWN), a tax code an active tax code of the company (PROFILE_TAX_CODE), and accounts
 * usable (setOverride: PROFILE_ACCOUNT). A field left undefined keeps its value; null clears it.
 * Writes nothing, and answers changed:false, when the values are already set.
 */
export async function fillOverride(
  trx: Trx,
  companyId: string,
  i: OverrideInput,
): Promise<{ before: OverrideView | null; after: OverrideView; changed: boolean }> {
  const active = async (
    table: 'app.party_posting_profile' | 'app.product_posting_profile',
    id: string,
  ) =>
    UUID.test(id) &&
    (await trx
      .selectFrom(table)
      .select('id')
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .where('status', '=', 'active')
      .executeTakeFirst()) !== undefined;
  if (
    !(await active('app.party_posting_profile', i.partyProfileId)) ||
    !(await active('app.product_posting_profile', i.productProfileId))
  ) {
    throw new ProfileError(
      'PROFILE_UNKNOWN',
      'the party or product profile is not an active posting profile of this company',
    );
  }
  if (i.taxCode) {
    const t = await trx
      .selectFrom('app.tax_code')
      .select('code')
      .where('company_id', '=', companyId)
      .where('code', '=', i.taxCode)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!t)
      throw new ProfileError(
        'PROFILE_TAX_CODE',
        `tax code ${i.taxCode} is not an active tax code of this company`,
      );
  }
  const before = await overrideOf(trx, companyId, i.partyProfileId, i.productProfileId);
  // Account ids are uuids (any case); tax codes compare exactly.
  const norm = (k: (typeof KEYS)[number], v: string | null | undefined) =>
    v ? (k === 'taxCode' ? v : v.toLowerCase()) : null;
  const unchanged =
    before !== null &&
    KEYS.every((k) => i[k] === undefined || norm(k, i[k]) === norm(k, before[k]));
  if (before && unchanged) return { before, after: before, changed: false };
  await setOverride(trx, companyId, i);
  const after = await overrideOf(trx, companyId, i.partyProfileId, i.productProfileId);
  if (!after) throw new Error('the override was not written');
  return { before, after, changed: true };
}
