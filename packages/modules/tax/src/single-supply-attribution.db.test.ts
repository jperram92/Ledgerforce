/**
 * SS-PLAT-135: single-supply GST attribution contract (T-0168, ADR-0089, RQ-0171, GP-040…GP-042),
 * against a real PostgreSQL as lf_app.
 *
 * Proves that the Approved golden journals for a single (non-Div 156) supply on the accruals basis
 * give the BAS their "Tax/BAS" lines state through the UNCHANGED code-driven BAS query (bas.ts):
 * the first part-payment attributes the whole supply's GST (G1 11,000.00 / 1A 1,000.00), a second
 * receipt and the final invoice add nothing, a price change is reported once as its own
 * adjustment, cancellation removes the unbilled attribution, and a reversal nets to zero.
 *
 * The GST_ATTRIBUTED_UNBILLED role is not bound yet (its additive role binding and template
 * account are T-0203). Here the golden binding resolves to a plain asset account the test adds,
 * so this file proves the journal/BAS contract, not the production posting path; that path is
 * T-0203/T-0204 (their failing tests are named on those cards).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { entrySeriesFor, post, reverse, SOURCE_TYPES } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import {
  AU_SERVICES_BINDINGS,
  approvedTables,
  parsePostings,
  toCommand,
  type GoldenJournal,
} from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basLabels, BAS_LABELS } from './bas.ts';
import { seedTaxCodes, taxCodeIdOn } from './tax-codes.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const UNBILLED = 'system:GST_ATTRIBUTED_UNBILLED';

let f: LedgerFixture;
let unbilledAccount = '';
const parties = new Map<string, string>();

const table = (id: string): GoldenJournal => {
  const t = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
    (x) => `${x.entryId}${x.label}` === id,
  );
  if (!t) throw new Error(`golden ${id} not Approved`);
  return t;
};

/** Post a golden table on `date` with its golden tax codes and tax amounts. */
async function postGolden(id: string, date: string): Promise<string> {
  const t = table(id);
  return f.inTenant(async (trx) => {
    const command = toCommand(t, {
      companyId: f.companyId,
      entryDate: date,
      idempotencyKey: randomUUID(),
      account: (binding) => {
        if (binding === UNBILLED) return { id: unbilledAccount };
        const b = AU_SERVICES_BINDINGS[binding];
        if (!b) throw new Error(`${id}: unresolved ${binding}`);
        return 'role' in b ? { role: b.role } : { id: f.acct[b.code] ?? `missing ${b.code}` };
      },
      party: (name) => parties.get(name) ?? `missing party ${name}`,
    });
    const lines = [];
    for (const [i, l] of command.lines.entries()) {
      const g = t.lines[i];
      const taxCodeId = g?.taxCode
        ? await taxCodeIdOn(trx, f.companyId, g.taxCode, date)
        : undefined;
      if (g?.taxCode && !taxCodeId) throw new Error(`${id}: tax code ${g.taxCode} not seeded`);
      lines.push({
        ...l,
        ...(taxCodeId ? { taxCodeId } : {}),
        ...(g?.taxAmount ? { taxAmount: g.taxAmount } : {}),
      });
    }
    return (await post(trx, { ...command, lines })).entryId;
  });
}

const labels = (from: string, to: string) =>
  f.inTenant((trx) => basLabels(trx, { companyId: f.companyId, basis: 'accrual', from, to }));
const expectLabels = (got: Record<string, string>, want: Record<string, string>) => {
  expect(got).toEqual(Object.fromEntries(BAS_LABELS.map((l) => [l, want[l] ?? '0.0000'])));
};

/** Balance (debit − credit) of an account over the given entries. */
async function balanceOf(account: string, entries: readonly string[]): Promise<string> {
  const r = await f.inTenant((trx) =>
    sql<{ b: string }>`
      SELECT coalesce(sum(debit - credit), 0)::text AS b FROM app.journal_line
       WHERE account_id = ${account}::uuid AND entry_id = ANY(${sql.val([...entries])}::uuid[])`.execute(
      trx,
    ),
  );
  return Money.of(r.rows[0]?.b ?? '0', 'AUD').toNumericString();
}

