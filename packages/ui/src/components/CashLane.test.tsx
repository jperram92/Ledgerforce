import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CashLane } from './CashLane.tsx';

const points: [string, string][] = [
  ['2026-10-01', '158904.20'],
  ['2026-10-16', '146391.15'],
  ['2026-10-23', '184320.55'],
  ['2026-10-27', '196500.55'],
  ['2026-10-30', '123266.85'],
  ['2026-11-05', '154876.85'],
];

function renderCash() {
  return render(
    <CashLane
      points={points}
      range={{ from: '2026-10-01', to: '2026-11-09' }}
      lastStatement="2026-10-23"
      scaleMin="100000"
      scaleMax="215000"
      leavesOut="Overdue invoices (33,482.50) are not counted."
    />,
  );
}

describe('SS-PLAT-29 <CashLane> (P15 expected is never shown as actual)', () => {
  it('draws actual solid up to the last statement date, and expected dashed from there', () => {
    const { container } = renderCash();
    const actual = container.querySelector('path[data-series="actual"]');
    const expected = container.querySelector('path[data-series="expected"]');
    expect(actual?.getAttribute('stroke-dasharray')).toBeNull();
    expect(expected?.getAttribute('stroke-dasharray')).toBeTruthy();
    // x = days from 1 Oct / 40 days * 1000; 23 Oct = day 22 -> 550
    const actualD = actual?.getAttribute('d') ?? '';
    expect(actualD.trim().endsWith('H550')).toBe(true);
    expect(expected?.getAttribute('d')?.startsWith('M550,')).toBe(true);
    expect(
      container.querySelector('[data-last-statement]')?.getAttribute('data-last-statement'),
    ).toBe('2026-10-23');
  });

  it('computes heights from decimal strings exactly (no float on money)', () => {
    const { container } = renderCash();
    // y = H - (v - min) / (max - min) * H with H = 200: 158904.20 -> 200 - 58904.20/115000*200 = 97.56
    const actualD = container.querySelector('path[data-series="actual"]')?.getAttribute('d') ?? '';
    expect(actualD.startsWith('M0,97.56')).toBe(true);
  });

  it('labels the expected series in words, says what it leaves out, and names the lowest point', () => {
    renderCash();
    expect(screen.getAllByText(/expected/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Overdue invoices (33,482.50) are not counted.')).toBeTruthy();
    expect(screen.getByText(/lowest/i).textContent).toContain('Fri 30 Oct');
    expect(screen.getByText(/last statement/i).textContent).toContain('Fri 23 Oct');
  });

  it('gives the chart a text summary for screen readers', () => {
    renderCash();
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toMatch(/actual .*184,320\.55.*23 Oct/i);
    expect(img.getAttribute('aria-label')).toMatch(/expected lowest 123,266\.85/i);
  });
});
