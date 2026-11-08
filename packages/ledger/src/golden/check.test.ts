/**
 * Golden arithmetic self-check (T-0031): every golden journal's lines add up to its Total row
 * and the Total row balances — exact decimal (Money), never floating point.
 */
import { describe, expect, it } from 'vitest';
import { goldenArithmetic } from './check.ts';
import { parseGoldenPostings } from './parse.ts';

const gp = (l1: string, l2: string, total: string) => {
  const [p] = parseGoldenPostings(`## GP-960 — Check
- **Status: Draft** · Phase: MVP · Source type: \`ar.receipt\`

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | bank:OPERATING | 1100 | ${l1} | | — | — |
| 2 | system:AR_CONTROL | 1200 | | ${l2} | — | Acme |
| | **Total** | | **${total.split('/')[0] ?? ''}** | **${total.split('/')[1] ?? ''}** | | |
`);
  if (!p) throw new Error('no GP');
  return p;
};

describe('SS-PLAT-12 golden arithmetic', () => {
  it('accepts a journal whose lines sum to a balanced Total row', () => {
    expect(goldenArithmetic(gp('0.10', '0.10', '0.10/0.10'))).toEqual([]);
    expect(goldenArithmetic(gp('1,375.00', '1,375.00', '1,375.00/1,375.00'))).toEqual([]);
  });

  it('reports an unbalanced Total row and lines that do not sum to it', () => {
    expect(goldenArithmetic(gp('0.10', '0.20', '0.10/0.20'))).toEqual([
      'GP-960: Total row does not balance (debit 0.10, credit 0.20)',
    ]);
    expect(goldenArithmetic(gp('0.10', '0.10', '0.30/0.30'))).toEqual([
      'GP-960: lines sum to debit 0.1000 but the Total row says 0.30',
      'GP-960: lines sum to credit 0.1000 but the Total row says 0.30',
    ]);
  });
});
