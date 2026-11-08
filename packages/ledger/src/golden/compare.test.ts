/**
 * Line-for-line comparison of a golden journal with the engine's journal (T-0031, SS-PLAT-12).
 * Every field the golden table states is compared exactly; a mismatch reads as a sentence a
 * reviewer can act on, followed by both journals side by side.
 */
import { describe, expect, it } from 'vitest';
import { diffJournal, formatJournalDiff, type LineView } from './compare.ts';

const line = (lineNo: number, over: Partial<LineView> = {}): LineView => ({
  lineNo,
  accountId: `acct-${String(lineNo)}`,
  accountLabel: `system:ROLE_${String(lineNo)}`,
  debit: lineNo === 1 ? '1375.0000' : '0.0000',
  credit: lineNo === 1 ? '0.0000' : '1375.0000',
  taxCodeId: null,
  taxLabel: null,
  taxAmount: null,
  partyId: null,
  partyLabel: null,
  ...over,
});

describe('SS-PLAT-12 comparison', () => {
  it('finds no difference between identical journals', () => {
    expect(diffJournal([line(1), line(2)], [line(1), line(2)])).toEqual([]);
  });

  it('reports each differing field of a line with its labels', () => {
    const actual = [
      line(1, { accountId: 'other', accountLabel: '4120 Subscriptions' }),
      line(2, {
        credit: '1375.0100',
        taxCodeId: 'tc-gst',
        taxLabel: 'GST',
        taxAmount: '125.0000',
        partyId: 'p-acme',
        partyLabel: 'Acme',
      }),
    ];
    expect(diffJournal([line(1), line(2)], actual)).toEqual([
      'line 1 account: expected system:ROLE_1, engine 4120 Subscriptions',
      'line 2 credit: expected 1375.0000, engine 1375.0100',
      'line 2 tax code: expected —, engine GST',
      'line 2 tax amount: expected —, engine 125.0000',
      'line 2 party: expected —, engine Acme',
    ]);
  });

  it('reports missing and unexpected lines and line-number drift', () => {
    expect(diffJournal([line(1), line(2)], [line(1)])).toEqual([
      'line 2 missing from the engine journal (system:ROLE_2 Cr 1375.0000)',
    ]);
    expect(diffJournal([line(1)], [line(1), line(2)])).toEqual([
      'line 2 unexpected in the engine journal (system:ROLE_2 Cr 1375.0000)',
    ]);
    expect(diffJournal([line(1)], [line(1, { lineNo: 3 })])).toEqual([
      'line 1 line number: expected 1, engine 3',
    ]);
  });

  it('formats both journals side by side under the differences', () => {
    const text = formatJournalDiff(
      'GP-001',
      [line(1), line(2)],
      [line(1), line(2, { credit: '1.0000' })],
    );
    expect(text).toContain('GP-001 — 1 difference(s)');
    expect(text).toContain('line 2 credit: expected 1375.0000, engine 1.0000');
    expect(text).toMatch(/expected \(golden\)[\s\S]*1 \| system:ROLE_1 \| 1375\.0000 \|/);
    expect(text).toMatch(/engine[\s\S]*2 \| system:ROLE_2 \| \s*\| 1\.0000/);
  });
});
