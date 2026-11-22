import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { explainFailure, noticeLabel, retryMessageFor } from './logic.ts';

describe('SS-PLAT-161 failed security notices: plain words', () => {
  it('SS-PLAT-161 names the change with the last 3 digits only [T-0209]', () => {
    expect(
      noticeLabel({
        kind: 'remittance_account_changed',
        context: 'Harbour & Co Pty Ltd',
        account_last3: '321',
      }),
    ).toBe('Remittance account of Harbour & Co Pty Ltd changed, new account ending in 321');
    expect(
      noticeLabel({
        kind: 'bank_details_changed',
        context: 'Office Supplies',
        account_last3: null,
      }),
    ).toBe('Bank details of Office Supplies changed');
  });

  it('SS-PLAT-161 explains SMTP failures without SMTP words [T-0209]', () => {
    expect(explainFailure({ last_smtp_code: 550, last_error_code: 'EENVELOPE' })).toMatch(
      /refused the email/,
    );
    expect(explainFailure({ last_smtp_code: 421, last_error_code: null })).toMatch(
      /try again later/,
    );
    expect(explainFailure({ last_smtp_code: 535, last_error_code: 'EAUTH' })).toMatch(/sign in/);
    expect(explainFailure({ last_smtp_code: null, last_error_code: 'ETIMEDOUT' })).toMatch(
      /could not reach/,
    );
    expect(explainFailure({ last_smtp_code: null, last_error_code: null })).toBe(
      'The email could not be sent.',
    );
  });

  it('SS-PLAT-161 a notice that is no longer failing is explained [T-0209]', () => {
    expect(
      retryMessageFor(new AdminApiError(409, { error: 'security_notice_not_failed' })),
    ).toMatch(/no longer failing/);
  });
});
