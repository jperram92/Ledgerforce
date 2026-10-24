import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JournalTable, type JournalLine } from './JournalTable.tsx';

const lines: JournalLine[] = [
  { code: '1200', account: 'Trade debtors', gloss: 'Saltbush owes you', debit: '10087.00' },
  { code: '4110', account: 'Professional services', gloss: 'earned', credit: '6840.00' },
  { code: '4120', account: 'Support subscriptions', gloss: 'earned', credit: '1450.00' },
  { code: '4130', account: 'Training', gloss: 'earned', credit: '880.00' },
  { code: '2310', account: 'GST collected', gloss: 'held for the ATO', credit: '917.00' },
];

describe('SS-PLAT-29 <JournalTable> (P1, P3, P12)', () => {
  it('shows each account with its code, term and plain gloss, Dr and Cr in separate columns', () => {
    render(<JournalTable journal="JNL-004231" lines={lines} />);
    const table = screen.getByRole('table', { name: 'Journal JNL-004231' });
    expect(within(table).getByRole('columnheader', { name: 'Debit' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Credit' })).toBeTruthy();
    const rows = within(table).getAllByRole('row');
    // header + 5 lines + footer
    expect(rows).toHaveLength(7);
    expect(rows[1]?.textContent).toContain('1200');
    expect(rows[1]?.textContent).toContain('Trade debtors');
    expect(rows[1]?.textContent).toContain('Saltbush owes you');
    const amounts = table.querySelectorAll('tbody [data-amount]');
    expect([...amounts].map((a) => a.getAttribute('data-amount'))).toEqual([
      '10087.00',
      '6840.00',
      '1450.00',
      '880.00',
      '917.00',
    ]);
  });

  it('totals the columns exactly and says it is balanced', () => {
    render(<JournalTable journal="JNL-004231" lines={lines} />);
    const foot = screen.getByRole('row', { name: /balanced/i });
    const totals = [...foot.querySelectorAll('[data-amount]')].map((a) =>
      a.getAttribute('data-amount'),
    );
    expect(totals).toEqual(['10087.00', '10087.00']);
  });

  it('says plainly when it is out of balance, and by how much', () => {
    render(
      <JournalTable
        journal="JNL-X"
        lines={[
          { code: '1200', account: 'Trade debtors', gloss: 'owed to you', debit: '0.30' },
          { code: '4110', account: 'Sales', gloss: 'earned', credit: '0.10' },
          { code: '4120', account: 'Sales', gloss: 'earned', credit: '0.10' },
        ]}
      />,
    );
    expect(screen.getByText(/out of balance by/i).textContent).toContain('0.10');
  });

  it('refuses negative or two-sided lines (Dr/Cr are always positive, one side per line)', () => {
    expect(() =>
      render(
        <JournalTable
          journal="J"
          lines={[{ code: '1', account: 'a', gloss: 'g', debit: '-1.00' }]}
        />,
      ),
    ).toThrow();
    expect(() =>
      render(
        <JournalTable
          journal="J"
          lines={[{ code: '1', account: 'a', gloss: 'g', debit: '1.00', credit: '1.00' }]}
        />,
      ),
    ).toThrow();
  });
});
