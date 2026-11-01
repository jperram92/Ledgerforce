/**
 * SS-PLAT-12 golden-posting runner, pure half (T-0031, design §10.8 gate 4).
 *
 * Parses Docs/accounting/postings.md, keeps Approved entries only (refuses Draft), and proves
 * every Approved journal table balances, equals its Total row and converts into a raw posting
 * command that the engine's in-memory check accepts. The database half
 * (golden-engine.db.test.ts) replays the same commands through preview() on the AU services
 * chart and compares line by line.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Money } from '@ledgerforce/shared/money';
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../posting-command.ts';
import { SOURCE_TYPES, sourceClassOf, storedSourceType } from '../period-matrix.ts';
import {
  GoldenDraftError,
  approvedTables,
  parsePostings,
  toCommand,
  type GoldenEntry,
} from './postings.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const entries: GoldenEntry[] = parsePostings(readFileSync(FILE, 'utf8'));
const byId = new Map(entries.map((e) => [e.id, e]));

const SUPERSEDED: Record<string, string> = {
  'GP-004': 'GP-027',
  'GP-007': 'GP-024',
  'GP-012': 'GP-020',
  'GP-013': 'GP-022',
  'GP-018': 'GP-023',
};
const ALL = Array.from({ length: 35 }, (_, i) => `GP-${String(i + 1).padStart(3, '0')}`);

/** Source types named by Approved entries that the engine does not accept yet (T-0116). */
const PENDING_SOURCE_TYPES = [
  'ar.ecl_adjustment',
  'ar.recovery',
  'ledger.accrual',
  'ledger.prepayment_release',
  'ledger.prior_period_adjustment',
  'ledger.recurring.depreciation',
  'payments.stripe.tax_invoice',
  'payroll.sgc_assessment',
  'payroll.super_payment',
  'revrec.release',
];

/** Deterministic stand-in UUIDs: the pure check validates shape, not existence. */
const fakeId = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `00000000-0000-4000-8000-${h.toString(16).padStart(12, '0').slice(-12)}`;
};

describe('SS-PLAT-12: Every Approved golden posting is reproduced exactly — parser and commands', () => {
  it('parses GP-001…GP-035 with their statuses; superseded entries point forward', () => {
    expect(entries.map((e) => e.id)).toEqual(ALL);
    for (const e of entries) {
      if (e.id in SUPERSEDED) {
        expect(e.status, e.id).toBe('superseded');
        expect(e.supersededBy, e.id).toBe(SUPERSEDED[e.id]);
      } else {
        expect(e.status, e.id).toBe('approved');
      }
    }
  });

  it('runs on Approved entries only and refuses a file that still has Draft entries', () => {
    const ids = new Set(approvedTables(entries).map((t) => t.entryId));
    for (const id of Object.keys(SUPERSEDED)) expect(ids.has(id), id).toBe(false);
    expect(ids.size).toBe(30);
    const draft = parsePostings(
      '## GP-900 — x\n\n- **Status: Draft** · Source type: `manual_journal`\n\n' +
        '| # | Account | Ref | Debit | Credit | Tax code | Party |\n|---|---|---|---:|---:|---|---|\n' +
        '| 1 | system:SUSPENSE | 2900 | 1.00 | | — | — |\n| 2 | system:ROUNDING | 6900 | | 1.00 | — | — |\n' +
        '| | **Total** | | **1.00** | **1.00** | | |\n',
    );
    expect(() => approvedTables(draft)).toThrow(GoldenDraftError);
  });

  it('every Approved journal table balances and equals its Total row', () => {
    const tables = approvedTables(entries);
    expect(tables.length).toBe(36); // 30 Approved entries; GP-021 has 3 tables, GP-022/023/031/032 have 2
    for (const t of tables) {
      const d = t.lines.reduce((s, l) => s.add(Money.of(l.debit, 'AUD')), Money.zero('AUD'));
      const c = t.lines.reduce((s, l) => s.add(Money.of(l.credit, 'AUD')), Money.zero('AUD'));
      const label = `${t.entryId}${t.label}`;
      expect(
        d.equals(c),
        `${label} Σdebit ${d.toNumericString()} ≠ Σcredit ${c.toNumericString()}`,
      ).toBe(true);
      expect(d.equals(Money.of(t.total, 'AUD')), `${label} total`).toBe(true);
    }
  });

  it('GP-027 reuses the journal of GP-004 (identical lines, new evidence status)', () => {
    const t027 = approvedTables(entries).filter((t) => t.entryId === 'GP-027');
    expect(t027).toHaveLength(1);
    expect(t027[0]?.lines).toEqual(byId.get('GP-004')?.tables[0]?.lines);
  });

  it('every table becomes a raw command the engine check accepts (known source types)', () => {
    const pending = new Set<string>();
    const reversals = new Set<string>();
    for (const t of approvedTables(entries)) {
      if (!Object.hasOwn(SOURCE_TYPES, storedSourceType(t.sourceType))) {
        pending.add(t.sourceType);
        continue;
      }
      // Reversals are produced by the reversal API from the original entry, never as raw lines.
      if (sourceClassOf(storedSourceType(t.sourceType)) === 'reversal') {
        reversals.add(t.entryId);
        continue;
      }
      const command = toCommand(t, {
        companyId: fakeId('company'),
        entryDate: '2026-11-15',
        account: (binding) => ({ id: fakeId(binding) }),
        party: (name) => fakeId(`party:${name}`),
      });
      const checked = checkCommand(command);
      expect(checked.lines, `${t.entryId}${t.label}`).toHaveLength(t.lines.length);
      expect(
        Money.of(checked.total, 'AUD').equals(Money.of(t.total, 'AUD')),
        `${t.entryId}${t.label}`,
      ).toBe(true);
    }
    expect([...pending].sort()).toEqual(PENDING_SOURCE_TYPES);
    expect([...reversals]).toEqual(['GP-019']);
  });
});
