/** Close checklist logic (T-0090): step states, default period, list window. */
import { describe, expect, it } from 'vitest';
import type { ChecklistStep, Period } from './client.ts';
import { defaultPeriod, periodWindow, stepStates } from './close-logic.ts';

const step = (s: ChecklistStep['step'], by: string | null): ChecklistStep => ({
  step: s,
  completed_by: by,
  completed_by_name: by,
  completed_at: by ? '2026-11-03T00:00:00.000Z' : null,
  period_status: null,
});
const period = (id: string, status: Period['status']): Period => ({
  id,
  name: id,
  start_date: '2026-01-01',
  end_date: '2026-01-31',
  status,
});

describe('T-0090 close logic', () => {
  it('marks done steps, the first undone step as next, and the rest waiting', () => {
    expect(
      stepStates([
        step('ar_lock', 'u'),
        step('ap_lock', 'u'),
        step('bank_recs', null),
        step('accruals', null),
      ]),
    ).toEqual(['done', 'done', 'next', 'waiting']);
    expect(stepStates([step('ar_lock', 'u')])).toEqual(['done']);
  });

  it('defaults to the latest period that is not hard-locked, else the latest', () => {
    expect(
      defaultPeriod([
        period('sep', 'hard_locked'),
        period('oct', 'ap_locked'),
        period('nov', 'open'),
      ])?.id,
    ).toBe('nov');
    expect(defaultPeriod([period('sep', 'hard_locked'), period('oct', 'hard_locked')])?.id).toBe(
      'oct',
    );
    expect(defaultPeriod([])).toBeUndefined();
  });

  it('lists periods from 12 months back to the start of the month after next', () => {
    expect(periodWindow('2026-11-13')).toEqual({ from: '2025-11-01', to: '2027-01-01' });
    expect(periodWindow('2026-01-31')).toEqual({ from: '2025-01-01', to: '2026-03-01' });
  });
});
