/** Customer statement template (T-0049): opening, movements with running balance, closing; escaped. */
import { describe, expect, it } from 'vitest';
import { renderStatementHtml } from './statement-html.ts';

describe('Statement HTML (T-0049)', () => {
  it('shows opening balance, each movement and the balance due; values are escaped', () => {
    const html = renderStatementHtml({
      supplier: { legalName: 'Harbour Co Pty Ltd', abn: '51824753556' },
      customer: 'Acme <Pty> Ltd',
      from: '2026-11-01',
      to: '2026-12-31',
      openingBalance: '1375.0000',
      lines: [
        {
          date: '2026-11-20',
          kind: 'receipt',
          reference: 'J3-000001',
          debit: '0.0000',
          credit: '375.0000',
          balance: '1000.0000',
        },
        {
          date: '2026-12-06',
          kind: 'invoice',
          reference: 'J1-000002',
          debit: '1375.0000',
          credit: '0.0000',
          balance: '2375.0000',
        },
      ],
      closingBalance: '2375.0000',
    });
    expect(html).toContain('Opening balance');
    expect(html).toContain('$1,375.00');
    expect(html).toContain('Payment');
    expect(html).toContain('$375.00');
    expect(html).toMatch(/Balance due<\/td>.*\$2,375\.00/);
    expect(html).toContain('ABN 51 824 753 556');
    expect(html).toContain('Acme &lt;Pty&gt; Ltd');
    expect(html).not.toMatch(/<script/i);
  });
});
