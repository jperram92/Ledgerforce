/**
 * Auto-approval decision (UC-01 main flow 6 / A6; T-0069). Pure: settings + gross → approve or
 * keep as a draft, with the reason. The database half (no journal written) is in
 * packages/connectors/salesforce/src/billing/closed-won.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { autoApproveDecision } from './invoices.ts';

describe('SS-UC01-04: Above threshold stays Draft', () => {
  it('SS-UC01-04 a $1,375.00 invoice with threshold $1,000.00 stays a draft (ABOVE_THRESHOLD)', () => {
    expect(
      autoApproveDecision(
        { autoApprove: true, autoApproveThreshold: '1000.0000' },
        { gross: '1375.0000', warnings: 0 },
      ),
    ).toEqual({ approve: false, reason: 'ABOVE_THRESHOLD' });
  });

  it('SS-UC01-04 the threshold itself is within (≤), one cent above is not', () => {
    const on = { autoApprove: true, autoApproveThreshold: '1375.00' };
    expect(autoApproveDecision(on, { gross: '1375.0000', warnings: 0 })).toEqual({
      approve: true,
    });
    expect(autoApproveDecision(on, { gross: '1375.0100', warnings: 0 })).toEqual({
      approve: false,
      reason: 'ABOVE_THRESHOLD',
    });
  });

  it('SS-UC01-04 auto-approve off, no threshold, no settings or open warnings keep the draft', () => {
    const g = { gross: '10.00', warnings: 0 };
    expect(autoApproveDecision({ autoApprove: false, autoApproveThreshold: '2000' }, g)).toEqual({
      approve: false,
      reason: 'OFF',
    });
    expect(autoApproveDecision({ autoApprove: true, autoApproveThreshold: null }, g)).toEqual({
      approve: false,
      reason: 'NO_THRESHOLD',
    });
    expect(autoApproveDecision(undefined, g)).toEqual({ approve: false, reason: 'OFF' });
    expect(
      autoApproveDecision(
        { autoApprove: true, autoApproveThreshold: '2000' },
        { gross: null, warnings: 1 },
      ),
    ).toEqual({ approve: false, reason: 'WARNINGS' });
  });

  it('compares exact decimals, never floats (0.1 + 0.2 style sums)', () => {
    expect(
      autoApproveDecision(
        { autoApprove: true, autoApproveThreshold: '0.3' },
        { gross: '0.3000', warnings: 0 },
      ),
    ).toEqual({ approve: true });
  });
});
