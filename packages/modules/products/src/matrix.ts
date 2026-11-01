/**
 * Posting-profile matrix resolution and gap check (T-0039, design §4.4, DL-0267).
 *
 * A document line's accounts come from party profile × product profile:
 * - sale (customer profile): revenue = override ?? product profile revenue;
 * - purchase (supplier profile): override expense ?? product expense ?? override COGS ?? product
 *   COGS (a resale item without an expense account is bought into cost of sales);
 * - control account: the party profile's (AR for customers, AP for suppliers).
 * Each must be an active, postable, non-control account of the right type, else PROFILE_GAP.
 *
 * Tax code: the override's; else, when party and product defaults agree, that code; when they
 * differ, an exemption beats a taxable code (an overseas customer's GST-free export beats a GST
 * service; a GST-free product beats a domestic customer's GST); two different taxable codes →
 * the product's (capital vs non-capital is a product fact); two different exemptions are
 * ambiguous → PROFILE_GAP until an override decides. The chosen code must be active and in force
 * on the document date.
 *
 * profileGaps() lists every active combination that could occur (customer profiles × products
 * for sales, supplier profiles × products for purchases) and does not resolve — the wizard shows
 * it and a nightly job runs it (scheduling waits for ADR-0029; DL-0267).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { requireAccount, type AccountFacts } from './profiles.ts';

type Trx = Transaction<Database>;

export type Purpose = 'sale' | 'purchase';
export type GapReason = 'profile' | 'kind' | 'account' | 'control' | 'tax_code';

export interface ProfileGap {
  readonly code: 'PROFILE_GAP';
  readonly partyProfile: string;
  readonly productProfile: string;
  readonly purpose: Purpose;
  readonly reason: GapReason;
  readonly message: string;
}

export type Resolution =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly accountSource: 'override' | 'product';
      readonly controlAccountId: string;
      readonly taxCode: string;
      readonly taxCodeSource: 'override' | 'party' | 'product';
    }
  | { readonly ok: false; readonly gap: ProfileGap };

export interface ResolveQuery {
  readonly partyProfileId: string;
  readonly productProfileId: string;
  readonly purpose: Purpose;
  /** Document date, YYYY-MM-DD: tax codes must be in force on it. */
  readonly date: string;
}

interface PartyRow {
  id: string;
  code: string;
  kind: 'customer' | 'supplier';
  control_account_id: string;
  default_tax_code: string;
  status: string;
}
interface ProductRow {
  id: string;
  code: string;
  revenue_account_id: string;
  expense_account_id: string | null;
  cogs_account_id: string | null;
  default_tax_code: string;
  status: string;
}

const EXEMPT_KINDS = new Set(['gst_free', 'input_taxed', 'bas_excluded']);

export async function resolvePosting(
  trx: Trx,
  companyId: string,
  q: ResolveQuery,
): Promise<Resolution> {
  const partyRow = await trx
    .selectFrom('app.party_posting_profile')
    .select(['id', 'code', 'kind', 'control_account_id', 'default_tax_code', 'status'])
    .where('company_id', '=', companyId)
    .where('id', '=', q.partyProfileId)
    .executeTakeFirst();
  const productRow = await trx
    .selectFrom('app.product_posting_profile')
    .select([
      'id',
      'code',
      'revenue_account_id',
      'expense_account_id',
      'cogs_account_id',
      'default_tax_code',
      'status',
    ])
    .where('company_id', '=', companyId)
    .where('id', '=', q.productProfileId)
    .executeTakeFirst();
  return resolveRows(trx, companyId, partyRow, productRow, q.purpose, q.date);
}

