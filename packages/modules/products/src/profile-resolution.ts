/**
 * Posting-profile resolution and gap check over a company's stored matrix (design §4.4,
 * RQ-0097, DL-0260). Runs inside the caller's tenant transaction (withTenant), so RLS limits every
 * read to the session tenant. Reads only; nothing here writes or posts — posting rules (T-0040,
 * T-0069) call the resolver and build their journal through packages/ledger.
 */
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import {
  findProfileGaps,
  resolvePostingProfile,
  type Direction,
  type MatrixProductProfile,
  type PostingMatrix,
  type ProfileGap,
  type ResolvedPostingProfile,
} from './matrix.ts';
import { POSTING_SLOTS, type PartyKind, type PostingSlot } from './posting-slots.ts';

/** A snapshot of the company's party and product profiles and overrides (all statuses). */
export async function loadPostingMatrix(
  trx: Transaction<Database>,
  companyId: string,
): Promise<PostingMatrix> {
  const [parties, products, overrides, accounts] = await Promise.all([
    trx
      .selectFrom('app.party_posting_profile')
      .select(['id', 'code', 'party_kind', 'status', 'default_tax_code'])
      .where('company_id', '=', companyId)
      .execute(),
    trx
      .selectFrom('app.product_posting_profile')
      .select([
        'id',
        'code',
        'status',
        'revenue_account_id',
        'discount_account_id',
        'expense_account_id',
        'cogs_account_id',
        'asset_account_id',
      ])
      .where('company_id', '=', companyId)
      .execute(),
    trx
      .selectFrom('app.posting_profile_override')
      .select(['party_posting_profile_id', 'product_posting_profile_id', 'slot', 'account_id'])
      .where('company_id', '=', companyId)
      .execute(),
    trx
      .selectFrom('app.account')
      .select(['id', 'code'])
      .where('company_id', '=', companyId)
      .execute(),
  ]);
  const code = new Map(accounts.map((a) => [a.id, a.code]));
  const account = (id: string) => {
    const c = code.get(id);
    if (c === undefined) throw new Error(`account ${id} not found in company ${companyId}`); // FK guarantees it
    return { id, code: c };
  };
  return {
    partyProfiles: parties.map((p) => ({
      id: p.id,
      code: p.code,
      partyKind: p.party_kind as PartyKind,
      status: p.status as 'active' | 'archived',
      defaultTaxCode: p.default_tax_code,
    })),
    productProfiles: products.map((p) => {
      const slots: MatrixProductProfile['slots'] = {};
      for (const s of POSTING_SLOTS) {
        const id = p[`${s}_account_id`];
        if (id !== null) slots[s] = account(id);
      }
      return { id: p.id, code: p.code, status: p.status as 'active' | 'archived', slots };
    }),
    overrides: overrides.map((o) => ({
      partyProfileId: o.party_posting_profile_id,
      productProfileId: o.product_posting_profile_id,
      slot: o.slot as PostingSlot,
      account: account(o.account_id),
    })),
  };
}

export interface PartyProductQuery {
  companyId: string;
  partyId: string;
  productId: string;
  direction: Direction;
  slot: PostingSlot;
  /** A tax code chosen on the document line; it always wins (RQ-0097). */
  lineTaxCode?: string | null | undefined;
}

/**
 * Account and tax code for a party, product, direction and slot. Throws
 * PostingProfileResolutionError (PROFILE_GAP, NO_PARTY_PROFILE, …) naming what is missing.
 */
export async function resolvePartyProductPosting(
  trx: Transaction<Database>,
  q: PartyProductQuery,
): Promise<ResolvedPostingProfile> {
  const party = await trx
    .selectFrom('app.party')
    .select(['legal_name', 'customer_posting_profile_id', 'supplier_posting_profile_id'])
    .where('company_id', '=', q.companyId)
    .where('id', '=', q.partyId)
    .executeTakeFirst();
  if (!party) throw new Error(`party ${q.partyId} not found in this company`);
  const product = await trx
    .selectFrom('app.product')
    .select(['name', 'product_posting_profile_id', 'default_tax_code'])
    .where('company_id', '=', q.companyId)
    .where('id', '=', q.productId)
    .executeTakeFirst();
  if (!product) throw new Error(`product ${q.productId} not found in this company`);
  const matrix = await loadPostingMatrix(trx, q.companyId);
  return resolvePostingProfile(matrix, {
    direction: q.direction,
    slot: q.slot,
    partyProfileId:
      q.direction === 'sale'
        ? party.customer_posting_profile_id
        : party.supplier_posting_profile_id,
    productProfileId: product.product_posting_profile_id,
    partyLabel: party.legal_name,
    productLabel: product.name,
    productTaxCode: product.default_tax_code,
    lineTaxCode: q.lineTaxCode,
  });
}

/**
 * The gap check (design §4.4): every active party profile × active product profile × slot of the
 * profile's direction that cannot resolve, optionally narrowed to `slots`. Used by the setup
 * wizard and, later, the nightly job and the period close.
 */
export async function postingProfileGapCheck(
  trx: Transaction<Database>,
  q: { companyId: string; slots?: readonly PostingSlot[] | undefined },
): Promise<ProfileGap[]> {
  return findProfileGaps(await loadPostingMatrix(trx, q.companyId), { slots: q.slots });
}
