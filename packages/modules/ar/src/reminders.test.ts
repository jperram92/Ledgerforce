/**
 * Overdue reminder selection (T-0068, UC-04 MVP, DL-0402) — pure rules, no database.
 */
import { describe, expect, it } from 'vitest';
import { selectDueReminders, type ReminderCandidate } from './reminders.ts';

const STEP1 = [{ step: 1, daysOverdue: 7 }];
const item = (o: Partial<ReminderCandidate> = {}): ReminderCandidate => ({
  invoiceId: 'inv-1',
  partyId: 'party-1',
  dueDate: '2026-11-19',
  open: '1375.0000',
  ...o,
});

describe('SS-UC04-04: Paid invoice gets no reminder', () => {
  it('SS-UC04-04 an invoice paid on day 6 gets no reminder when the schedule runs on day 7', () => {
    // Paid in full on 2026-11-25 (day 6): nothing is open as at the run on 2026-11-26 (day 7).
    expect(
      selectDueReminders({
        runDate: '2026-11-26',
        steps: STEP1,
        items: [item({ open: '0.0000' })],
        sent: [],
      }),
    ).toEqual([]);
  });
});

describe('T-0068 reminder selection rules', () => {
  it('queues reminder 1 from exactly 7 days overdue, not before', () => {
    const run = (runDate: string) =>
      selectDueReminders({ runDate, steps: STEP1, items: [item()], sent: [] });
    expect(run('2026-11-25')).toEqual([]);
    expect(run('2026-11-26')).toEqual([
      { invoiceId: 'inv-1', partyId: 'party-1', step: 1, daysOverdue: 7 },
    ]);
  });

  it('a step already sent for the invoice is not queued again', () => {
    expect(
      selectDueReminders({
        runDate: '2026-11-27',
        steps: STEP1,
        items: [item()],
        sent: [{ invoiceId: 'inv-1', step: 1 }],
      }),
    ).toEqual([]);
  });

  it('credits and part-paid items: only a positive open amount is reminded', () => {
    const out = selectDueReminders({
      runDate: '2026-12-01',
      steps: STEP1,
      items: [
        item({ invoiceId: 'credit', open: '-50.0000' }),
        item({ invoiceId: 'part', open: '0.0100' }),
      ],
      sent: [],
    });
    expect(out.map((r) => r.invoiceId)).toEqual(['part']);
  });

  it('with several due steps only the latest unsent one is queued, and never a lower step after a higher one', () => {
    const steps = [
      { step: 1, daysOverdue: 7 },
      { step: 2, daysOverdue: 30 },
    ];
    // First run at 40 days overdue: one reminder (step 2), not two at once.
    expect(selectDueReminders({ runDate: '2026-12-29', steps, items: [item()], sent: [] })).toEqual(
      [{ invoiceId: 'inv-1', partyId: 'party-1', step: 2, daysOverdue: 40 }],
    );
    // Step 2 already sent: step 1 is not sent afterwards.
    expect(
      selectDueReminders({
        runDate: '2026-12-30',
        steps,
        items: [item()],
        sent: [{ invoiceId: 'inv-1', step: 2 }],
      }),
    ).toEqual([]);
  });

  it('rejects an impossible run date', () => {
    expect(() =>
      selectDueReminders({ runDate: '2026-02-30', steps: STEP1, items: [], sent: [] }),
    ).toThrow(RangeError);
  });
});
