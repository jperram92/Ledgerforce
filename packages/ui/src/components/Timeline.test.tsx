import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HARBOUR_LAST_STATEMENT,
  HARBOUR_TODAY,
  harbourCash,
  harbourLanes,
} from '../fixtures/harbour.ts';
import { Timeline } from './Timeline.tsx';

function renderHarbour() {
  return render(
    <Timeline
      label="Your money"
      today={HARBOUR_TODAY}
      lastStatement={HARBOUR_LAST_STATEMENT}
      cash={harbourCash}
      cashScale={{ min: '100000', max: '215000' }}
      lanes={harbourLanes}
      leavesOut="Overdue invoices (33,482.50) are not counted in the expected balance."
    />,
  );
}

describe('SS-PLAT-29 <Timeline> (axis, scales, lanes, legend)', () => {
  it('keeps the lane order from the prototype (P14 contract)', () => {
    const { container } = renderHarbour();
    const ids = [...container.querySelectorAll('[data-lane]')].map((l) =>
      l.getAttribute('data-lane'),
    );
    expect(ids).toEqual(['cash', 'customers', 'pay', 'tax', 'decisions', 'books', 'salesforce']);
  });

  it('starts on 5 weeks: 1 Oct to 9 Nov, Mondays on the axis, today marked', () => {
    const { container } = renderHarbour();
    const group = screen.getByRole('group', { name: 'Time span' });
    const pressed = within(group)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.textContent)).toEqual(['5 weeks']);
    const ticks = [...container.querySelectorAll('.axis .tick')].map((t) => t.textContent);
    expect(ticks).toEqual(['Mon 5 Oct', 'Mon 12', 'Mon 19', 'Mon 26', 'Mon 2 Nov']);
    expect(container.querySelector('.axis .today')?.textContent).toBe('Today, Sat 24 Oct');
  });

  it('switches to Quarter: weekly buckets, actual and expected kept apart', async () => {
    const user = userEvent.setup();
    const { container } = renderHarbour();
    await user.click(screen.getByRole('button', { name: 'Quarter' }));
    expect(screen.getByRole('button', { name: 'Quarter' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const ticks = [...container.querySelectorAll('.axis .tick')].map((t) => t.textContent);
    expect(ticks[0]).toMatch(/^w\/c /);
    const customers = screen.getByRole('list', { name: 'Customers pay you' });
    const w44 = within(customers)
      .getAllByRole('listitem')
      .filter((li) => li.getAttribute('data-bucket') === '2026-W44');
    expect(w44).toHaveLength(1);
    expect(w44[0]?.getAttribute('data-series')).toBe('expected');
    expect(w44[0]?.querySelector('[data-amount]')?.getAttribute('data-amount')).toBe('33740.00');
    expect(w44[0]?.textContent).toMatch(/2 items/);
    const w43 = within(customers)
      .getAllByRole('listitem')
      .filter((li) => li.getAttribute('data-bucket') === '2026-W43');
    expect(w43.map((li) => li.getAttribute('data-series'))).toEqual(['actual']);
  });

  it('switches to Year: monthly buckets', async () => {
    const user = userEvent.setup();
    const { container } = renderHarbour();
    await user.click(screen.getByRole('button', { name: 'Year' }));
    const ticks = [...container.querySelectorAll('.axis .tick')].map((t) => t.textContent);
    expect(ticks).toContain('Oct');
    expect(ticks).toContain('Nov');
    const pay = screen.getByRole('list', { name: 'You pay' });
    const oct = within(pay)
      .getAllByRole('listitem')
      .filter((li) => li.getAttribute('data-bucket') === '2026-10')
      .map((li) => [
        li.getAttribute('data-series'),
        li.querySelector('[data-amount]')?.getAttribute('data-amount'),
      ]);
    expect(oct).toEqual([
      ['actual', '-38214.60'],
      ['expected', '-60629.60'],
    ]);
  });

  it('has a legend that names happened, expected, today and overdue', () => {
    renderHarbour();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(legend.textContent).toContain('Happened');
    expect(legend.textContent).toContain('Expected');
    expect(legend.textContent).toContain('Today');
    expect(legend.textContent).toContain('Overdue, not counted');
  });
});
