import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SCALES } from '../time/scale.ts';
import { Lane } from './Lane.tsx';
import type { TimelineLane } from './types.ts';

const range = { from: '2026-10-01', to: '2026-11-09' };

const decisions: TimelineLane = {
  id: 'decisions',
  name: 'Decisions',
  sub: 'placed on the day they block',
  items: [
    { id: 'cn', date: '2026-10-24', label: 'Credit note', amount: '660.00', state: 'expected', now: true },
    { id: 'pb', date: '2026-10-24', label: 'Release suppliers', amount: '22415.00', state: 'expected', now: true },
    { id: 'mj', date: '2026-10-24', label: 'Wages journal', amount: '14880.00', state: 'expected', now: true },
    { id: 'tch', date: '2026-11-03', label: 'Bill TCH-88213', amount: '3190.00', state: 'expected' },
  ],
};

describe('SS-PLAT-29 <Lane> (RQ-0021 layout, P15)', () => {
  it('draws each item on its row at its date, as a labelled list', () => {
    render(<Lane lane={decisions} scale={SCALES['5w']} range={range} />);
    const list = screen.getByRole('list', { name: 'Decisions' });
    const items = within(list).getAllByRole('listitem');
    // three on one day, cap 2: two placed + one hidden; TCH placed
    expect(items.map((i) => [i.getAttribute('data-id'), i.getAttribute('data-row')])).toEqual([
      ['cn', '0'],
      ['mj', '1'],
      ['tch', '0'],
    ]);
    expect(items[0]?.style.getPropertyValue('--x')).toBe('57.5%');
    expect(items[2]?.style.getPropertyValue('--x')).toBe('82.5%');
  });

  it('labels every expected item as expected, in words and with data-series', () => {
    render(<Lane lane={decisions} scale={SCALES['5w']} range={range} />);
    for (const li of screen.getAllByRole('listitem')) {
      expect(li.getAttribute('data-series')).toBe('expected');
      expect(li.textContent).toMatch(/expected/i);
    }
  });

  it('puts what does not fit behind "+n more", which says it hides a due-now item and reveals it', async () => {
    const user = userEvent.setup();
    render(<Lane lane={decisions} scale={SCALES['5w']} range={range} />);
    const more = screen.getByRole('button', { name: /\+1 more/ });
    expect(more.getAttribute('aria-label')).toMatch(/including 1 due now/);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Release suppliers')).toBeNull();
    await user.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Release suppliers')).toBeTruthy();
  });

  it('marks overdue spans and says they are not counted', () => {
    render(
      <Lane
        lane={{
          id: 'customers',
          name: 'Customers pay you',
          items: [
            { id: 'od', date: '2026-10-01', end: '2026-10-23', label: 'Overdue', amount: '33482.50', state: 'overdue', sub: '8 invoices' },
          ],
        }}
        scale={SCALES['5w']}
        range={range}
      />,
    );
    const li = screen.getByRole('listitem');
    expect(li.getAttribute('data-series')).toBe('overdue');
    expect(li.textContent).toMatch(/not counted/i);
    expect(li.style.getPropertyValue('--w')).toBe('57.5%');
  });
});
