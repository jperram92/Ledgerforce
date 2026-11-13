import { describe, expect, it } from 'vitest';
import {
  abaFileName,
  accountLabel,
  bankFileRefusalWords,
  exclusionText,
  refusalWords,
  releaseOutlook,
  releaseProgress,
} from './payments-logic.ts';
import { AdminApiError } from '../admin/client.ts';

const ME = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

describe('payments logic [T-0087]', () => {
  it('labels an account by its last 3 characters only, whatever arrives', () => {
    expect(accountLabel({ bsb: '062-000', account_number: '***321' })).toBe(
      'BSB 062-000, account ending 321',
    );
    expect(accountLabel({ bsb: '062-000', account_number: '123456789' })).toBe(
      'BSB 062-000, account ending 789',
    );
  });

  it('explains each exclusion reason in plain words, with the payable-from time', () => {
    expect(exclusionText('BANK_DETAILS_COOLING_OFF', '2026-11-21T00:00:00.000Z', 'UTC')).toBe(
      'Bank details changed recently. They can be paid from 21 Nov 2026, 12:00 am, in a later batch.',
    );
    expect(exclusionText('NO_VERIFIED_BANK_DETAILS', null)).toBe(
      'No verified bank details. Ask for them and have someone else verify them first.',
    );
  });

  it('says why the caller cannot release before they try (creator, second release, done)', () => {
    const base = { status: 'draft' as const, created_by: OTHER, releases: [] };
    expect(releaseOutlook(base, ME)).toEqual({ allowed: true, why: null });
    expect(releaseOutlook({ ...base, created_by: ME }, ME)).toEqual({
      allowed: false,
      why: 'SOD_BATCH_SELF_RELEASE',
    });
    expect(
      releaseOutlook(
        {
          ...base,
          status: 'partially_released',
          releases: [{ released_by: ME }],
        },
        ME,
      ),
    ).toEqual({ allowed: false, why: 'SOD_BATCH_SAME_RELEASER' });
    expect(releaseOutlook({ ...base, status: 'released' }, ME)).toEqual({
      allowed: false,
      why: 'done',
    });
  });

  it('counts releases as words', () => {
    expect(releaseProgress({ releases_required: 2, releases: [{}] })).toBe('1 of 2 releases given');
    expect(releaseProgress({ releases_required: 1, releases: [] })).toBe('0 of 1 release given');
  });

  it('turns SoD and step-up refusals into plain words', () => {
    expect(
      refusalWords(
        new AdminApiError(403, { error: 'sod_violation', rule: 'SOD_BATCH_SELF_RELEASE' }),
      ),
    ).toMatch(/^You created this batch\./);
    expect(
      refusalWords(
        new AdminApiError(403, { error: 'sod_violation', rule: 'SOD_BANK_DETAIL_SELF_VERIFY' }),
      ),
    ).toMatch(/^You asked for this change\./);
    expect(
      refusalWords(new AdminApiError(422, { error: 'NOT_RELEASABLE', message: 'not draft' })),
    ).toBe('LedgerForce did not accept this: not draft');
    expect(refusalWords(new AdminApiError(403, { error: 'forbidden' }))).toMatch(/permission/);
  });
});

describe('bank file words [T-0154]', () => {
  it('takes the file name from the attachment header, and only a safe one', () => {
    expect(abaFileName('attachment; filename="PB-0012-20261120.aba"', 'PB-0012')).toBe(
      'PB-0012-20261120.aba',
    );
    expect(abaFileName('attachment; filename="../../x.aba"', 'PB-0012')).toBe('PB-0012.aba');
    expect(abaFileName('attachment; filename="pay.exe"', 'PB-0012')).toBe('PB-0012.aba');
    expect(abaFileName(null, 'PB 12/A')).toBe('PB_12_A.aba');
  });

  it('explains each bank-file refusal in plain words', () => {
    expect(
      bankFileRefusalWords(
        new AdminApiError(422, { error: 'BANK_NOT_CONFIGURED', message: 'no active bank account' }),
      ),
    ).toMatch(/^Set up the paying bank account for bank files/);
    expect(
      bankFileRefusalWords(
        new AdminApiError(422, { error: 'NOT_RELEASED', message: 'payment batch PB-1 is draft' }),
      ),
    ).toMatch(/^The batch is not released yet/);
    expect(
      bankFileRefusalWords(
        new AdminApiError(422, { error: 'INVALID_ABA_DATA', message: 'BSB 06-000 is not valid' }),
      ),
    ).toBe(
      'The bank file could not be written from the details on file: BSB 06-000 is not valid. Fix them, then try again.',
    );
    expect(bankFileRefusalWords(new AdminApiError(503, { error: 'kms_not_configured' }))).toMatch(
      /cannot open the sealed account numbers right now/,
    );
    expect(
      bankFileRefusalWords(
        new AdminApiError(403, { error: 'sod_violation', rule: 'SOD_BATCH_SELF_RELEASE' }),
      ),
    ).toMatch(/^You created this batch\./);
    expect(bankFileRefusalWords(new Error('offline'))).toMatch(/did not answer/);
  });
});
