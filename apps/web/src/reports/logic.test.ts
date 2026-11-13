/** Report screen helpers (T-0089): CSV export, dates, search params, plain words. */
import { describe, expect, it } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import {
  csvAmount,
  csvText,
  dateRange,
  dayOnly,
  localToday,
  monthStart,
  readersOf,
  reportMessage,
  subtypeWord,
  toCsv,
} from './logic.ts';

describe('CSV export [T-0089]', () => {
  it('joins rows with CRLF behind a byte-order mark and quotes only when needed', () => {
    expect(
      toCsv([
        ['Code', 'Account'],
        [csvText('1010'), csvText('Operating, main')],
        [csvText('3000'), csvText('Say "hi"\nthere')],
      ]),
    ).toBe('\uFEFFCode,Account\r\n1010,"Operating, main"\r\n3000,"Say ""hi""\nthere"\r\n');
  });

  it('defuses spreadsheet formulas in text but keeps amounts as plain numbers', () => {
    expect(csvText('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvText('+61 2')).toBe("'+61 2");
    expect(csvText('-x')).toBe("'-x");
    expect(csvText('@SUM')).toBe("'@SUM");
    expect(csvAmount('-1100.0000')).toBe('-1100.00');
    expect(csvAmount('12450.0000')).toBe('12450.00');
    expect(csvAmount('0.005')).toBe('0.01');
  });

  it('refuses a JS number as an amount', () => {
    expect(() => csvAmount(1.5 as unknown as string)).toThrow(TypeError);
  });
});

describe('dates [T-0089]', () => {
  it('reads today and the month start in local time', () => {
    const d = new Date(2026, 10, 13, 23, 30);
    expect(localToday(d)).toBe('2026-11-13');
    expect(monthStart('2026-11-13')).toBe('2026-11-01');
  });

  it('keeps only real YYYY-MM-DD days from the URL', () => {
    expect(dayOnly('2026-11-30')).toBe('2026-11-30');
    expect(dayOnly('2026-02-30')).toBeUndefined();
    expect(dayOnly('30-11-2026')).toBeUndefined();
    expect(dayOnly(7)).toBeUndefined();
  });

  it('defaults a range to this month, and an open start only where the report allows it', () => {
    expect(dateRange({}, '2026-11-13', true)).toEqual({ from: '2026-11-01', to: '2026-11-13' });
    expect(dateRange({ to: '2026-10-31' }, '2026-11-13', true)).toEqual({
      from: null,
      to: '2026-10-31',
    });
    expect(dateRange({ to: '2026-10-31' }, '2026-11-13', false)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(dateRange({ from: '2026-07-01' }, '2026-11-13', false)).toEqual({
      from: '2026-07-01',
      to: '2026-11-13',
    });
  });
});

describe('plain words [T-0089]', () => {
  it('names account kinds, and falls back to the subtype in words', () => {
    expect(subtypeWord('operating_revenue')).toBe('Operating income');
    expect(subtypeWord('receivable')).toBe('Money customers owe you');
    expect(subtypeWord('made_up_kind')).toBe('Made up kind');
  });

  it('lists the roles that hold a permission from the role templates', () => {
    expect(readersOf('reports.run')).toBe('Owners, Finance Admins, Accountants and Auditors');
  });

  it('explains report refusals, and keeps other errors to the shared wording', () => {
    expect(
      reportMessage(new AdminApiError(422, { error: 'NO_FISCAL_YEAR', message: 'x' })),
    ).toMatch(/no financial year that holds this date/);
    expect(
      reportMessage(new AdminApiError(400, { error: 'invalid_report_query', message: 'x' })),
    ).toMatch(/Check the dates/);
    expect(reportMessage(new Error('offline'))).toMatch(/did not answer/);
  });
});
