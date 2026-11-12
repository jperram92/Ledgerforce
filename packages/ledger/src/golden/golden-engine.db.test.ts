/**
 * SS-PLAT-12 golden-posting runner, engine half (T-0031), against a real PostgreSQL as lf_app.
 *
 * Every Approved golden journal table is turned into a raw posting command (accounts resolved
 * through AU_SERVICES_BINDINGS onto the AU services SMB chart template — never hard-coded in
 * the golden file) and replayed through preview(): the engine's built journal must equal the
 * golden table line for line (account, debit, credit, party). Tables the engine or template
 * cannot express yet are not skipped: they are pinned in PENDING with their reason and owning
 * task, and the test fails if that list changes without being updated.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Money } from '@ledgerforce/shared/money';
import { auServicesSmb } from '@ledgerforce/gl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entrySeriesFor } from '../posting-command.ts';
import { SOURCE_TYPES, sourceClassOf, storedSourceType } from '../period-matrix.ts';
import { post, preview } from '../posting-engine.ts';
import { reverse } from '../reversal.ts';
import { createLedgerFixture, type LedgerFixture } from '../testing/journal-fixture.ts';
import { AU_SERVICES_BINDINGS, approvedTables, parsePostings, toCommand } from './postings.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));

/**
 * Golden tables the engine cannot replay yet, with the reason and owning task. Shrinks to empty;
 * never grows silently. Empty since T-0032 (reversals replay through reverse()).
 */
const PENDING: Record<string, string> = {};

/**
 * What each golden binding means on the AU services template, by account name — an expectation
 * independent of AU_SERVICES_BINDINGS, so a wrong binding fails here instead of passing itself.
 */
const MEANS: Record<string, string> = {
  'system:AR_CONTROL': 'Trade debtors',
  'system:AP_CONTROL': 'Trade creditors',
  'system:UNDEPOSITED_FUNDS': 'Undeposited funds',
  'system:CUSTOMER_PREPAYMENTS': 'Customer prepayments',
  'system:DEFERRED_REVENUE': 'Deferred revenue',
  'system:ROUNDING': 'Rounding',
  'system:WAGES_PAYABLE': 'Wages payable',
  'system:PAYG_WITHHOLDING': 'PAYG withholding payable',
  'system:SUPER_PAYABLE': 'Superannuation payable',
  'system:PREPAYMENTS': 'Prepayments',
  'system:ACCUM_DEPRECIATION': 'Accumulated depreciation - office equipment',
  'system:DEPRECIATION_EXPENSE': 'Depreciation',
  'tax:GST.collected': 'GST collected',
  'tax:GST.paid': 'GST paid',
  'bank:OPERATING': 'Operating account',
  'setting:stripe.clearing_account': 'Stripe clearing',
  'setting:stripe.fee_account': 'Merchant fees',
  'setting:ar.bad_debt_account': 'Bad debts',
  'setting:payroll.wages_expense': 'Wages and salaries',
  'setting:payroll.super_expense': 'Superannuation expense',
  'product:PROFESSIONAL_SERVICES.revenue': 'Professional services',
  'product:SUBSCRIPTION.revenue': 'Subscriptions',
  'asset: Computer equipment': 'Office equipment',
  'expense: Insurance': 'Insurance',
  'system:AR_ECL_ALLOWANCE': 'Allowance for expected credit losses',
  'system:ACCRUED_EXPENSES': 'Accrued expenses',
  'system:SGC_PAYABLE': 'Super guarantee charge payable',
  'system:PRIOR_PERIOD_ADJUSTMENTS': 'Prior-period adjustments',
  'system:RETAINED_EARNINGS': 'Retained earnings',
  'setting:payroll.sgc_expense': 'Super guarantee charge expense',
  'expense: Office expenses': 'Office expenses',
  'expense: Electricity': 'Electricity',
};
const nameOfCode = new Map(auServicesSmb.accounts.map((a) => [a.code, a.name]));

let f: LedgerFixture;
const parties = new Map<string, string>();

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003101');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((st) => entrySeriesFor(st)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `G${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const name of ['Acme', 'Supplier', 'Stripe', 'ATO']) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      parties.set(name, p.id);
    }
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** Why a table cannot be replayed yet, or undefined when it can. */
function pendingReason(t: (typeof tables)[number]): string | undefined {
  if (!Object.hasOwn(SOURCE_TYPES, storedSourceType(t.sourceType))) {
    return `source type ${t.sourceType}`;
  }
  if (sourceClassOf(storedSourceType(t.sourceType)) === 'reversal' && !t.reversalOf) {
    return 'reversal without an original';
  }
  const missing = t.lines.find((l) => AU_SERVICES_BINDINGS[l.binding] == null);
  return missing ? `binding ${missing.binding}` : undefined;
}

