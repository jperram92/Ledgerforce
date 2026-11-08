/**
 * Suggested coding for a supplier bill line (T-0050, UC-05 step 2, RQ-0106 F2, DL-0291).
 * Pure: the history and the product-profile result are inputs; the decision is deterministic.
 * (The card names this file coding.suggest.spec.ts; the unit project collects *.test.ts.)
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HISTORY_WINDOW, suggestCoding, type CodingHistoryLine } from './coding.suggest.ts';

const OFFICE = 'acct-6150-office-expenses';
const COMPUTERS = 'acct-1520-computer-equipment';
const TRAVEL = 'acct-6300-travel';

let seq = 0;
function bill(
  billNo: string,
  billDate: string,
  lines: { accountId: string; taxCode: string; productId?: string | null }[],
): CodingHistoryLine[] {
  seq += 1;
  return lines.map((l, i) => ({
    billId: `bill-${String(seq)}`,
    billNo,
    billDate,
    lineNo: i + 1,
    productId: l.productId ?? null,
    accountId: l.accountId,
    taxCode: l.taxCode,
  }));
}

describe('suggestCoding', () => {
  it('SS-UC05-02: Suggested coding from past bills — last 3 bills Office expenses / GST → Office expenses with GST', () => {
    const history = [
      ...bill('BILL-000040', '2026-08-03', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000041', '2026-09-03', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000042', '2026-10-03', [{ accountId: OFFICE, taxCode: 'GST' }]),
    ];
    expect(suggestCoding({ history })).toEqual({
      accountId: OFFICE,
      taxCode: 'GST',
      source: 'supplier_history',
      basis: '3 of 3 lines on the last 3 posted bills',
    });
  });

  it('the most frequent pair wins over a more recent one', () => {
    const history = [
      ...bill('BILL-000001', '2026-08-01', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000002', '2026-08-02', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000003', '2026-08-03', [{ accountId: TRAVEL, taxCode: 'GST' }]),
    ];
    expect(suggestCoding({ history })?.accountId).toBe(OFFICE);
  });

  it('a tie goes to the most recently used pair', () => {
    const history = [
      ...bill('BILL-000001', '2026-08-01', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000002', '2026-08-02', [{ accountId: TRAVEL, taxCode: 'GST' }]),
    ];
    expect(suggestCoding({ history })).toMatchObject({ accountId: TRAVEL, taxCode: 'GST' });
  });

  it('on the same date the higher bill number is the more recent', () => {
    const history = [
      ...bill('BILL-000009', '2026-08-01', [{ accountId: OFFICE, taxCode: 'GST' }]),
      ...bill('BILL-000010', '2026-08-01', [{ accountId: TRAVEL, taxCode: 'GST' }]),
    ];
    expect(suggestCoding({ history })?.accountId).toBe(TRAVEL);
  });

  it(`only the last ${String(HISTORY_WINDOW)} bills count`, () => {
    const old = Array.from({ length: 4 }, (_, i) =>
      bill(`BILL-00000${String(i + 1)}`, `2026-07-0${String(i + 1)}`, [
        { accountId: TRAVEL, taxCode: 'GST' },
        { accountId: TRAVEL, taxCode: 'GST' },
      ]),
    ).flat();
    const recent = Array.from({ length: HISTORY_WINDOW }, (_, i) =>
      bill(`BILL-0001${String(i).padStart(2, '0')}`, `2026-10-${String(i + 10)}`, [
        { accountId: OFFICE, taxCode: 'GST' },
      ]),
    ).flat();
    expect(suggestCoding({ history: [...old, ...recent] })?.accountId).toBe(OFFICE);
  });

  it('a line with a product uses only history lines of that product', () => {
    const history = bill('BILL-000001', '2026-08-01', [
      { accountId: OFFICE, taxCode: 'GST', productId: 'paper' },
      { accountId: OFFICE, taxCode: 'GST', productId: 'paper' },
      { accountId: COMPUTERS, taxCode: 'CAP', productId: 'laptop' },
    ]);
    expect(suggestCoding({ history, productId: 'laptop' })).toMatchObject({
      accountId: COMPUTERS,
      taxCode: 'CAP',
      source: 'supplier_history',
    });
  });

  it('without history the product profile is suggested', () => {
    expect(
      suggestCoding({
        history: [],
        productId: 'laptop',
        profile: { accountId: COMPUTERS, taxCode: 'CAP', basis: 'product profile IT_HARDWARE' },
      }),
    ).toEqual({
      accountId: COMPUTERS,
      taxCode: 'CAP',
      source: 'product_profile',
      basis: 'product profile IT_HARDWARE',
    });
  });

  it('a profile with a tax-code conflict suggests the account and no tax code (DL-0260)', () => {
    expect(
      suggestCoding({
        history: [],
        profile: { accountId: OFFICE, taxCode: null, basis: 'TAX_CODE_CONFLICT' },
      }),
    ).toMatchObject({ accountId: OFFICE, taxCode: null, source: 'product_profile' });
  });

  it('history wins over the product profile', () => {
    const history = bill('BILL-000001', '2026-08-01', [{ accountId: TRAVEL, taxCode: 'GST' }]);
    expect(
      suggestCoding({ history, profile: { accountId: OFFICE, taxCode: 'GST', basis: 'p' } })
        ?.source,
    ).toBe('supplier_history');
  });

  it('nothing to go on → null', () => {
    expect(suggestCoding({ history: [] })).toBeNull();
  });

  it('is deterministic: the order of the history does not change the suggestion', () => {
    const accounts = [OFFICE, TRAVEL, COMPUTERS];
    const codes = ['GST', 'CAP', 'FRE'];
    const line = fc.record({
      bill: fc.integer({ min: 1, max: 12 }),
      account: fc.constantFrom(...accounts),
      code: fc.constantFrom(...codes),
    });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 30 }), fc.nat(), (raw, seed) => {
        const history: CodingHistoryLine[] = raw.map((r, i) => ({
          billId: `b${String(r.bill)}`,
          billNo: `BILL-${String(r.bill).padStart(6, '0')}`,
          billDate: `2026-08-${String(r.bill).padStart(2, '0')}`,
          lineNo: i + 1,
          productId: null,
          accountId: r.account,
          taxCode: r.code,
        }));
        const shuffled = [...history].sort(
          (a, b) => ((a.lineNo * 7919 + seed) % 101) - ((b.lineNo * 7919 + seed) % 101),
        );
        expect(suggestCoding({ history: shuffled })).toEqual(suggestCoding({ history }));
      }),
    );
  });
});
