/**
 * BAS label query on the accruals and the cash basis (T-0035, design §3.6, RQ-0097, DL-0264),
 * against a real PostgreSQL as lf_app. The ledger is built from the Approved golden postings
 * (their tax codes and amounts included) and each period's labels are compared with the golden
 * files' own "Tax/BAS" lines: GP-001 invoice, GP-008 bill, GP-029 (= GP-005 journal) credit note,
 * GP-024 bad-debt write-off, GP-026 recovery, GP-010 pay run; plus part payments for the cash basis.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  allocate,
  entrySeriesFor,
  post,
  SOURCE_TYPES,
  subledgerEntriesOf,
} from '@ledgerforce/ledger';
import {
  AU_SERVICES_BINDINGS,
  approvedTables,
  parsePostings,
  toCommand,
  type GoldenJournal,
} from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basLabels, BAS_LABELS } from './bas.ts';
import { seedTaxCodes, taxCodeIdOn } from './tax-codes.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const table = (id: string): GoldenJournal => {
  const t = tables.find((x) => `${x.entryId}${x.label}` === id);
  if (!t) throw new Error(`golden ${id} not Approved`);
  return t;
};

let f: LedgerFixture;
const parties = new Map<string, string>();
let seq = 0;

/** Post a golden table on `date`, with each line's golden tax code (in force that day) and tax. */
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
    const r = await post(trx, { ...command, lines });
    return r.entryId;
  });
}

/** A receipt (or supplier payment) of `amount`, allocated to the document's open item. */
async function settle(doc: string, amount: string, date: string, kind: 'ar' | 'ap') {
  await f.inTenant(async (trx) => {
    const bank = f.acct['1010'] ?? '';
    const party = parties.get(kind === 'ar' ? 'Acme' : 'Supplier') ?? '';
    const r = await post(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate: date,
      sourceType: kind === 'ar' ? 'ar_receipt' : 'ap_payment',
      lines:
        kind === 'ar'
          ? [
              { account: { id: bank }, debit: amount },
              { account: { role: 'AR_CONTROL' }, credit: amount, partyId: party },
            ]
          : [
              { account: { role: 'AP_CONTROL' }, debit: amount, partyId: party },
              { account: { id: bank }, credit: amount },
            ],
    });
    await allocateBetween(trx, r.entryId, doc, amount, date);
  });
}

async function allocateBetween(
  trx: Parameters<typeof subledgerEntriesOf>[0],
  fromEntry: string,
  toEntry: string,
  amount: string,
  date: string,
) {
  const [from] = await subledgerEntriesOf(trx, fromEntry);
  const [to] = await subledgerEntriesOf(trx, toEntry);
  seq += 1;
  await allocate(trx, {
    companyId: f.companyId,
    idempotencyKey: `bas-alloc-${String(seq)}`,
    fromEntryId: from?.id ?? '',
    toEntryId: to?.id ?? '',
    amount,
    allocationDate: date,
  });
}

const Q2 = { from: '2026-10-01', to: '2026-12-31' };
const Q3 = { from: '2027-01-01', to: '2027-03-31' };
const labels = (basis: 'accrual' | 'cash', q: { from: string; to: string }) =>
  f.inTenant((trx) => basLabels(trx, { companyId: f.companyId, basis, ...q }));
const expectLabels = (got: Record<string, string>, want: Record<string, string>) => {
  const full = Object.fromEntries(BAS_LABELS.map((l) => [l, want[l] ?? '0.0000']));
  expect(got).toEqual(full);
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003501');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `B${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const name of ['Acme', 'Supplier']) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      parties.set(name, p.id);
    }
    await seedTaxCodes(trx, f.companyId);
  });

  // Oct–Dec 2026: three GP-001 invoices and the GP-008 bill.
  const inv1 = await postGolden('GP-001', '2026-11-05');
  const inv2 = await postGolden('GP-001', '2026-11-20');
  const inv3 = await postGolden('GP-001', '2026-11-25');
  const bill = await postGolden('GP-008', '2026-11-03');
  await settle(inv1, '550.00', '2026-12-10', 'ar'); // 40 % paid in Oct–Dec
  // Jan–Mar 2027: rest of inv1 paid, bill paid, credit note on inv2, inv3 written off and
  // recovered, one pay run.
  await settle(inv1, '825.00', '2027-02-10', 'ar');
  await settle(bill, '2750.00', '2027-01-15', 'ap');
  const cn = await postGolden('GP-029', '2027-01-20');
  await f.inTenant((trx) => allocateBetween(trx, cn, inv2, '220.00', '2027-01-20'));
  const wo = await postGolden('GP-024', '2027-02-01');
  await f.inTenant((trx) => allocateBetween(trx, wo, inv3, '1375.00', '2027-02-01'));
  await postGolden('GP-026', '2027-03-01');
  await postGolden('GP-010', '2027-03-14');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-102: BAS labels for a period on the accruals and the cash basis', () => {
  it('SS-PLAT-102 accruals Oct–Dec: invoices G1/1A (GP-001 ×3), bill G10/G11/1B (GP-008)', async () => {
    expectLabels(await labels('accrual', Q2), {
      G1: '4125.0000',
      '1A': '375.0000',
      G10: '2200.0000',
      G11: '550.0000',
      '1B': '250.0000',
    });
  });

  it('SS-PLAT-102 accruals Jan–Mar: credit note nets G1/1A (GP-029), write-off 1B (GP-024), recovery 1A (GP-026), W1/W2 (GP-010)', async () => {
    expectLabels(await labels('accrual', Q3), {
      G1: '-220.0000',
      '1A': '105.0000', // −20 credit note + 125 recovery
      '1B': '125.0000', // bad-debt decreasing adjustment
      W1: '10000.0000',
      W2: '2000.0000',
    });
  });

  it('SS-PLAT-102 cash Oct–Dec: only the part of inv1 paid (550 of 1,375) is attributed', async () => {
    expectLabels(await labels('cash', Q2), { G1: '550.0000', '1A': '50.0000' });
  });

  it('SS-PLAT-102 cash Jan–Mar: rest of inv1, the paid bill and the recovery; no credit-note or write-off effect for unpaid invoices', async () => {
    expectLabels(await labels('cash', Q3), {
      G1: '2200.0000', // 825 rest of inv1 + 1,375 recovery received (GP-026 cash)
      '1A': '200.0000', // 75 + 125
      G10: '2200.0000',
      G11: '550.0000',
      '1B': '250.0000',
      W1: '10000.0000',
      W2: '2000.0000',
    });
  });

  it('SS-PLAT-102 refuses an unknown basis or an inverted period', async () => {
    await expect(
      f.inTenant((trx) =>
        basLabels(trx, {
          companyId: f.companyId,
          basis: 'cash',
          from: '2027-02-01',
          to: '2027-01-01',
        }),
      ),
    ).rejects.toThrow(/period/);
    await expect(
      f.inTenant((trx) =>
        basLabels(trx, {
          companyId: f.companyId,
          basis: 'bogus' as 'cash',
          from: '2027-01-01',
          to: '2027-01-31',
        }),
      ),
    ).rejects.toThrow(/basis/);
  });
});