const amt = (v: string) => Money.of(v, 'AUD').toNumericString();

const resolveAccount = (label: string) => (binding: string) => {
  const b = AU_SERVICES_BINDINGS[binding];
  if (!b) throw new Error(`${label}: unresolved ${binding}`);
  return 'role' in b ? { role: b.role } : { id: f.acct[b.code] ?? `missing ${b.code}` };
};

/** A reversal golden: post its original, reverse() it, compare the stored reversal lines. */
async function replayReversal(t: (typeof tables)[number]): Promise<number> {
  const label = `${t.entryId}${t.label}`;
  const original = tables.find((x) => x.entryId === t.reversalOf);
  if (!original) throw new Error(`${label}: original ${String(t.reversalOf)} not Approved`);
  const posted = await f.inTenant((trx) =>
    post(
      trx,
      toCommand(original, {
        companyId: f.companyId,
        entryDate: '2026-11-15',
        idempotencyKey: randomUUID(),
        account: resolveAccount(label),
        party: (name) => parties.get(name) ?? `missing party ${name}`,
      }),
    ),
  );
  const r = await f.inTenant((trx) =>
    reverse(trx, {
      companyId: f.companyId,
      entryId: posted.entryId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-11-16',
    }),
  );
  const stored = await f.inTenant((trx) =>
    trx
      .selectFrom('app.journal_line as l')
      .innerJoin('app.account as a', 'a.id', 'l.account_id')
      .select(['a.code', 'l.debit', 'l.credit', 'l.party_id'])
      .where('l.entry_id', '=', r.entryId)
      .orderBy('l.line_no')
      .execute(),
  );
  expect(stored, label).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const at = `${label} line ${String(i + 1)} (${g.binding})`;
    expect(nameOfCode.get(stored[i]?.code ?? ''), at).toBe(MEANS[g.binding]);
    expect(amt(stored[i]?.debit ?? '0'), at).toBe(amt(g.debit));
    expect(amt(stored[i]?.credit ?? '0'), at).toBe(amt(g.credit));
    expect(stored[i]?.party_id ?? null, at).toBe(g.party ? (parties.get(g.party) ?? '?') : null);
  });
  return 1;
}

describe('SS-PLAT-12: Every Approved golden posting is reproduced exactly — engine replay', () => {
  it('the tables that cannot be replayed yet are exactly the pinned PENDING list', () => {
    const actual: Record<string, string> = {};
    for (const t of tables) {
      const why = pendingReason(t);
      if (why) actual[`${t.entryId}${t.label}`] = why;
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(PENDING).sort());
    for (const [k, why] of Object.entries(actual)) expect(why, k).toBe(PENDING[k]?.split(' (')[0]);
  });

  it('preview() reproduces every other Approved table line for line', async () => {
    let replayed = 0;
    for (const t of tables) {
      if (pendingReason(t)) continue;
      const label = `${t.entryId}${t.label}`;
      if (t.reversalOf) {
        replayed += await replayReversal(t);
        continue;
      }
      const command = toCommand(t, {
        companyId: f.companyId,
        entryDate: '2026-11-15',
        idempotencyKey: randomUUID(),
        account: (binding) => {
          const b = AU_SERVICES_BINDINGS[binding];
          if (!b) throw new Error(`${label}: unresolved ${binding}`);
          return 'role' in b ? { role: b.role } : { id: f.acct[b.code] ?? `missing ${b.code}` };
        },
        party: (name) => parties.get(name) ?? `missing party ${name}`,
      });
      const built = await f.inTenant((trx) => preview(trx, command));
      expect(built.lines, label).toHaveLength(t.lines.length);
      t.lines.forEach((g, i) => {
        const b = built.lines[i];
        const want = AU_SERVICES_BINDINGS[g.binding];
        const at = `${label} line ${i + 1} (${g.binding})`;
        if (want && 'code' in want) expect(b?.accountCode, at).toBe(want.code);
        expect(nameOfCode.get(b?.accountCode ?? ''), at).toBe(MEANS[g.binding]);
        expect(b?.debit, at).toBe(amt(g.debit));
        expect(b?.credit, at).toBe(amt(g.credit));
        expect(b?.partyId ?? null, at).toBe(g.party ? (parties.get(g.party) ?? '?') : null);
      });
      expect(Money.of(built.total, 'AUD').equals(Money.of(t.total, 'AUD')), label).toBe(true);
      replayed += 1;
    }
    expect(replayed).toBe(tables.length - Object.keys(PENDING).length);
  }, 120_000);
});
