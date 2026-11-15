/**
 * Posting-profile matrix wording (T-0188, SS-PLAT-134): the gap summary, each cell's state in
 * words, which account field a gap's override sets, and refusals in plain words. The API resolves
 * every cell (ADR-0082); this only words what it answers.
 */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { STEP_WHERE } from './wizard-logic.ts';
import { cellWord, fillField, fillRefusal, gapSummary } from './profiles-logic.ts';

const cell = (over: Record<string, unknown> = {}) => ({
  party_profile_id: 'p',
  product_profile_id: 'q',
  purpose: 'sale' as const,
  account: { id: 'a', code: '4110', name: 'Professional services' },
  account_source: 'product' as const,
  tax_code: 'GST',
  tax_code_source: 'product' as const,
  override: false,
  gap: null,
  ...over,
});

describe('posting-profile matrix wording [T-0188]', () => {
  it('summarises the gaps in words', () => {
    expect(gapSummary(0)).toBe('No gaps: every combination has an account and a tax code.');
    expect(gapSummary(1)).toBe('1 gap: a document that needs it cannot post.');
    expect(gapSummary(3)).toBe('3 gaps: a document that needs one of them cannot post.');
  });

  it('says whether a cell uses the default, an override, or is a gap', () => {
    expect(cellWord(cell())).toBe('Default');
    expect(cellWord(cell({ account_source: 'override', override: true }))).toBe('Override');
    expect(
      cellWord(
        cell({ account: null, account_source: null, gap: { reason: 'account', message: 'x' } }),
      ),
    ).toBe('Gap');
  });

  it('a sale gap sets the income account, a purchase gap the expense account, a tax gap the code', () => {
    expect(fillField(cell({ gap: { reason: 'account', message: 'x' } }))).toBe(
      'revenue_account_id',
    );
    expect(fillField(cell({ purpose: 'purchase', gap: { reason: 'account', message: 'x' } }))).toBe(
      'expense_account_id',
    );
    expect(fillField(cell({ gap: { reason: 'tax_code', message: 'x' } }))).toBe('tax_code');
    expect(fillField(cell({ gap: { reason: 'control', message: 'x' } }))).toBeNull();
    expect(fillField(cell())).toBeNull();
  });

  it('words a refusal of the override', () => {
    expect(
      fillRefusal(new AdminApiError(422, { error: 'PROFILE_ACCOUNT', message: 'not postable' })),
    ).toBe('LedgerForce did not accept this account: not postable.');
    expect(fillRefusal(new AdminApiError(404, { error: 'PROFILE_UNKNOWN', message: 'gone' }))).toBe(
      'LedgerForce did not accept this account: gone.',
    );
    expect(fillRefusal(new AdminApiError(403, { error: 'forbidden' }))).toBeNull();
  });

  it('wizard step 7 links to the matrix', () => {
    expect(STEP_WHERE[7]).toMatchObject({
      to: '/accounting/posting-profiles',
      name: 'Posting profiles',
    });
  });
});