const prepayments = async () =>
  (
    await f.inTenant((trx) =>
      sql<{ id: string }>`SELECT account_id::text AS id FROM app.account_role_binding
                           WHERE role = 'CUSTOMER_PREPAYMENTS'`.execute(trx),
    )
  ).rows[0]?.id ?? '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003651');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `S${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    parties.set('Acme', p.id);
    await seedTaxCodes(trx, f.companyId);
    const a = await trx
      .insertInto('app.account')
      .values({
        company_id: f.companyId,
        code: '1230',
        name: 'GST attributed on unbilled supplies',
        type: 'asset',
        subtype: 'current_asset',
        normal_balance: 'debit',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    unbilledAccount = a.id;
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-135: single-supply GST attribution goldens through the unchanged BAS query', () => {
  it('SS-PLAT-135 first part-payment attributes the whole supply (G1 11,000.00, 1A 1,000.00); a second receipt adds nothing; the final invoice repeats no GST', async () => {
    const r1 = await postGolden('GP-040a', '2026-11-10');
    const r2 = await postGolden('GP-040b', '2026-11-25');
    expectLabels(await labels('2026-11-01', '2026-11-30'), {
      G1: '11000.0000',
      '1A': '1000.0000',
    });
    const fin = await postGolden('GP-041a', '2026-12-15');
    expectLabels(await labels('2026-12-01', '2026-12-31'), {});
    // The unbilled attribution and the contract liability both clear on the final invoice.
    expect(await balanceOf(unbilledAccount, [r1, r2, fin])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [r1, r2, fin])).toBe('0.0000');
    expect(await balanceOf(unbilledAccount, [r1])).toBe('700.0000');
    expect(await balanceOf(unbilledAccount, [r1, r2])).toBe('400.0000');
  });

  it('SS-PLAT-135 a price increase on the final invoice reports only the change (G1 550.00, 1A 50.00)', async () => {
    await postGolden('GP-041b', '2027-01-15');
    expectLabels(await labels('2027-01-01', '2027-01-31'), { G1: '550.0000', '1A': '50.0000' });
  });

  it('SS-PLAT-135 a price decrease on the final invoice reports only the change (G1 −550.00, 1A −50.00)', async () => {
    await postGolden('GP-041c', '2027-02-15');
    expectLabels(await labels('2027-02-01', '2027-02-28'), { G1: '-550.0000', '1A': '-50.0000' });
  });

  it('SS-PLAT-135 cancellation removes the unbilled attribution (G1 −7,700.00, 1A −700.00); the refund of the part paid removes the rest; the contract nets to zero', async () => {
    const r1 = await postGolden('GP-040a', '2027-03-02');
    const cancel = await postGolden('GP-042a', '2027-03-20');
    expectLabels(await labels('2027-03-01', '2027-03-31'), { G1: '3300.0000', '1A': '300.0000' });
    expect(await balanceOf(unbilledAccount, [r1, cancel])).toBe('0.0000');
    const refund = await postGolden('GP-042b', '2027-04-05');
    expectLabels(await labels('2027-04-01', '2027-04-30'), { G1: '-3300.0000', '1A': '-300.0000' });
    expect(await balanceOf(await prepayments(), [r1, cancel, refund])).toBe('0.0000');
  });

  it('SS-PLAT-135 reversing the first receipt in the same period nets the BAS to zero', async () => {
    const r1 = await postGolden('GP-040a', '2027-05-03');
    await f.inTenant((trx) =>
      reverse(trx, {
        companyId: f.companyId,
        entryId: r1,
        idempotencyKey: randomUUID(),
        entryDate: '2027-05-04',
      }),
    );
    expectLabels(await labels('2027-05-01', '2027-05-31'), {});
  });
});
