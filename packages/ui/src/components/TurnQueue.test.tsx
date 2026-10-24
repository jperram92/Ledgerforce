import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TurnQueue, type OpenItem } from './TurnQueue.tsx';

const items: OpenItem[] = [
  {
    id: 'pb',
    what: 'Release supplier run PB-0087, second of two',
    why: 'Lena made it, Mei released it first.',
    amount: '22415.00',
    turn: { kind: 'you' },
    due: { date: '2026-10-27', note: 'by 5 pm' },
  },
  {
    id: 'mj',
    what: 'Journal MJ-0412, October wages owed',
    why: "Priya's accrual.",
    amount: '14880.00',
    turn: { kind: 'person', name: 'Mei' },
    due: { date: '2026-10-31', note: 'month end' },
  },
  {
    id: 'sf',
    what: 'Salesforce: 3 updates need a person',
    why: '2 more are retrying on their own.',
    turn: { kind: 'system', name: 'Salesforce sync' },
    due: { date: '2026-10-24' },
  },
  {
    id: 'inv',
    what: 'INV-001061 payment',
    why: 'Saltbush Health pays by the due date.',
    amount: '10087.00',
    turn: { kind: 'customer', name: 'Saltbush Health' },
    due: { date: '2026-11-05' },
  },
];

describe('SS-PLAT-29 <TurnQueue> (P13 whose turn, P10 keyboard)', () => {
  it('names who acts next and the date it blocks, on every open item', () => {
    render(
      <TurnQueue label="Decisions" items={items} today="2026-10-24" onOpen={() => undefined} />,
    );
    const list = screen.getByRole('list', { name: 'Decisions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.hasAttribute('data-open-item')).toBe(true);
      expect(r.getAttribute('data-turn')).toMatch(/^(you|person|customer|system)$/);
      expect(r.getAttribute('data-due')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(rows[0]?.textContent).toContain('Your turn');
    expect(rows[1]?.textContent).toContain("Mei's turn");
    expect(rows[2]?.textContent).toContain('Salesforce sync');
    expect(rows[3]?.textContent).toContain('Saltbush Health');
    expect(rows[0]?.textContent).toContain('Tue 27 Oct');
    expect(rows[2]?.textContent).toContain('Today');
  });

  it('refuses an open item without a turn or a due date (P13)', () => {
    const bad = { ...(items[0] as OpenItem), turn: undefined } as unknown as OpenItem;
    expect(() =>
      render(<TurnQueue label="Q" items={[bad]} today="2026-10-24" onOpen={() => undefined} />),
    ).toThrow(/turn/i);
    const noDue = { ...(items[0] as OpenItem), due: undefined } as unknown as OpenItem;
    expect(() =>
      render(<TurnQueue label="Q" items={[noDue]} today="2026-10-24" onOpen={() => undefined} />),
    ).toThrow(/due/i);
  });

  it('moves with J/K and the arrow keys, jumps with Home/End, and opens with Enter', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<TurnQueue label="Decisions" items={items} today="2026-10-24" onOpen={onOpen} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
    // roving tabindex: only one item is in the tab order
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);
    await user.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(buttons[2]);
    await user.keyboard('k');
    expect(document.activeElement).toBe(buttons[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[3]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(buttons[3]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('j{Enter}');
    expect(onOpen).toHaveBeenCalledWith('mj');
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it('shows the keyboard hints', () => {
    render(
      <TurnQueue label="Decisions" items={items} today="2026-10-24" onOpen={() => undefined} />,
    );
    expect(
      screen.getByText(/move/).closest('p')?.querySelectorAll('kbd').length,
    ).toBeGreaterThanOrEqual(3);
  });
});
