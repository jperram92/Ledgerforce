/**
 * Golden-posting markdown parser (T-0031, SS-PLAT-12, design §10.8 gate 4).
 *
 * Docs/accounting/postings.md is human-owned; the parser only reads it. It must turn every GP
 * section into a fixture — status, source types, journals with their lines, bindings, tax and
 * party cells and the Total row — and refuse anything it cannot read exactly, so a golden test
 * can never pass against a half-parsed expectation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GoldenParseError,
  parseAmount,
  parseBinding,
  parseGoldenPostings,
  parseTaxCell,
} from './parse.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));

const entry = (body: string) => `# Golden postings\n\n## Index\n\n${body}`;

const GP_A = `## GP-901 — Test invoice

- **Status: Draft** · Phase: MVP · Source type: \`ar.invoice\` · Use cases: UC-01 · Design: §3.8
- **Scenario:** INV-1 to Acme dated 2026-11-05, terms 14 days.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 1,375.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 1,250.00 | GST (tax 125.00) | Acme |
| 3 | tax:GST.collected | 2200 | | 125.00 | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |

- **Check:** ✓
`;

describe('SS-PLAT-12 parser: amounts, bindings and tax cells', () => {
  it('reads display amounts as exact decimal strings (thousands separators, Unicode minus)', () => {
    expect(parseAmount('1,375.00')).toBe('1375.00');
    expect(parseAmount('**10,700.00**')).toBe('10700.00');
    expect(parseAmount('0.01')).toBe('0.01');
    expect(parseAmount('−300.00')).toBe('-300.00');
    expect(parseAmount('')).toBeNull();
    expect(() => parseAmount('12.3.4')).toThrow(GoldenParseError);
    expect(() => parseAmount('1,37,5.00')).toThrow(GoldenParseError);
    expect(() => parseAmount('$5')).toThrow(GoldenParseError);
  });

  it('parses every binding kind the file uses and refuses unknown ones', () => {
    expect(parseBinding('system:AR_CONTROL')).toEqual({ kind: 'system', role: 'AR_CONTROL' });
    expect(parseBinding('product:PROFESSIONAL_SERVICES.revenue')).toEqual({
      kind: 'product',
      product: 'PROFESSIONAL_SERVICES',
      slot: 'revenue',
    });
    expect(parseBinding('tax:GST.collected')).toEqual({
      kind: 'tax',
      code: 'GST',
      slot: 'collected',
    });
    expect(parseBinding('bank:OPERATING')).toEqual({ kind: 'bank', name: 'OPERATING' });
    expect(parseBinding('setting:stripe.clearing_account')).toEqual({
      kind: 'setting',
      key: 'stripe.clearing_account',
    });
    expect(parseBinding('expense: Office expenses')).toEqual({
      kind: 'chosen',
      type: 'expense',
      name: 'Office expenses',
    });
    expect(parseBinding('asset: Computer equipment')).toEqual({
      kind: 'chosen',
      type: 'asset',
      name: 'Computer equipment',
    });
    expect(() => parseBinding('1200')).toThrow(GoldenParseError);
    expect(() => parseBinding('system:ar_control')).toThrow(GoldenParseError);
    expect(() => parseBinding('magic:FOO')).toThrow(GoldenParseError);
  });

  it('splits a tax cell into codes, the signed tax amount and its note', () => {
    expect(parseTaxCell('—')).toEqual({ codes: [], amount: null, note: null });
    expect(parseTaxCell('GST')).toEqual({ codes: ['GST'], amount: null, note: null });
    expect(parseTaxCell('GST (tax 1,000.00)')).toEqual({
      codes: ['GST'],
      amount: '1000.00',
      note: null,
    });
    expect(parseTaxCell('GST (tax −300.00)')).toEqual({
      codes: ['GST'],
      amount: '-300.00',
      note: null,
    });
    expect(parseTaxCell('GST-INC (tax 0.91 doc-level)')).toEqual({
      codes: ['GST-INC'],
      amount: '0.91',
      note: 'doc-level',
    });
    expect(parseTaxCell('GST / GST-CAP')).toEqual({
      codes: ['GST', 'GST-CAP'],
      amount: null,
      note: null,
    });
    expect(() => parseTaxCell('GST (tax abc)')).toThrow(GoldenParseError);
  });
});

describe('SS-PLAT-12 parser: GP sections', () => {
  it('parses a Draft entry into one journal with lines and its Total row', () => {
    const [gp, ...rest] = parseGoldenPostings(entry(GP_A));
    expect(rest).toEqual([]);
    expect(gp).toMatchObject({
      id: 'GP-901',
      title: 'Test invoice',
      status: 'Draft',
      approval: null,
      phase: 'MVP',
      sourceTypes: ['ar.invoice'],
      entryDate: '2026-11-05',
    });
    expect(gp?.journals).toHaveLength(1);
    const j = gp?.journals[0];
    expect(j?.label).toBeNull();
    expect(j?.total).toEqual({ debit: '1375.00', credit: '1375.00' });
    expect(j?.lines).toEqual([
      {
        no: 1,
        account: 'system:AR_CONTROL',
        binding: { kind: 'system', role: 'AR_CONTROL' },
        ref: '1200',
        debit: '1375.00',
        credit: null,
        tax: { codes: [], amount: null, note: null },
        party: 'Acme',
      },
      {
        no: 2,
        account: 'product:PROFESSIONAL_SERVICES.revenue',
        binding: { kind: 'product', product: 'PROFESSIONAL_SERVICES', slot: 'revenue' },
        ref: '4000',
        debit: null,
        credit: '1250.00',
        tax: { codes: ['GST'], amount: '125.00', note: null },
        party: 'Acme',
      },
      {
        no: 3,
        account: 'tax:GST.collected',
        binding: { kind: 'tax', code: 'GST', slot: 'collected' },
        ref: '2200',
        debit: null,
        credit: '125.00',
        tax: { codes: ['GST'], amount: null, note: null },
        party: null,
      },
    ]);
  });

  it('reads an Approved status with its approval note', () => {
    const md = entry(GP_A.replace('**Status: Draft**', '**Status: Approved (JP, 2026-11-10)**'));
    const [gp] = parseGoldenPostings(md);
    expect(gp?.status).toBe('Approved');
    expect(gp?.approval).toBe('JP, 2026-11-10');
  });

  it('reads the delegated approval status of a re-reviewed entry with its full note [T-0124]', () => {
    const note =
      'owner-delegated to claude per DL-0282 after persona re-review DL-0386, 2026-11-09';
    const [gp] = parseGoldenPostings(
      entry(GP_A.replace('**Status: Draft**', `**Status: Approved (${note})**`)),
    );
    expect(gp?.status).toBe('Approved');
    expect(gp?.approval).toBe(note);
  });

  it('treats a proposal status "Draft (proposed by claude, T-0099)" as Draft', () => {
    const md = entry(
      GP_A.replace('**Status: Draft**', '**Status: Draft (proposed by claude, T-0099)**'),
    );
    expect(parseGoldenPostings(md)[0]?.status).toBe('Draft');
  });

  it('keeps several labelled journals of one GP in order, each with its own source type', () => {
    const md = entry(`## GP-902 — Two journals

- **Status: Draft** · Phase: MVP · Source type: \`ar.invoice\` + \`ar.prepayment_application\` · Design: §3.8
- **Scenario:** 2026-12-15 final invoice.

**Journal 13a — final invoice**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:AR_CONTROL | 1200 | 11.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 11.00 | — | Acme |
| | **Total** | | **11.00** | **11.00** | | |

**Journal 13b — application of prepayment**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | system:CUSTOMER_PREPAYMENTS | 2400 | 3.30 | | — | Acme |
| 2 | system:AR_CONTROL | 1200 | | 3.30 | — | Acme |
| | **Total** | | **3.30** | **3.30** | | |
`);
    const [gp] = parseGoldenPostings(md);
    expect(gp?.sourceTypes).toEqual(['ar.invoice', 'ar.prepayment_application']);
    expect(gp?.journals.map((j) => j.label)).toEqual([
      'Journal 13a — final invoice',
      'Journal 13b — application of prepayment',
    ]);
    expect(gp?.journals.map((j) => j.total.debit)).toEqual(['11.00', '3.30']);
  });

  it('refuses an entry without a Status, without a Total row, or with a malformed line', () => {
    expect(() => parseGoldenPostings(entry(GP_A.replace('**Status: Draft** · ', '')))).toThrow(
      /GP-901.*Status/,
    );
    expect(() => parseGoldenPostings(entry(GP_A.replace(/\| \| \*\*Total\*\*.*\n/, '')))).toThrow(
      /GP-901.*Total/,
    );
    expect(() =>
      parseGoldenPostings(
        entry(GP_A.replace('| 3 | tax:GST.collected', '| 7 | tax:GST.collected')),
      ),
    ).toThrow(/GP-901.*line number/);
    expect(() =>
      parseGoldenPostings(entry(GP_A.replace('| | 125.00 | GST |', '| 1.00 | 125.00 | GST |'))),
    ).toThrow(/GP-901.*one of debit and credit/);
    expect(() =>
      parseGoldenPostings(entry(GP_A.replace('Source type: `ar.invoice`', 'x'))),
    ).toThrow(/GP-901.*Source type/);
  });

  it('refuses a duplicate GP id', () => {
    expect(() => parseGoldenPostings(entry(GP_A + '\n' + GP_A))).toThrow(/duplicate GP-901/);
  });

  it('reads a variant id GP-NNN-X (a superseding Draft beside an Approved entry) [T-0124]', () => {
    const md = entry(GP_A + '\n' + GP_A.replace('## GP-901 —', '## GP-901-A —'));
    expect(parseGoldenPostings(md).map((p) => p.id)).toEqual(['GP-901', 'GP-901-A']);
    // Only one capital letter: anything else is not a GP heading and is never half-read as one.
    const odd = entry(GP_A.replace('## GP-901 —', '## GP-901-ab —'));
    expect(parseGoldenPostings(odd)).toEqual([]);
    expect(() =>
      parseGoldenPostings(entry(GP_A.replace('## GP-901 —', '## GP-901-A —').repeat(2))),
    ).toThrow(/duplicate GP-901-A/);
  });

  it('dates each journal from the first date in its label, else from the scenario [T-0124]', () => {
    const two = `## GP-903 — Two dated journals

- **Status: Draft** · Phase: MVP · Source type: \`manual_journal\` + \`ar.write_off\` · Design: §3.8
- **Scenario:** INV-1 dated 2026-11-05.

**A1 — allowance recognised 2027-06-30**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.bad_debt_account | 6500 | 5.00 | | — | — |
| 2 | setting:ar.ecl_allowance_account | 1290 | | 5.00 | — | — |
| | **Total** | | **5.00** | **5.00** | | |

**A2 — write-off**

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
| 1 | setting:ar.ecl_allowance_account | 1290 | 5.00 | | — | Acme |
| 2 | system:AR_CONTROL | 1200 | | 5.00 | — | Acme |
| | **Total** | | **5.00** | **5.00** | | |
`;
    const [gp] = parseGoldenPostings(entry(two));
    expect(gp?.entryDate).toBe('2026-11-05');
    expect(gp?.journals.map((j) => j.date)).toEqual(['2027-06-30', null]);
    // A single table's label is prose: it never dates the journal.
    const [one] = parseGoldenPostings(
      entry(GP_A.replace('| # | Account', '**Lines on 2030-01-01**\n\n| # | Account')),
    );
    expect(one?.journals[0]?.date).toBeNull();
  });
});

describe('SS-PLAT-12 parser: the real Docs/accounting/postings.md', () => {
  const md = readFileSync(POSTINGS, 'utf8');
  const postings = parseGoldenPostings(md);

  it('reads every entry of the index, GP-001 … GP-020 and the T-0124 variants, with at least one journal each', () => {
    const ids = postings.map((p) => p.id);
    expect(ids).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `GP-${String(i + 1).padStart(3, '0')}`),
      // T-0124: superseding variants appended after GP-020 (never inside an Approved entry).
      'GP-007-A',
      'GP-012-B',
      'GP-015-B',
    ]);
    // Every index row names a parsed entry and every entry has an index row.
    const indexIds = [...md.matchAll(/^\| (GP-\d{3}(?:-[A-Z])?) \|/gm)].map((m) => m[1]);
    expect(indexIds).toEqual(ids);
    for (const p of postings) {
      expect(p.journals.length, p.id).toBeGreaterThan(0);
      expect(p.sourceTypes.length, p.id).toBeGreaterThan(0);
    }
    // GP-013 is one journal since RQ-0095 Q7; its superseded 13a/13b are prose in a blockquote.
    expect(postings.find((p) => p.id === 'GP-013')?.journals).toHaveLength(1);
    expect(postings.find((p) => p.id === 'GP-018')?.journals).toHaveLength(2);
    expect(postings.find((p) => p.id === 'GP-020')?.journals).toHaveLength(2);
  });

  it('agrees with the index table on every status (Draft or Approved, never anything else)', () => {
    const index = new Map(
      [...md.matchAll(/^\| (GP-\d{3}(?:-[A-Z])?) \|.*\| ([^|]+?) \|\s*$/gm)].map((m) => [
        m[1],
        m[2]?.trim(),
      ]),
    );
    for (const p of postings) {
      expect(['Draft', 'Approved'], p.id).toContain(p.status);
      expect(
        index.get(p.id)?.startsWith(p.status),
        `${p.id} index says ${String(index.get(p.id))}`,
      ).toBe(true);
    }
  });

  it('reads the T-0124 entries: delegated approval (DL-0282/DL-0386), journals, per-journal dates and source types [T-0124]', () => {
    const by = (id: string) => postings.find((p) => p.id === id);
    const delegated =
      'owner-delegated to claude per DL-0282 after persona re-review DL-0386, 2026-11-09';
    for (const id of ['GP-007-A', 'GP-012-B', 'GP-015-B']) {
      expect(by(id)?.status, id).toBe('Approved');
      expect(by(id)?.approval, id).toBe(delegated);
    }
    // E-001…E-004 are not journals: their status lines and index rows carry the same approval.
    for (const e of ['E-001', 'E-002', 'E-003', 'E-004']) {
      expect(md, e).toMatch(new RegExp(`^\\| ${e} \\|.*\\| Approved \\|\\s*$`, 'm'));
    }
    expect(
      md.match(new RegExp(`\\*\\*Status: Approved \\(${delegated}\\)\\*\\*`, 'g')),
    ).toHaveLength(7);
    for (let i = 1; i <= 20; i++) {
      const id = `GP-${String(i).padStart(3, '0')}`;
      expect(by(id)?.status, id).toBe('Approved');
    }
    const a = by('GP-007-A');
    // RC-1 (persona re-review DL-0386): gross allowance A1 1,375.00 and the A4 remeasurement.
    expect(a?.sourceTypes).toEqual([
      'manual_journal',
      'ar.write_off',
      'ar.write_off',
      'manual_journal',
    ]);
    expect(a?.journals.map((j) => j.date)).toEqual([
      '2027-06-30',
      '2027-12-01',
      '2027-12-01',
      '2027-12-31',
    ]);
    expect(a?.journals.map((j) => j.total.debit)).toEqual([
      '1375.00',
      '1375.00',
      '1375.00',
      '125.00',
    ]);
    // RC-2: GP-012-B line 2 carries the attribution code GST-UB.
    expect(by('GP-012-B')?.journals[0]?.lines[1]?.tax).toEqual({
      codes: ['GST-UB'],
      amount: '700.00',
      note: null,
    });
    expect(by('GP-012-B')?.sourceTypes).toEqual(['ar.prepayment']);
    expect(by('GP-012-B')?.entryDate).toBe('2026-11-10');
    expect(by('GP-015-B')?.sourceTypes).toEqual(['ar.invoice']);
    expect(by('GP-015-B')?.entryDate).toBe('2026-12-15');
  });

  it('reads the original a reversal golden reverses from its Source type (GP-019 → GP-001) [T-0032]', () => {
    const gp019 = postings.find((p) => p.id === 'GP-019');
    expect(gp019?.sourceTypes).toEqual(['ledger.reversal']);
    expect(gp019?.reversalOf).toBe('GP-001');
    expect(gp019?.entryDate).toBe('2026-11-06');
    for (const p of postings.filter((x) => x.id !== 'GP-019')) {
      expect(p.reversalOf, p.id).toBeUndefined();
    }
  });
});
