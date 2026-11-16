/** Setup wizard wording (T-0091): summary, step state words, refusals. */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import type { Wizard, WizardStep } from './client.ts';
import { openStep, refusalOf, stateText, STEP_WHERE, summary } from './wizard-logic.ts';

const step = (n: number, over: Partial<WizardStep> = {}): WizardStep => ({
  step: n,
  title: `Step title ${String(n)}`,
  status: 'not_started',
  locked: true,
  valid: true,
  missing: [],
  outcome: null,
  reason: null,
  completed_at: null,
  completed_by: null,
  ...over,
});
const wizard = (done: number): Wizard => ({
  company_id: 'c',
  as_of: '2026-11-15',
  complete: done === 10,
  steps: Array.from({ length: 10 }, (_, i) =>
    i < done
      ? step(i + 1, { status: 'complete', locked: false, completed_at: '2026-11-14T01:00:00Z' })
      : i === done
        ? step(i + 1, { status: 'in_progress', locked: false })
        : step(i + 1),
  ),
});

describe('T-0091 setup wizard logic', () => {
  it('summarises how far setup has got and names the open step', () => {
    expect(summary(wizard(0))).toBe('0 of 10 steps done. Now: step 1, Step title 1.');
    expect(summary(wizard(6))).toBe('6 of 10 steps done. Now: step 7, Step title 7.');
    expect(summary(wizard(10))).toBe('Setup is complete: all 10 steps are done.');
  });

  it('finds the open step, if any', () => {
    expect(openStep(wizard(3))?.step).toBe(4);
    expect(openStep(wizard(10))).toBeUndefined();
  });

  it('words each state plainly, including a no-history declaration and a locked step', () => {
    expect(stateText(step(2), 1)).toBe('Waits for step 1');
    expect(stateText(step(1, { status: 'in_progress', locked: false }), 1)).toBe('Open now');
    expect(stateText(step(1, { status: 'complete', locked: false }), 2)).toBe('Done');
    expect(
      stateText(step(9, { status: 'complete', outcome: 'no_history', reason: 'New company.' }), 10),
    ).toBe('Done: no history.');
  });

  it('says where every step is entered: an existing screen or plainly elsewhere', () => {
    expect(Object.keys(STEP_WHERE).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(STEP_WHERE[2]).toMatchObject({ to: '/accounting/chart', name: 'Chart of accounts' });
    expect(STEP_WHERE[10]).toMatchObject({ to: '/settings/users', name: 'People and roles' });
    // T-0176: steps 1 and 3 link to their settings screens; T-0185: step 4 to Bank accounts.
    expect(STEP_WHERE[1]).toMatchObject({ to: '/settings/company', name: 'Company details' });
    expect(STEP_WHERE[3]).toMatchObject({ to: '/settings/tax', name: 'Tax settings' });
    expect(STEP_WHERE[4]).toMatchObject({ to: '/settings/bank-accounts', name: 'Bank accounts' });
    expect(STEP_WHERE[4]?.text).not.toMatch(/no LedgerForce screen/);
    // T-0177: step 9 links to the opening balances screen.
    expect(STEP_WHERE[9]).toMatchObject({
      to: '/settings/setup/opening-balances',
      name: 'Opening balances',
    });
    // T-0186 (SS-PLAT-131): step 8 and step 10's approval amounts have their screens.
    expect(STEP_WHERE[8]).toMatchObject({
      to: '/settings/billing',
      name: 'Numbering and billing',
    });
    expect(STEP_WHERE[10]?.also).toMatchObject({
      to: '/settings/approvals',
      name: 'Approval amounts',
    });
    expect(STEP_WHERE[10]?.after).toBeUndefined();
  });

  it('turns the API refusals into plain words, keeping the missing list', () => {
    const invalid = refusalOf(
      new AdminApiError(422, {
        error: 'STEP_INVALID',
        message: 'step 1 (Company details) is not ready: The ABN is missing',
        missing: ['The ABN is missing'],
      }),
      1,
    );
    expect(invalid).toEqual({
      text: 'Step 1 is not ready. Still missing:',
      missing: ['The ABN is missing'],
    });
    expect(
      refusalOf(new AdminApiError(409, { error: 'STEP_LOCKED', message: 'x' }), 3)?.text,
    ).toMatch(/^An earlier step is not done yet/);
    expect(
      refusalOf(
        new AdminApiError(422, { error: 'NO_HISTORY_NOT_ALLOWED', message: 'an opening balance' }),
        9,
      ),
    ).toEqual({ text: 'Step 9 cannot be declared "no history": an opening balance.', missing: [] });
    expect(refusalOf(new AdminApiError(403, { error: 'forbidden' }), 1)).toBeNull();
    expect(refusalOf(new Error('offline'), 1)).toBeNull();
  });
});
