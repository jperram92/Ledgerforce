/**
 * BAS arithmetic, unit level (T-0035, RQ-0102, DL-0277, DL-0278). The db layer
 * (bas-report.db.test.ts) proves the same rules against the Approved goldens.
 */
import { SOURCE_TYPES } from '@ledgerforce/ledger';
import { describe, expect, it } from 'vitest';
import {
  BasReportError,
  CASH_ATTRIBUTION,
  cashAttribution,
  computeBas,
  flowOf,
  lineContributions,
  type BasLine,
} from './bas-compute.ts';
import type { BasLabelMapRow } from './bas-report.ts';
import { auTaxCodes } from './tax-codes.ts';

const MAP: BasLabelMapRow[] = (auTaxCodes.basLabels ?? []).map((l) => ({
  taxCode: l.code,
  flow: l.flow,
  label: l.label,
  amount: l.amount,
  positiveSide: l.positiveSide,
  basis: l.basis,
  validFrom: l.validFrom,
  validTo: null,
}));

const line = (o: Partial<BasLine>): BasLine => ({
  entryId: 'e1',
  entryDate: '2026-11-05',
  accountType: 'revenue',
  debit: '0.0000',
  credit: '0.0000',
  taxCode: 'GST',
  taxAmount: null,
  ...o,
});
const contrib = (l: BasLine, basis: 'accruals' | 'cash' = 'accruals') =>
  Object.fromEntries([...lineContributions(l, MAP, basis)].map(([k, v]) => [k, v.toString()]));

describe('cash-basis attribution covers the ledger’s source types (DL-0278)', () => {
  it('lists exactly the source types the ledger accepts', () => {
    expect(Object.keys(CASH_ATTRIBUTION).sort()).toEqual(Object.keys(SOURCE_TYPES).sort());
  });

  it('fails closed on an unknown source type', () => {
    expect(() => cashAttribution('ar_magic')).toThrow(BasReportError);
    expect(() => cashAttribution('constructor')).toThrow(BasReportError);
  });

  it('documents are invoices, credit notes, write-offs and bills; settlements are consideration', () => {
    const of = (k: string) =>
      Object.keys(CASH_ATTRIBUTION).filter((s) => CASH_ATTRIBUTION[s] === k);
    expect(of('document').sort()).toEqual([
      'ap_bill',
      'ar_credit_note',
      'ar_invoice',
      'ar_write_off',
    ]);
    expect(of('settlement').sort()).toEqual([
      'ap_payment',
      'ar_prepayment_application',
      'ar_receipt',
      'ar_refund',
      'payments_stripe_charge',
    ]);
  });
});