async function resolveRows(
  trx: Trx,
  companyId: string,
  party: PartyRow | undefined,
  product: ProductRow | undefined,
  purpose: Purpose,
  date: string,
): Promise<Resolution> {
  const gap = (reason: GapReason, message: string): Resolution => ({
    ok: false,
    gap: {
      code: 'PROFILE_GAP',
      partyProfile: party?.code ?? '?',
      productProfile: product?.code ?? '?',
      purpose,
      reason,
      message,
    },
  });
  if (!party || party.status !== 'active' || !product || product.status !== 'active') {
    return gap('profile', 'party or product profile is missing or archived');
  }
  const wantKind = purpose === 'sale' ? 'customer' : 'supplier';
  if (party.kind !== wantKind) {
    return gap(
      'kind',
      `a ${purpose} needs a ${wantKind} profile; ${party.code} is a ${party.kind} profile`,
    );
  }
  const o = await trx
    .selectFrom('app.posting_profile_override')
    .select(['revenue_account_id', 'expense_account_id', 'cogs_account_id', 'tax_code'])
    .where('company_id', '=', companyId)
    .where('party_profile_id', '=', party.id)
    .where('product_profile_id', '=', product.id)
    .executeTakeFirst();

  // Account: first candidate wins; it must be usable.
  const candidates: [string | null | undefined, 'override' | 'product'][] =
    purpose === 'sale'
      ? [
          [o?.revenue_account_id, 'override'],
          [product.revenue_account_id, 'product'],
        ]
      : [
          [o?.expense_account_id, 'override'],
          [product.expense_account_id, 'product'],
          [o?.cogs_account_id, 'override'],
          [product.cogs_account_id, 'product'],
        ];
  const chosen = candidates.find(([id]) => id);
  const accountType = purpose === 'sale' ? 'revenue' : 'expense';
  if (!chosen?.[0]) {
    return gap(
      'account',
      `${product.code} has no ${purpose === 'sale' ? 'revenue' : 'expense or COGS'} account`,
    );
  }
  const usable = (types: string[]) => (a: AccountFacts) =>
    types.includes(a.type) && a.postable && !a.is_control;
  try {
    await requireAccount(
      trx,
      companyId,
      product.code,
      accountType,
      chosen[0],
      usable([accountType]),
      `an active postable ${accountType} account`,
    );
  } catch (e) {
    return gap('account', (e as Error).message);
  }
  try {
    await requireAccount(
      trx,
      companyId,
      party.code,
      'control',
      party.control_account_id,
      (a) => a.roles.includes(party.kind === 'customer' ? 'AR_CONTROL' : 'AP_CONTROL'),
      'the active control account',
    );
  } catch (e) {
    return gap('control', (e as Error).message);
  }

  // Tax code.
  const kindsInForce = await taxKinds(trx, companyId, date, [
    ...new Set(
      [o?.tax_code, party.default_tax_code, product.default_tax_code].filter(
        (c): c is string => !!c,
      ),
    ),
  ]);
  let taxCode: string;
  let taxCodeSource: 'override' | 'party' | 'product';
  if (o?.tax_code) {
    taxCode = o.tax_code;
    taxCodeSource = 'override';
  } else if (party.default_tax_code === product.default_tax_code) {
    taxCode = product.default_tax_code;
    taxCodeSource = 'product';
  } else {
    const partyKind = kindsInForce.get(party.default_tax_code);
    const productKind = kindsInForce.get(product.default_tax_code);
    if (partyKind === undefined || productKind === undefined) {
      const missing = partyKind === undefined ? party.default_tax_code : product.default_tax_code;
      return gap('tax_code', `tax code ${missing} is not active and in force on ${date}`);
    }
    const partyExempt = EXEMPT_KINDS.has(partyKind);
    const productExempt = EXEMPT_KINDS.has(productKind);
    if (partyExempt && productExempt) {
      return gap(
        'tax_code',
        `${party.default_tax_code} (${party.code}) and ${product.default_tax_code} (${product.code}) are both exemptions; set an override`,
      );
    }
    [taxCode, taxCodeSource] = partyExempt
      ? [party.default_tax_code, 'party']
      : [product.default_tax_code, 'product'];
  }
  if (!kindsInForce.has(taxCode)) {
    return gap('tax_code', `tax code ${taxCode} is not active and in force on ${date}`);
  }
  return {
    ok: true,
    accountId: chosen[0],
    accountSource: chosen[1],
    controlAccountId: party.control_account_id,
    taxCode,
    taxCodeSource,
  };
}

