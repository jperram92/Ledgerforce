import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Spine, type SpineEvent } from './Spine.tsx';

const events: SpineEvent[] = [
  { id: 'won', date: '2026-10-06', time: '8:47 am', title: 'Won in Salesforce', state: 'past' },
  { id: 'sf', date: '2026-10-06', time: '10:15 am', title: 'Salesforce update', state: 'warn', flag: 'Failed' },
  { id: 'now', date: '2026-10-24', title: 'Waiting for Saltbush to pay', state: 'now' },
  { id: 'due', date: '2026-11-05', time: 'due', title: 'Due date', state: 'future' },
];

describe('SS-PLAT-29 <Spine> (document life story, P5, P15)', () => {
  it('lists every event oldest first with a machine-readable date', () => {
    render(<Spine label="Life of INV-001061" events={events} today="2026-10-24" />);
    const list = screen.getByRole('list', { name: 'Life of INV-001061' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-state'))).toEqual(['past', 'warn', 'now', 'future']);
    expect(items[0]?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-06');
    expect(items[0]?.textContent).toContain('6 Oct');
  });

  it('marks today as the current step and labels the future as expected', () => {
    render(<Spine label="Life" events={events} today="2026-10-24" />);
    const items = screen.getAllByRole('listitem');
    expect(items[2]?.getAttribute('aria-current')).toBe('step');
    expect(items[2]?.textContent).toContain('Today');
    expect(items[3]?.getAttribute('data-series')).toBe('expected');
    expect(items[3]?.textContent).toMatch(/expected/i);
    expect(items[0]?.getAttribute('data-series')).toBe('actual');
  });

  it('shows a failure flag as a word, not only a colour (P2)', () => {
    render(<Spine label="Life" events={events} today="2026-10-24" />);
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('offers no way to remove an event (P5)', () => {
    render(<Spine label="Life" events={events} today="2026-10-24" />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
  });

  it('refuses events out of date order (the spine is chronological)', () => {
    expect(() =>
      render(<Spine label="Life" events={[events[2]!, events[0]!]} today="2026-10-24" />),
    ).toThrow(/order/i);
  });
});
