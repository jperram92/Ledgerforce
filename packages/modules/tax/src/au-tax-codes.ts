/**
 * AU tax-code catalogue (design §3.6) — data, not logic (design principle 3). Seeded per
 * company by T-0118 (tax_code table with effective dating); the calculator takes `rate`.
 *
 * BAS labels: G1/1A (sales), G10/G11/1B (purchases) and the adjustment label are confirmed by
 * RQ-0095/RQ-0096; G2/G3/G4 sales and the worksheet-only G13/G14 purchases by RQ-0097 (T-0035).
 * GST on imports keeps `verify: true` until import rules are researched.
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
    verify: false,
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
    verify: false,
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
    verify: false,
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
  // PAYG withholding labels on pay-run journals (GP-010): no GST; W1 gross wages on the wages
  // expense line, W2 tax withheld on the PAYG withholding line (RQ-0097 finding 3).
  {
    code: 'BAS-W1',
    name: 'PAYG W1 — gross salary and wages',
    kind: 'bas_excluded',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: [],
    purchases: ['W1'],
    verify: false,
  },
  {
    code: 'BAS-W2',
    name: 'PAYG W2 — amounts withheld',
    kind: 'bas_excluded',
    rate: '0',
    effectiveFrom: GST_START,
    effectiveTo: null,
    sales: [],
    purchases: ['W2'],
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
