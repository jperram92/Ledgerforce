/**
 * SS-PLAT-135: single-supply GST attribution contract (T-0168, ADR-0089, RQ-0171), against a real
 * PostgreSQL as lf_app. Current goldens: GP-040 (receipts), GP-045 (final invoice, supersedes
 * GP-041), GP-044 (cancellation and refund, supersedes GP-042) — accounting review of T-0168.
 *
 * Proves that the Approved golden journals for a single (non-Div 156) supply on the accruals basis
 * give the BAS their "Tax/BAS" lines state through the UNCHANGED code-driven BAS query (bas.ts):
 * the first part-payment attributes the whole supply's GST (G1 11,000.00 / 1A 1,000.00), a second
 * receipt and the final invoice add nothing, a price change is reported once as its own
 * adjustment, a cancellation with the refund agreed removes the whole 1,000.00 at cancellation
 * (one adjustment note) and the refund itself has no GST, a cancellation with the refund
 * undecided removes only the unbilled part until the refund is agreed, and a reversal nets to
 * zero. The final invoice's AR open item is the whole tax invoice with the receipts allocated.
 *
 * The golden binding system:GST_ATTRIBUTED_UNBILLED resolves through its role, bound by the
 * template to account 1230 since T-0203 (migration 0073; until then this file added a plain
 * asset account). This file proves the journal/BAS contract, not the production posting path;
 * that path is T-0203 (single-supply.db.test.ts in modules/ar) and T-0204.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allocate,
  entrySeriesFor,
  post,
  reverse,
  SOURCE_TYPES,
  subledgerEntriesOf,
} from '@ledgerforce/ledger';
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
    const a = await sql<{ id: string; code: string }>`
      SELECT b.account_id::text AS id, a.code FROM app.account_role_binding b
        JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
       WHERE b.company_id = ${f.companyId}::uuid AND b.role = 'GST_ATTRIBUTED_UNBILLED'`.execute(
      trx,
    );
    expect(a.rows.map((x) => x.code)).toEqual(['1230']);
    unbilledAccount = a.rows[0]?.id ?? '';
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** The open AR items of an entry: [debit item, credit item] where both exist. */
const itemsOf = (entryId: string) => f.inTenant((trx) => subledgerEntriesOf(trx, entryId));

/** Allocate the credit open item of `fromEntry` to the debit open item of `toEntry`. */
async function allocateWithin(fromEntry: string, toEntry: string, amount: string, date: string) {
  await f.inTenant(async (trx) => {
    const from = (await subledgerEntriesOf(trx, fromEntry)).find((x) =>
      x.originalAmount.startsWith('-'),
    );
    const to = (await subledgerEntriesOf(trx, toEntry)).find(
      (x) => !x.originalAmount.startsWith('-'),
    );
    await allocate(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      fromEntryId: from?.id ?? 'missing credit item',
      toEntryId: to?.id ?? 'missing debit item',
      amount,
      allocationDate: date,
    });
  });
}

const openOf = async (entryId: string) =>
  (await itemsOf(entryId)).map((x) => Money.of(x.openAmount, 'AUD').toNumericString());

/** Post GP-040a and GP-040b, then a final invoice table; allocate its receipts credit. */
async function contractTo(finalId: string, receiptDates: [string, string], finalDate: string) {
  const r1 = await postGolden('GP-040a', receiptDates[0]);
  const r2 = await postGolden('GP-040b', receiptDates[1]);
  const fin = await postGolden(finalId, finalDate);
  await allocateWithin(fin, fin, '6600.00', finalDate);
  return { r1, r2, fin };
}