/** code → kind of the company's active tax codes in force on `date`. */
async function taxKinds(
  trx: Trx,
  companyId: string,
  date: string,
  codes: string[],
): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();
  const r = await sql<{ code: string; kind: string }>`
    SELECT code, kind FROM app.tax_code
     WHERE company_id = ${companyId} AND status = 'active' AND code = ANY(${sql.val(codes)}::text[])
       AND effective_from <= ${date}::date AND (effective_to IS NULL OR effective_to >= ${date}::date)`.execute(
    trx,
  );
  return new Map(r.rows.map((x) => [x.code, x.kind]));
}

/**
 * Every active party × product combination that could occur and does not resolve, ordered by
 * party then product profile code. [] = no gaps.
 */
export async function profileGaps(
  trx: Trx,
  companyId: string,
  date: string,
): Promise<ProfileGap[]> {
  const parties = await trx
    .selectFrom('app.party_posting_profile')
    .select(['id', 'code', 'kind', 'control_account_id', 'default_tax_code', 'status'])
    .where('company_id', '=', companyId)
    .where('status', '=', 'active')
    .orderBy('code')
    .execute();
  const products = await trx
    .selectFrom('app.product_posting_profile')
    .select([
      'id',
      'code',
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
  const gaps: ProfileGap[] = [];
  for (const party of parties) {
    for (const product of products) {
      const purpose: Purpose = party.kind === 'customer' ? 'sale' : 'purchase';
      const r = await resolveRows(trx, companyId, party, product, purpose, date);
      if (!r.ok) gaps.push(r.gap);
    }
  }
  return gaps;
}

export interface OverrideInput {
  readonly partyProfileId: string;
  readonly productProfileId: string;
  readonly revenueAccountId?: string | null;
  readonly expenseAccountId?: string | null;
  readonly cogsAccountId?: string | null;
  readonly discountAccountId?: string | null;
  readonly taxCode?: string | null;
}

/** Set (insert or update) the override for one combination; a null clears that column. */
export async function setOverride(trx: Trx, companyId: string, i: OverrideInput): Promise<void> {
  const postable = (types: string[]) => (a: AccountFacts) =>
    types.includes(a.type) && a.postable && !a.is_control;
  for (const [what, id, types] of [
    ['revenue', i.revenueAccountId, ['revenue']],
    ['expense', i.expenseAccountId, ['expense']],
    ['cogs', i.cogsAccountId, ['expense']],
    ['discount', i.discountAccountId, ['revenue', 'expense']],
  ] as const) {
    if (id) {
      await requireAccount(
        trx,
        companyId,
        'override',
        what,
        id,
        postable([...types]),
        `a postable ${types.join(' or ')} account`,
      );
    }
  }
  const values = {
    ...(i.revenueAccountId !== undefined ? { revenue_account_id: i.revenueAccountId } : {}),
    ...(i.expenseAccountId !== undefined ? { expense_account_id: i.expenseAccountId } : {}),
    ...(i.cogsAccountId !== undefined ? { cogs_account_id: i.cogsAccountId } : {}),
    ...(i.discountAccountId !== undefined ? { discount_account_id: i.discountAccountId } : {}),
    ...(i.taxCode !== undefined ? { tax_code: i.taxCode } : {}),
  };
  await trx
    .insertInto('app.posting_profile_override')
    .values({
      company_id: companyId,
      party_profile_id: i.partyProfileId,
      product_profile_id: i.productProfileId,
      ...values,
    })
    .onConflict((oc) =>
      oc
        .columns(['tenant_id', 'company_id', 'party_profile_id', 'product_profile_id'])
        .doUpdateSet({ ...values, updated_at: sql`clock_timestamp()` }),
    )
    .execute();
}
