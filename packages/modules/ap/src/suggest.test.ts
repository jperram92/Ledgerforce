/** SS-UC05-02 — suggested coding from a supplier's past bills (T-0050, UC-05). */
import { describe, expect, it } from 'vitest';
import { suggestFromHistory } from './bills.ts';

describe('SS-UC05-02: Suggested coding from past bills', () => {
  it('SS-UC05-02 a supplier whose last 3 bills used Office expenses / GST is suggested Office expenses with GST', () => {
    const office = { accountId: 'acc-office', taxCode: 'GST' };
    expect(
      suggestFromHistory([
        { billDate: '2026-11-03', lines: [office] },
        { billDate: '2026-10-03', lines: [office] },
        { billDate: '2026-09-03', lines: [office] },
        { billDate: '2026-01-03', lines: [{ accountId: 'acc-rent', taxCode: 'GST' }] },
      ]),
    ).toEqual(office);
  });

  it('only the last 3 bills count; ties go to the most recent; no history → no suggestion', () => {
    const a = { accountId: 'a', taxCode: 'GST' };
    const b = { accountId: 'b', taxCode: 'GST-FREE' };
    expect(
      suggestFromHistory([
        { billDate: '2026-11-03', lines: [b] },
        { billDate: '2026-10-03', lines: [a] },
        { billDate: '2026-09-03', lines: [a, b] },
        { billDate: '2026-08-03', lines: [a, a, a] },
      ]),
    ).toEqual(b);
    expect(suggestFromHistory([])).toBeUndefined();
  });
});
