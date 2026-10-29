/**
 * SS-PLAT-92 (unit) — the API budget share as exact basis points and the gate honouring a
 * per-connection share (T-0071, design §5.6 rule 3, migration 0030). No floats in the compare.
 */
import { describe, expect, it } from 'vitest';
import { ApiUsageGate, shareBasisPoints } from './collections.ts';

const URL = 'https://acme.my.salesforce.com';

describe('SS-PLAT-92 API budget share', () => {
  it('SS-PLAT-92 shares are basis points in 1..10 000 with at most four decimals', () => {
    expect(shareBasisPoints('0.2500')).toBe(2500);
    expect(shareBasisPoints('0.25')).toBe(2500);
    expect(shareBasisPoints('0.0001')).toBe(1);
    expect(shareBasisPoints('1')).toBe(10_000);
    expect(shareBasisPoints('1.0000')).toBe(10_000);
    for (const bad of ['0', '0.0000', '1.0001', '1.5', '2', '-0.1', '0.12345', '.5', 'abc', '']) {
      expect(() => shareBasisPoints(bad), bad).toThrow(RangeError);
    }
  });

  it('SS-PLAT-92 the gate refuses exactly at the configured share, not before', () => {
    const gate = new ApiUsageGate({ now: () => new Date('2026-10-26T00:00:00Z') });
    gate.observe(URL, 'api-usage=9999/100000');
    expect(() => gate.assertWithinBudget(URL, '0.1000')).not.toThrow();
    gate.observe(URL, 'api-usage=10000/100000');
    expect(() => gate.assertWithinBudget(URL, '0.1000')).toThrow(/10 % share/);
    // The default (25 %) still allows it; the configured share wins when given.
    expect(() => gate.assertWithinBudget(URL)).not.toThrow();
    expect(() => gate.assertWithinBudget(URL, '0.2500')).not.toThrow();
    // Large allocations stay exact (no float rounding at the boundary).
    gate.observe(URL, 'api-usage=1666666/6666666');
    expect(() => gate.assertWithinBudget(URL, '0.2500')).not.toThrow();
    gate.observe(URL, 'api-usage=1666667/6666666');
    expect(() => gate.assertWithinBudget(URL, '0.2500')).toThrow();
  });
});
