import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money as MoneyValue } from '@ledgerforce/shared/money';
import { Money } from './Money.tsx';

describe('SS-PLAT-29 <Money> (P3)', () => {
  it('renders a negative in parentheses and announces it as "minus"', () => {
    const { container } = render(<Money value="-389.00" />);
    const el = container.querySelector('[data-amount]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('data-amount')).toBe('-389.00');
    expect(el?.classList.contains('num')).toBe(true);
    expect(el?.classList.contains('money')).toBe(true);
    const visible = el?.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toBe('(389.00)');
    expect(screen.getByText('minus 389.00 dollars').classList.contains('sr-only')).toBe(true);
    expect(el?.textContent).not.toContain('-');
  });

  it('renders a positive amount with grouping and no sign', () => {
    const { container } = render(<Money value="22415" />);
    const el = container.querySelector('[data-amount]');
    expect(el?.getAttribute('data-amount')).toBe('22415.00');
    expect(el?.querySelector('[aria-hidden="true"]')?.textContent).toBe('22,415.00');
    expect(screen.getByText('22,415.00 dollars')).toBeTruthy();
  });

  it('says direction in words for owner sentences', () => {
    const { container } = render(<Money value="-12604.10" sign="words" />);
    expect(container.textContent).toContain('12,604.10 out');
    expect(container.textContent).not.toContain('(');
  });

  it('marks zero and accepts a Money value', () => {
    const { container } = render(
      <>
        <Money value="0" />
        <Money value={MoneyValue.of('917', 'AUD')} />
      </>,
    );
    const els = container.querySelectorAll('[data-amount]');
    expect(els[0]?.getAttribute('data-sign')).toBe('zero');
    expect(els[1]?.getAttribute('data-amount')).toBe('917.00');
    expect(els[1]?.getAttribute('data-sign')).toBe('positive');
  });

  it('refuses a JS float at runtime', () => {
    expect(() => render(<Money value={0.1 as unknown as string} />)).toThrow();
  });
});
