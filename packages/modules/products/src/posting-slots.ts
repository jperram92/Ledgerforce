/**
 * Product posting-profile slots (design §4.4, RQ-0096, DL-0250). SLOT_ACCOUNT_TYPES mirrors
 * app.posting_slot_allows() in migration 0032; posting-profiles.db.test.ts proves they agree for
 * every slot × account type. Golden-file keys read `product:<PROFILE>.<slot>`.
 */
import type { AccountType } from '@ledgerforce/db';

export const POSTING_SLOTS = ['revenue', 'discount', 'expense', 'cogs', 'asset'] as const;
export type PostingSlot = (typeof POSTING_SLOTS)[number];

export const SLOT_ACCOUNT_TYPES: Readonly<Record<PostingSlot, readonly AccountType[]>> = {
  revenue: ['revenue'],
  // A contra-revenue account (type revenue) or a "discounts given" expense.
  discount: ['revenue', 'expense'],
  expense: ['expense'],
  cogs: ['expense'],
  // Capitalised purchases, e.g. HARDWARE.asset.
  asset: ['asset'],
};

export const isPostingSlot = (s: string): s is PostingSlot =>
  (POSTING_SLOTS as readonly string[]).includes(s);

export const slotAllows = (slot: PostingSlot, type: AccountType): boolean =>
  SLOT_ACCOUNT_TYPES[slot].includes(type);

export const PARTY_KINDS = ['customer', 'supplier'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];
export type PartyControlRole = 'AR_CONTROL' | 'AP_CONTROL';

/** A customer profile posts to AR_CONTROL, a supplier profile to AP_CONTROL (design §4.4). */
export const CONTROL_ROLE_FOR_KIND: Readonly<Record<PartyKind, PartyControlRole>> = {
  customer: 'AR_CONTROL',
  supplier: 'AP_CONTROL',
};
