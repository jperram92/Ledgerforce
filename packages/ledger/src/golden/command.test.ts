/**
 * Golden fixture → posting-engine command mapping (T-0031, SS-PLAT-12).
 *
 * A golden journal becomes a raw PostingCommand (posting-command.ts): system roles stay roles
 * for the engine to resolve; every other binding goes through the fixture's binding map (the
 * posting-profile, tax-code, bank and setting resolvers do not exist yet: T-0034/T-0038/T-0039).
 * Amounts are carried exactly at 4 decimals. The mapping refuses what a journal line cannot
 * carry rather than dropping it.
 */
import { describe, expect, it } from 'vitest';
import { goldenCommand, expectedLines, GoldenMappingError, type GoldenWorld } from './command.ts';
import { parseGoldenPostings, type GoldenPosting } from './parse.ts';

const md = (rows: string, status = 'Draft', st = '`ar.invoice`') => `## GP-950 — Mapping
- **Status: ${status}** · Phase: MVP · Source type: ${st} · Design: §3.8
- **Scenario:** dated 2026-11-05.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
${rows}
`;

const only = (text: string): GoldenPosting => {
  const [gp] = parseGoldenPostings(text);
  if (!gp) throw new Error('no GP');
  return gp;
};

const INVOICE = only(
  md(`| 1 | system:AR_CONTROL | 1200 | 1,375.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 1,250.00 | GST (tax 125.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 125.00 | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |`),
);

const world: GoldenWorld = {
  companyId: '01900000-0000-7000-8000-00000000c001',
  account: (b) => {
    if (b.kind === 'system')
      return { ref: { role: b.role }, accountId: `id-${b.role}`, label: `system:${b.role} (1200)` };
    if (b.kind === 'tax')
      return {
        ref: { role: 'GST_COLLECTED' },
        accountId: 'id-GST_COLLECTED',
        label: 'tax:GST.collected (2310)',
      };
    if (b.kind === 'product')
      return {
        ref: { id: '01900000-0000-7000-8000-0000000a4110' },
        accountId: '01900000-0000-7000-8000-0000000a4110',
        label: 'product (4110)',
      };
    throw new GoldenMappingError(`no binding for ${b.kind}`);
  },
  partyId: (name) => (name === 'Acme' ? '01900000-0000-7000-8000-0000000000ac' : undefined),
  partyLabel: (id) => (id === '01900000-0000-7000-8000-0000000000ac' ? 'Acme' : id),
  taxCodeId: (code) => (code === 'GST' ? '01900000-0000-7000-8000-00000000960a' : undefined),
};

describe('SS-PLAT-12 command mapping', () => {
  it('maps a golden journal to a raw command with exact 4-decimal amounts', () => {
    const cmd = goldenCommand(INVOICE, 0, world, { idempotencyKey: 'golden:GP-950:0' });
    expect(cmd).toEqual({
      companyId: world.companyId,
      idempotencyKey: 'golden:GP-950:0',
      entryDate: '2026-11-05',
      sourceType: 'ar_invoice',
      sourceId: 'GP-950',
      memo: 'golden GP-950 — Mapping',
      lines: [
        {
          account: { role: 'AR_CONTROL' },
          debit: '1375.0000',
          partyId: '01900000-0000-7000-8000-0000000000ac',
        },
        {
          account: { id: '01900000-0000-7000-8000-0000000a4110' },
          credit: '1250.0000',
          taxCodeId: '01900000-0000-7000-8000-00000000960a',
          taxAmount: '125.0000',
          partyId: '01900000-0000-7000-8000-0000000000ac',
        },
        {
          account: { role: 'GST_COLLECTED' },
          credit: '125.0000',
          taxCodeId: '01900000-0000-7000-8000-00000000960a',
        },
      ],
    });
  });

  it('builds the expected line views from the same bindings', () => {
    expect(expectedLines(INVOICE, 0, world)).toEqual([
      {
        lineNo: 1,
        accountId: 'id-AR_CONTROL',
        accountLabel: 'system:AR_CONTROL (1200)',
        debit: '1375.0000',
        credit: '0.0000',
        taxCodeId: null,
        taxLabel: null,
        taxAmount: null,
        partyId: '01900000-0000-7000-8000-0000000000ac',
        partyLabel: 'Acme',
      },
      {
        lineNo: 2,
        accountId: '01900000-0000-7000-8000-0000000a4110',
        accountLabel: 'product (4110)',
        debit: '0.0000',
        credit: '1250.0000',
        taxCodeId: '01900000-0000-7000-8000-00000000960a',
        taxLabel: 'GST',
        taxAmount: '125.0000',
        partyId: '01900000-0000-7000-8000-0000000000ac',
        partyLabel: 'Acme',
      },
      {
        lineNo: 3,
        accountId: 'id-GST_COLLECTED',
        accountLabel: 'tax:GST.collected (2310)',
        debit: '0.0000',
        credit: '125.0000',
        taxCodeId: '01900000-0000-7000-8000-00000000960a',
        taxLabel: 'GST',
        taxAmount: null,
        partyId: null,
        partyLabel: null,
      },
    ]);
  });

  it('uses the n-th source type for the n-th journal and the stored (underscored) code', () => {
    const two = only(
      md(
        `| 1 | system:AR_CONTROL | 1200 | 1.00 | | — | Acme |
| 2 | system:AR_CONTROL | 1200 | | 1.00 | — | Acme |
| | **Total** | | **1.00** | **1.00** | | |`,
        'Draft',
        '`ar.invoice` + `payments.stripe.charge`',
      ),
    );
    expect(goldenCommand(two, 0, world, { idempotencyKey: 'k' }).sourceType).toBe('ar_invoice');
  });

  it('carries a negative tax amount as written, for the engine to accept or refuse', () => {
    const neg = only(
      md(`| 1 | system:AR_CONTROL | 1200 | 3.00 | | GST (tax −0.30) | Acme |
| 2 | system:AR_CONTROL | 1200 | | 3.00 | — | Acme |
| | **Total** | | **3.00** | **3.00** | | |`),
    );
    expect(goldenCommand(neg, 0, world, { idempotencyKey: 'k' }).lines[0]?.taxAmount).toBe(
      '-0.3000',
    );
  });

  it('refuses unknown parties, unknown tax codes, two tax codes on one line and a missing date', () => {
    const cell = (party: string, tax: string) =>
      only(
        md(`| 1 | system:AR_CONTROL | 1200 | 1.00 | | ${tax} | ${party} |
| 2 | system:AR_CONTROL | 1200 | | 1.00 | — | — |
| | **Total** | | **1.00** | **1.00** | | |`),
      );
    const k = { idempotencyKey: 'k' };
    expect(() => goldenCommand(cell('Nobody', '—'), 0, world, k)).toThrow(/line 1.*party "Nobody"/);
    expect(() => goldenCommand(cell('Acme', 'GST-XYZ'), 0, world, k)).toThrow(
      /line 1.*tax code GST-XYZ/,
    );
    expect(() => goldenCommand(cell('Acme', 'GST / GST-CAP'), 0, world, k)).toThrow(
      /line 1.*one tax code.*GST, GST-CAP/,
    );
    expect(() => goldenCommand({ ...INVOICE, entryDate: null }, 0, world, k)).toThrow(
      GoldenMappingError,
    );
    expect(
      goldenCommand({ ...INVOICE, entryDate: null }, 0, world, { ...k, defaultDate: '2026-11-01' })
        .entryDate,
    ).toBe('2026-11-01');
  });
});
