/**
 * Posting-profile matrix resolution and gap check — pure functions over a snapshot of a
 * company's profiles and overrides (design §4.4, RQ-0097, DL-0260). profile-resolution.ts loads
 * the snapshot inside the tenant transaction; nothing here reads or writes the database or posts.
 *
 * Account: party profile × product profile × slot override → product profile slot → PROFILE_GAP.
 * Tax code: explicit line code → the party-profile or product default when only one is set or
 * both are equal → TAX_CODE_CONFLICT / NO_TAX_CODE (a precedence between differing defaults is a
 * tax treatment left to the human; RQ-0097).
 */
import {
  CONTROL_ROLE_FOR_KIND,
  POSTING_SLOTS,
  type PartyControlRole,
  type PartyKind,
  type PostingSlot,
} from './posting-slots.ts';

export const DIRECTIONS = ['sale', 'purchase'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Which slots a direction can post (RQ-0097 finding 4); COGS is recognised on the sale. */
export const DIRECTION_SLOTS: Readonly<Record<Direction, readonly PostingSlot[]>> = {
  sale: ['revenue', 'discount', 'cogs'],
  purchase: ['expense', 'asset'],
};

/** A sale is made to a customer, a purchase from a supplier. */
export const DIRECTION_PARTY_KIND: Readonly<Record<Direction, PartyKind>> = {
  sale: 'customer',
  purchase: 'supplier',
};

export interface MatrixAccount {
  id: string;
  code: string;
}

export interface MatrixPartyProfile {
  id: string;
  code: string;
  partyKind: PartyKind;
  status: 'active' | 'archived';
  defaultTaxCode: string | null;
}

export interface MatrixProductProfile {
  id: string;
  code: string;
  status: 'active' | 'archived';
  slots: Partial<Record<PostingSlot, MatrixAccount>>;
}

export interface MatrixOverride {
  partyProfileId: string;
  productProfileId: string;
  slot: PostingSlot;
  account: MatrixAccount;
}

export interface PostingMatrix {
  partyProfiles: readonly MatrixPartyProfile[];
  productProfiles: readonly MatrixProductProfile[];
  overrides: readonly MatrixOverride[];
}

export type ResolutionErrorCode =
  | 'PROFILE_GAP'
  | 'NO_PARTY_PROFILE'
  | 'NO_PRODUCT_PROFILE'
  | 'PROFILE_ARCHIVED'
  | 'SLOT_NOT_FOR_DIRECTION'
  | 'TAX_CODE_CONFLICT'
  | 'NO_TAX_CODE';

export class PostingProfileResolutionError extends Error {
  readonly code: ResolutionErrorCode;
  readonly details: Readonly<Record<string, string>>;
  constructor(code: ResolutionErrorCode, sentence: string, details: Record<string, string> = {}) {
    super(`${code}: ${sentence}`);
    this.name = 'PostingProfileResolutionError';
    this.code = code;
    this.details = details;
  }
}

export interface AccountQuery {
  direction: Direction;
  slot: PostingSlot;
  /** The party's profile for the direction (customer or supplier), null when it has none. */
  partyProfileId: string | null;
  productProfileId: string | null;
  /** Names used in refusals when a profile is missing. */
  partyLabel?: string | undefined;
  productLabel?: string | undefined;
}

export interface ResolvedAccount {
  account: MatrixAccount;
  source: 'override' | 'product_profile';
  partyProfile: string;
  productProfile: string;
  controlRole: PartyControlRole;
}

const gapSentence = (d: Direction, party: string, product: string, slot: PostingSlot) =>
  `no ${slot} account for ${party} × ${product} (${d}): ` +
  `product posting profile ${product} has no ${slot} account and there is no override`;

/** The account for one combination, or undefined when it is a gap. */
function lookup(
  m: PostingMatrix,
  party: MatrixPartyProfile,
  product: MatrixProductProfile,
  slot: PostingSlot,
): Pick<ResolvedAccount, 'account' | 'source'> | undefined {
  const o = m.overrides.find(
    (x) => x.partyProfileId === party.id && x.productProfileId === product.id && x.slot === slot,
  );
  if (o) return { account: o.account, source: 'override' };
  const a = product.slots[slot];
  return a ? { account: a, source: 'product_profile' } : undefined;
}

export function resolvePostingAccount(m: PostingMatrix, q: AccountQuery): ResolvedAccount {
  const kind = DIRECTION_PARTY_KIND[q.direction];
  if (!DIRECTION_SLOTS[q.direction].includes(q.slot)) {
    throw new PostingProfileResolutionError(
      'SLOT_NOT_FOR_DIRECTION',
      `slot ${q.slot} is not used on a ${q.direction} (${q.direction} slots: ${DIRECTION_SLOTS[q.direction].join(', ')})`,
      { direction: q.direction, slot: q.slot },
    );
  }
  const party =
    q.partyProfileId === null ? undefined : m.partyProfiles.find((p) => p.id === q.partyProfileId);
  if (!party) {
    const who = q.partyLabel === undefined ? 'the party' : `party ${q.partyLabel}`;
    throw new PostingProfileResolutionError(
      'NO_PARTY_PROFILE',
      `${who} has no ${kind} posting profile (${q.direction})`,
      { direction: q.direction },
    );
  }
  if (party.partyKind !== kind) {
    throw new PostingProfileResolutionError(
      'NO_PARTY_PROFILE',
      `party posting profile ${party.code} is a ${party.partyKind} profile; ${q.direction} needs a ${kind} profile`,
      { direction: q.direction, partyProfile: party.code },
    );
  }
  if (party.status !== 'active') {
    throw new PostingProfileResolutionError(
      'PROFILE_ARCHIVED',
      `party posting profile ${party.code} is archived`,
      {
        partyProfile: party.code,
      },
    );
  }
  const product =
    q.productProfileId === null
      ? undefined
      : m.productProfiles.find((p) => p.id === q.productProfileId);
  if (!product) {
    const what = q.productLabel === undefined ? 'the product' : `product ${q.productLabel}`;
    throw new PostingProfileResolutionError(
      'NO_PRODUCT_PROFILE',
      `${what} has no product posting profile`,
    );
  }
  if (product.status !== 'active') {
    throw new PostingProfileResolutionError(
      'PROFILE_ARCHIVED',
      `product posting profile ${product.code} is archived`,
      {
        productProfile: product.code,
      },
    );
  }
  const hit = lookup(m, party, product, q.slot);
  if (!hit) {
    throw new PostingProfileResolutionError(
      'PROFILE_GAP',
      gapSentence(q.direction, party.code, product.code, q.slot),
      {
        direction: q.direction,
        partyProfile: party.code,
        productProfile: product.code,
        slot: q.slot,
      },
    );
  }
  return {
    ...hit,
    partyProfile: party.code,
    productProfile: product.code,
    controlRole: CONTROL_ROLE_FOR_KIND[party.partyKind],
  };
}

export interface TaxCodeQuery {
  lineTaxCode?: string | null | undefined;
  partyTaxCode: string | null;
  productTaxCode: string | null;
  /** Names used in a conflict refusal. */
  partyProfile?: string | undefined;
  product?: string | undefined;
}

export interface ResolvedTaxCode {
  taxCode: string;
  source: 'line' | 'party_profile' | 'product' | 'party_profile_and_product';
}

export function resolveTaxCode(q: TaxCodeQuery): ResolvedTaxCode {
  if (q.lineTaxCode !== undefined && q.lineTaxCode !== null)
    return { taxCode: q.lineTaxCode, source: 'line' };
  const { partyTaxCode: party, productTaxCode: product } = q;
  if (party !== null && product !== null) {
    if (party === product) return { taxCode: party, source: 'party_profile_and_product' };
    const who =
      q.partyProfile === undefined
        ? 'the party posting profile'
        : `party posting profile ${q.partyProfile}`;
    const what = q.product === undefined ? 'the product' : `product ${q.product}`;
    throw new PostingProfileResolutionError(
      'TAX_CODE_CONFLICT',
      `${who} defaults to ${party} but ${what} defaults to ${product}; choose the tax code on the line`,
      { partyTaxCode: party, productTaxCode: product },
    );
  }
  if (party !== null) return { taxCode: party, source: 'party_profile' };
  if (product !== null) return { taxCode: product, source: 'product' };
  throw new PostingProfileResolutionError(
    'NO_TAX_CODE',
    'no tax code on the line, the party posting profile or the product',
  );
}

export interface PostingProfileQuery extends AccountQuery {
  productTaxCode: string | null;
  lineTaxCode?: string | null | undefined;
}

export interface ResolvedPostingProfile extends ResolvedAccount {
  taxCode: string;
  taxCodeSource: ResolvedTaxCode['source'];
}

/** Account and tax code for one line; the account is resolved (and refused) first. */
export function resolvePostingProfile(
  m: PostingMatrix,
  q: PostingProfileQuery,
): ResolvedPostingProfile {
  const account = resolvePostingAccount(m, q);
  const party = m.partyProfiles.find((p) => p.id === q.partyProfileId);
  const tax = resolveTaxCode({
    lineTaxCode: q.lineTaxCode,
    partyTaxCode: party?.defaultTaxCode ?? null,
    productTaxCode: q.productTaxCode,
    partyProfile: account.partyProfile,
    product: q.productLabel,
  });
  return { ...account, taxCode: tax.taxCode, taxCodeSource: tax.source };
}

export interface ProfileGap {
  direction: Direction;
  partyProfile: { id: string; code: string };
  productProfile: { id: string; code: string };
  slot: PostingSlot;
  /** The same sentence the resolver's PROFILE_GAP refusal carries. */
  message: string;
}

/**
 * Every active party profile × active product profile × slot of the party profile's direction
 * that cannot resolve (design §4.4 gap check), sorted by direction, party, product, slot.
 */
export function findProfileGaps(
  m: PostingMatrix,
  opts: { slots?: readonly PostingSlot[] | undefined } = {},
): ProfileGap[] {
  const wanted = new Set(opts.slots ?? POSTING_SLOTS);
  const gaps: ProfileGap[] = [];
  for (const party of m.partyProfiles) {
    if (party.status !== 'active') continue;
    const direction: Direction = party.partyKind === 'customer' ? 'sale' : 'purchase';
    for (const product of m.productProfiles) {
      if (product.status !== 'active') continue;
      for (const slot of DIRECTION_SLOTS[direction]) {
        if (!wanted.has(slot) || lookup(m, party, product, slot)) continue;
        gaps.push({
          direction,
          partyProfile: { id: party.id, code: party.code },
          productProfile: { id: product.id, code: product.code },
          slot,
          message: `PROFILE_GAP: ${gapSentence(direction, party.code, product.code, slot)}`,
        });
      }
    }
  }
  const key = (g: ProfileGap) => [g.direction, g.partyProfile.code, g.productProfile.code, g.slot];
  return gaps.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const c = (ka[i] ?? '') < (kb[i] ?? '') ? -1 : (ka[i] ?? '') > (kb[i] ?? '') ? 1 : 0;
      if (c !== 0) return c;
    }
    return 0;
  });
}