describe('line contributions (DL-0277)', () => {
  it('flow: revenue and liability are sales; asset, expense and equity purchases', () => {
    expect(
      ['revenue', 'liability', 'asset', 'expense', 'equity'].map((t) => flowOf(t as never)),
    ).toEqual(['sales', 'sales', 'purchases', 'purchases', 'purchases']);
  });

  it('a GST sale adds gross to G1 and GST to 1A; the debit side subtracts (credit note)', () => {
    expect(contrib(line({ credit: '1000.0000', taxAmount: '100.0000' }))).toEqual({
      G1: '1100',
      '1A': '100',
    });
    expect(contrib(line({ debit: '200.0000', taxAmount: '20.0000' }))).toEqual({
      G1: '-220',
      '1A': '-20',
    });
  });

  it('purchases: GST → G11 and 1B, CAP → G10 and 1B; a supplier credit subtracts', () => {
    expect(contrib(line({ accountType: 'expense', debit: '500', taxAmount: '50' }))).toEqual({
      G11: '550',
      '1B': '50',
    });
    expect(
      contrib(line({ accountType: 'asset', debit: '2000', taxCode: 'CAP', taxAmount: '200' })),
    ).toEqual({ G10: '2200', '1B': '200' });
    expect(contrib(line({ accountType: 'expense', credit: '500', taxAmount: '50' }))).toEqual({
      G11: '-550',
      '1B': '-50',
    });
  });

  it('GST-free and export sales add to G1 and G3 / G2; input-taxed to G1; N-T to nothing', () => {
    expect(contrib(line({ credit: '300', taxCode: 'FRE', taxAmount: '0' }))).toEqual({
      G1: '300',
      G3: '300',
    });
    expect(contrib(line({ credit: '300', taxCode: 'EXP' }))).toEqual({ G1: '300', G2: '300' });
    expect(contrib(line({ credit: '300', taxCode: 'INP' }))).toEqual({ G1: '300' });
    expect(contrib(line({ credit: '300', taxCode: 'N-T' }))).toEqual({});
  });

  it('ADJ-BD is 1B on accruals only (any account); W1/W2 are the plain amounts', () => {
    const adj = line({
      accountType: 'expense',
      debit: '1250',
      taxCode: 'ADJ-BD',
      taxAmount: '125',
    });
    expect(contrib(adj, 'accruals')).toEqual({ '1B': '125' });
    expect(contrib(adj, 'cash')).toEqual({});
    expect(contrib(line({ accountType: 'expense', debit: '10000', taxCode: 'BAS-W1' }))).toEqual({
      W1: '10000',
    });
    expect(contrib(line({ accountType: 'liability', credit: '2000', taxCode: 'BAS-W2' }))).toEqual({
      W2: '2000',
    });
  });

  it('only the map version valid on the entry date applies', () => {
    const map: BasLabelMapRow[] = [
      {
        ...(MAP.find((m) => m.taxCode === 'INP' && m.flow === 'sales') as BasLabelMapRow),
        validTo: '2029-12-31',
      },
      {
        taxCode: 'INP',
        flow: 'sales',
        label: 'G3',
        amount: 'gross',
        positiveSide: 'credit',
        basis: 'both',
        validFrom: '2030-01-01',
        validTo: null,
      },
    ];
    const at = (d: string) => [
      ...lineContributions(
        line({ credit: '10', taxCode: 'INP', entryDate: d }),
        map,
        'cash',
      ).keys(),
    ];
    expect(at('2029-12-31')).toEqual(['G1']);
    expect(at('2030-01-01')).toEqual(['G3']);
  });
});

describe('computeBas', () => {
  it('rounds a document’s settled share half-up to cents per label', () => {
    const r = computeBas({
      basis: 'cash',
      format: 'full',
      map: MAP,
      lines: [],
      documents: [
        {
          share: { entryId: 'e1', released: '1.0000', original: '3.0000' },
          lines: [line({ credit: '100.0000', taxAmount: '10.0000' })],
        },
      ],
    });
    // 110 / 3 = 36.666… → 36.67; 10 / 3 = 3.333… → 3.33
    expect([r.G1, r['1A']]).toEqual(['36.67', '3.33']);
  });

  it('an allocation reversal (negative release) reverses the share', () => {
    const r = computeBas({
      basis: 'cash',
      format: 'simpler',
      map: MAP,
      lines: [],
      documents: [
        {
          share: { entryId: 'e1', released: '-1375.0000', original: '1375.0000' },
          lines: [line({ credit: '1250.0000', taxAmount: '125.0000' })],
        },
      ],
    });
    expect(r).toEqual({ G1: '-1375.00', '1A': '-125.00', '1B': '0.00' });
  });

  it('refuses a document without an open-item amount', () => {
    expect(() =>
      computeBas({
        basis: 'cash',
        format: 'full',
        map: MAP,
        lines: [],
        documents: [{ share: { entryId: 'e9', released: '1', original: '0' }, lines: [] }],
      }),
    ).toThrow(/document e9 has no open-item amount/);
  });

  it('zero is reported as 0.00, never -0.00', () => {
    const r = computeBas({
      basis: 'accruals',
      format: 'simpler',
      map: MAP,
      lines: [line({ credit: '10', taxAmount: '1' }), line({ debit: '10', taxAmount: '1' })],
    });
    expect(r).toEqual({ G1: '0.00', '1A': '0.00', '1B': '0.00' });
  });
});
