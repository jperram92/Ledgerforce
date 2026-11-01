/**
 * AU tax-code catalogue (design §3.6) — data, not logic (design principle 3). Seeded per
 * company by T-0118 (tax_code table with effective dating); the calculator takes `rate`.
 *
 * BAS labels: G1/1A (sales), G10/G11/1B (purchases) and the adjustment label are confirmed by
 * RQ-0095/RQ-0096. Labels marked `verify: true` (G2/G3 exports and other GST-free sales,
 * G13/G14 input-taxed and GST-free purchases, GST on imports) come from prior knowledge and are
 * re-checked against the ATO BAS instructions in the BAS report task before they drive a BAS.
 */
export type TaxCodeKind =
  'taxable' | 'gst_free' | 'input_taxed' | 'bas_excluded' | 'import' | 'capital' | 'adjustment';

export interface TaxCodeDefinition {
  readonly code: string;
  readonly name: string;
  readonly kind: TaxCodeKind;
  /** Fraction, e.g. "0.10". */
  readonly rate: string;
  /** Inclusive first day the rate applies (GST began 2000-07-01). */
  readonly effectiveFrom: string;
  /** null = still in force. */
  readonly effectiveTo: string | null;
  /** BAS labels when used on sales / purchases. */
  readonly sales: readonly string[];
  readonly purchases: readonly string[];
  /** True when a label mapping still needs checking against the ATO BAS instructions. */
  readonly verify: boolean;
}

const GST_START = '2000-07-01';

export const AU_TAX_CODES: readonly TaxCodeDefinition[] = Object.freeze([
  {
    code: 'GST',
    name: 'GST 10%',
    kind: 'taxable',
    rate: '0.10',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: ['G1', '1A'],
    purchases: ['G11', '1B'],
    verify: false,
  },
  {
    code: 'GST-CAP',
    name: 'GST on capital purchases',
    kind: 'capital',
    rate: '0.10',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: [],
    purchases: ['G10', '1B'],
    verify: false,
  },
  {
    code: 'GST-FREE',
    name: 'GST-free',
    kind: 'gst_free',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: ['G1', 'G3'],
    purchases: ['G11', 'G14'],
    verify: true,
  },
  {
    code: 'GST-FREE-EXPORT',
    name: 'GST-free export',
    kind: 'gst_free',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: ['G1', 'G2'],
    purchases: [],
    verify: true,
  },
  {
    code: 'INPUT-TAXED',
    name: 'Input taxed',
    kind: 'input_taxed',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: ['G1', 'G4'],
    purchases: ['G11', 'G13'],
    verify: true,
  },
  {
    code: 'BAS-EXCLUDED',
    name: 'BAS excluded',
    kind: 'bas_excluded',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: [],
    purchases: [],
    verify: false,
  },
  {
    code: 'GST-IMPORT',
    name: 'GST on imports',
    kind: 'import',
    rate: '0.10',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: [],
    purchases: ['G11', '1B'],
    verify: true,
  },
  {
    code: 'GST-ADJ',
    name: 'GST adjustment (bad debts, adjustment notes)',
    kind: 'adjustment',
    rate: '0.10',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: ['1A'],
    purchases: ['1B'],
    verify: false,
  },
]);

/** The definition of `code` in force on `date` (YYYY-MM-DD), or undefined. */
export function taxCodeOn(
  code: string,
  date: string,
  catalogue: readonly TaxCodeDefinition[] = AU_TAX_CODES,
): TaxCodeDefinition | undefined {
  return catalogue.find(
    (t) =>
      t.code === code &&
      t.effectiveFrom <= date &&
      (t.effectiveTo === null || date <= t.effectiveTo),
  );
}