describe('SS-PLAT-135: single-supply GST attribution goldens through the unchanged BAS query', () => {
  it('SS-PLAT-135 first part-payment attributes the whole supply (G1 11,000.00, 1A 1,000.00); a second receipt adds nothing; the final tax invoice (GP-045a) repeats no GST and its AR item is the whole 11,000.00 with the 6,600.00 received allocated', async () => {
    const r1 = await postGolden('GP-040a', '2026-11-10');
    const r2 = await postGolden('GP-040b', '2026-11-25');
    expectLabels(await labels('2026-11-01', '2026-11-30'), {
      G1: '11000.0000',
      '1A': '1000.0000',
    });
    expect(await balanceOf(unbilledAccount, [r1])).toBe('700.0000');
    expect(await balanceOf(unbilledAccount, [r1, r2])).toBe('400.0000');
    const fin = await postGolden('GP-045a', '2026-12-15');
    await allocateWithin(fin, fin, '6600.00', '2026-12-15');
    expectLabels(await labels('2026-12-01', '2026-12-31'), {});
    expect(await balanceOf(unbilledAccount, [r1, r2, fin])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [r1, r2, fin])).toBe('0.0000');
    const items = await itemsOf(fin);
    expect(items.map((x) => Money.of(x.originalAmount, 'AUD').toNumericString())).toEqual([
      '11000.0000',
      '-6600.0000',
    ]);
    expect(await openOf(fin)).toEqual(['4400.0000', '0.0000']);
  });

  it('SS-PLAT-135 a price increase agreed on the final invoice date (GP-045b) reports only the change (G1 550.00, 1A 50.00 over the whole supply 11,550.00 / 1,050.00) and clears both contract balances', async () => {
    const c = await contractTo('GP-045b', ['2027-01-05', '2027-01-12'], '2027-01-20');
    expectLabels(await labels('2027-01-01', '2027-01-31'), { G1: '11550.0000', '1A': '1050.0000' });
    expect(await balanceOf(unbilledAccount, [c.r1, c.r2, c.fin])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [c.r1, c.r2, c.fin])).toBe('0.0000');
    expect(await openOf(c.fin)).toEqual(['4950.0000', '0.0000']);
  });

  it('SS-PLAT-135 a price decrease agreed on the final invoice date (GP-045c) reports only the change (whole supply 10,450.00 / 950.00) and clears both contract balances', async () => {
    const c = await contractTo('GP-045c', ['2027-02-03', '2027-02-10'], '2027-02-20');
    expectLabels(await labels('2027-02-01', '2027-02-28'), { G1: '10450.0000', '1A': '950.0000' });
    expect(await balanceOf(unbilledAccount, [c.r1, c.r2, c.fin])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [c.r1, c.r2, c.fin])).toBe('0.0000');
    expect(await openOf(c.fin)).toEqual(['3850.0000', '0.0000']);
  });

  it('SS-PLAT-135 cancellation with the refund agreed (GP-044a) removes the whole 1,000.00 in the cancellation period and leaves a 3,300.00 customer credit; the refund (GP-044b) has no GST', async () => {
    const r1 = await postGolden('GP-040a', '2027-03-02');
    const cancel = await postGolden('GP-044a', '2027-03-20');
    expectLabels(await labels('2027-03-01', '2027-03-31'), {});
    expect(await balanceOf(unbilledAccount, [r1, cancel])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [r1, cancel])).toBe('0.0000');
    expect(await openOf(cancel)).toEqual(['-3300.0000']);
    const refund = await postGolden('GP-044b', '2027-04-05');
    await allocateWithin(cancel, refund, '3300.00', '2027-04-05');
    expectLabels(await labels('2027-04-01', '2027-04-30'), {});
    expect(await openOf(cancel)).toEqual(['0.0000']);
    expect(await openOf(refund)).toEqual(['0.0000']);
  });

  it('SS-PLAT-135 cancellation with the refund undecided (GP-044c) removes only the unbilled 700.00; the refund agreed later (GP-044d) removes the 300.00 in its own period; the contract nets to zero', async () => {
    const r1 = await postGolden('GP-040a', '2027-05-04');
    const cancel = await postGolden('GP-044c', '2027-05-20');
    expectLabels(await labels('2027-05-01', '2027-05-31'), { G1: '3300.0000', '1A': '300.0000' });
    expect(await balanceOf(unbilledAccount, [r1, cancel])).toBe('0.0000');
    expect(await balanceOf(await prepayments(), [r1, cancel])).toBe('-3000.0000');
    const refund = await postGolden('GP-044d', '2027-06-10');
    expectLabels(await labels('2027-06-01', '2027-06-30'), { G1: '-3300.0000', '1A': '-300.0000' });
    expect(await balanceOf(await prepayments(), [r1, cancel, refund])).toBe('0.0000');
  });

  it('SS-PLAT-135 reversing the first receipt in the same period nets the BAS to zero', async () => {
    const r1 = await postGolden('GP-040a', '2026-10-05');
    await f.inTenant((trx) =>
      reverse(trx, {
        companyId: f.companyId,
        entryId: r1,
        idempotencyKey: randomUUID(),
        entryDate: '2026-10-06',
      }),
    );
    expectLabels(await labels('2026-10-01', '2026-10-31'), {});
  });
});
