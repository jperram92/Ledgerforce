/**
 * T-0035 — the BAS report is a query over the ledger (design §3.6, RQ-0102), on both GST bases.
 *
 * Expected results are the Tax/BAS lines of the Approved golden postings (Docs/accounting/
 * postings.md, DL-0253). Each golden journal is posted through the posting engine into a golden
 * world (the same producer as the golden runner), with the AU tax-code template v2 loaded so the
 * lines carry real tax-code ids; receipts, payments and allocations are written through the
 * ledger API. The report must read only journal lines and allocations and write nothing.
 *
 * SS-PLAT-111 accruals · SS-PLAT-112 cash by settlement allocation · SS-PLAT-113 Simpler BAS ·
 * SS-PLAT-114 read-only.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Database } from '@ledgerforce/db';
import { allocate, post, subledgerEntriesOf, type PostingLineInput } from '@ledgerforce/ledger';
import { databaseFingerprint } from '@ledgerforce/ledger/testing';
import {
  createGoldenWorld,
  GOLDEN_DEFAULT_DATE,
  goldenCommand,
  parseGoldenPostings,
  type GoldenFixture,
  type GoldenPosting,
  type GoldenWorld,
} from '@ledgerforce/ledger/testing/golden';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { basReport, type BasQuery } from './bas-report.ts';
import { auTaxCodes, loadTaxCodes } from './tax-codes.ts';

const POSTINGS_MD = readFileSync(
  fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url)),
  'utf8',
);
const goldens = new Map(parseGoldenPostings(POSTINGS_MD).map((g) => [g.id, g]));
const gp = (id: string): GoldenPosting => {
  const g = goldens.get(id);
  if (!g) throw new Error(`${id} not in postings.md`);
  return g;
};
/** The Tax/BAS text of a golden entry (the bullet(s) after its journal table). */
const basText = (id: string): string => {
  const start = POSTINGS_MD.indexOf(`## ${id} —`);
  const end = POSTINGS_MD.indexOf('\n## ', start + 1);
  return POSTINGS_MD.slice(start, end === -1 ? undefined : end);
};

interface World {
  g: GoldenFixture;
  world: GoldenWorld;
  companyId: string;
  inT<R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R>;
}

async function world(tenantId: string): Promise<World> {
  const g = await createGoldenWorld(tenantId);
  const companyId = g.world.companyId;
  const inT = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => g.fixture.inTenant(fn);
  await inT((trx) => loadTaxCodes(trx, companyId, auTaxCodes));
  const ids = await inT((trx) =>
    trx
      .selectFrom('app.tax_code')
      .select(['id', 'code'])
      .where('company_id', '=', companyId)
      .execute(),
  );
  const byCode = new Map(ids.map((r) => [r.code, r.id]));
  // Golden lines name template codes; here they resolve to the company's real tax-code rows.
  return { g, companyId, inT, world: { ...g.world, taxCodeId: (code) => byCode.get(code) } };
}

/** Posts journal `index` of an Approved golden through the engine; returns the entry id. */
async function postGolden(w: World, id: string, index = 0): Promise<string> {
  const g = gp(id);
  expect(g.status, `${id} must be Approved`).toBe('Approved');
  const command = goldenCommand(g, index, w.world, {
    idempotencyKey: `bas:${id}:${String(index)}:${randomUUID()}`,
    defaultDate: GOLDEN_DEFAULT_DATE,
  });
  return w.inT((trx) => post(trx, command)).then((r) => r.entryId);
}

async function postRaw(
  w: World,
  sourceType: string,
  entryDate: string,
  lines: PostingLineInput[],
): Promise<string> {
  return w
    .inT((trx) =>
      post(trx, {
        companyId: w.companyId,
        idempotencyKey: randomUUID(),
        entryDate,
        sourceType,
        lines,
      }),
    )
    .then((r) => r.entryId);
}

async function settle(w: World, fromEntry: string, toEntry: string, amount: string, date: string) {
  await w.inT(async (trx) => {
    const [from] = await subledgerEntriesOf(trx, fromEntry);
    const [to] = await subledgerEntriesOf(trx, toEntry);
    if (!from || !to) throw new Error('both entries need an open item');
    await allocate(trx, {
      companyId: w.companyId,
      idempotencyKey: randomUUID(),
      fromEntryId: from.id,
      toEntryId: to.id,
      amount,
      allocationDate: date,
    });
  });
}

const report = (w: World, q: Omit<BasQuery, 'companyId'>) =>
  w.inT((trx) => basReport(trx, { companyId: w.companyId, ...q }));

/** The full-format label set with every label not listed at 0.00. */
const full = (non0: Record<string, string>) => ({
  G1: '0.00',
  G2: '0.00',
  G3: '0.00',
  G10: '0.00',
  G11: '0.00',
  '1A': '0.00',
  '1B': '0.00',
  W1: '0.00',
  W2: '0.00',
  ...non0,
});

describe('the expectations come from the Approved goldens’ Tax/BAS lines', () => {
  it('postings.md states the figures these tests assert', () => {
    expect(basText('GP-001')).toContain('G1 +1,375.00; 1A +125.00');
    expect(basText('GP-002')).toContain('Cash basis: G1 +1,375.00, 1A +125.00');
    expect(basText('GP-005')).toContain('same BAS period as INV-000123 → G1 −220.00, 1A −20.00');
    expect(basText('GP-006')).toContain('none (GST already adjusted by GP-005)');
    expect(basText('GP-007')).toContain('decreasing adjustment **1B +125.00**');
    expect(basText('GP-007')).toContain(
      '**Cash basis:** the GST was never reported, so no BAS adjustment',
    );
    expect(basText('GP-008')).toContain('G10 +2,200.00; G11 +550.00; 1B +250.00');
    expect(basText('GP-010')).toContain('W1 +10,000.00, W2 +2,000.00');
    expect(basText('GP-012')).toContain('(accruals and cash):** G1 +3,300.00; 1A +300.00');
  });
});

describe('sales: GP-001 invoice, GP-002 receipt, GP-005 credit note, GP-006 refund', () => {
  let w: World;
  let inv: string;
  let cn: string;
  beforeAll(async () => {
    w = await world('01900000-0000-7000-8000-0000000035c1');
    inv = await postGolden(w, 'GP-001'); // 2026-11-05
    const rct = await postGolden(w, 'GP-002'); // 2026-11-15
    await settle(w, rct, inv, '1375.00', '2026-11-15');
    cn = await postGolden(w, 'GP-005'); // 2026-11-20
    const refund = await postGolden(w, 'GP-006'); // 2026-11-24
    await settle(w, refund, cn, '220.00', '2026-11-24');
  });
  afterAll(async () => w.g.close());

  it('SS-PLAT-111 GP-001 on accruals: G1 1,375.00, 1A 125.00 in the invoice period', async () => {
    const r = await report(w, { from: '2026-11-05', to: '2026-11-19', basis: 'accruals' });
    expect(r.labels).toEqual(full({ G1: '1375.00', '1A': '125.00' }));
  });

  it('SS-PLAT-111 GP-005 in the same BAS period nets into G1/1A (1,155.00 / 105.00)', async () => {
    const r = await report(w, { from: '2026-11-01', to: '2026-11-30', basis: 'accruals' });
    expect(r.labels).toEqual(full({ G1: '1155.00', '1A': '105.00' }));
    const cnOnly = await report(w, { from: '2026-11-20', to: '2026-11-20', basis: 'accruals' });
    expect(cnOnly.labels).toEqual(full({ G1: '-220.00', '1A': '-20.00' }));
  });

  it('SS-PLAT-112 cash basis: nothing until paid, then G1/1A in the receipt period', async () => {
    const before = await report(w, { from: '2026-11-01', to: '2026-11-14', basis: 'cash' });
    expect(before.labels).toEqual(full({}));
    const receipt = await report(w, { from: '2026-11-15', to: '2026-11-15', basis: 'cash' });
    expect(receipt.labels).toEqual(full({ G1: '1375.00', '1A': '125.00' }));
  });

  it('SS-PLAT-112 cash basis: the credit note counts when its refund is paid (GP-006)', async () => {
    const refund = await report(w, { from: '2026-11-21', to: '2026-11-30', basis: 'cash' });
    expect(refund.labels).toEqual(full({ G1: '-220.00', '1A': '-20.00' }));
    const month = await report(w, { from: '2026-11-01', to: '2026-11-30', basis: 'cash' });
    expect(month.labels).toEqual(full({ G1: '1155.00', '1A': '105.00' }));
  });

  it('the basis defaults to the company setting (accruals)', async () => {
    const r = await report(w, { from: '2026-11-15', to: '2026-11-15' });
    expect(r.basis).toBe('accruals');
    expect(r.labels).toEqual(full({}));
  });

  it('SS-PLAT-114 the report writes nothing', async () => {
    const before = await databaseFingerprint(w.g.fixture.admin);
    await report(w, { from: '2026-07-01', to: '2027-06-30', basis: 'accruals' });
    await report(w, { from: '2026-07-01', to: '2027-06-30', basis: 'cash', format: 'simpler' });
    expect(await databaseFingerprint(w.g.fixture.admin)).toEqual(before);
  });
});

describe('bad debt: GP-007 write-off of an unpaid GP-001-shaped invoice', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('01900000-0000-7000-8000-0000000035c2');
    const inv = await postGolden(w, 'GP-001'); // INV-000140 has the same lines, 2026-11-05
    const wo = await postGolden(w, 'GP-007'); // 2027-12-01
    await settle(w, wo, inv, '1375.00', '2027-12-01');
  });
  afterAll(async () => w.g.close());

  it('SS-PLAT-111 accruals: 1B 125.00 in the write-off period, after G1/1A at invoice', async () => {
    const wo = await report(w, { from: '2027-12-01', to: '2027-12-31', basis: 'accruals' });
    expect(wo.labels).toEqual(full({ '1B': '125.00' }));
    const invoiced = await report(w, { from: '2026-11-01', to: '2026-11-30', basis: 'accruals' });
    expect(invoiced.labels).toEqual(full({ G1: '1375.00', '1A': '125.00' }));
  });

  it('SS-PLAT-112 cash: nothing — the write-off is not consideration and ADJ-BD maps to none', async () => {
    const all = await report(w, { from: '2026-07-01', to: '2028-06-30', basis: 'cash' });
    expect(all.labels).toEqual(full({}));
  });
});

describe('purchases, prepayment, payroll, partial payment and Simpler BAS', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('01900000-0000-7000-8000-0000000035c3');
    const acme = w.world.partyId('Acme');
    const supplier = w.world.partyId('Supplier');
    if (!acme || !supplier) throw new Error('golden parties missing');
    const bank = { id: w.world.account({ kind: 'bank', name: 'OPERATING' }).accountId };

    const bill = await postGolden(w, 'GP-008'); // 2026-11-03
    const pay = await postRaw(w, 'ap_payment', '2026-11-30', [
      { account: { role: 'AP_CONTROL' }, debit: '2750.00', partyId: supplier },
      { account: bank, credit: '2750.00' },
    ]);
    await settle(w, pay, bill, '2750.00', '2026-11-30');

    await postGolden(w, 'GP-012'); // 2026-11-10
    const inv = await postGolden(w, 'GP-001'); // 2026-11-05
    const half = await postRaw(w, 'ar_receipt', '2026-12-10', [
      { account: bank, debit: '687.50' },
      { account: { role: 'AR_CONTROL' }, credit: '687.50', partyId: acme },
    ]);
    await settle(w, half, inv, '687.50', '2026-12-10');
    await postGolden(w, 'GP-010'); // 2027-07-14 (Phase 1 journal; W1/W2 mapping is in scope)
  });
  afterAll(async () => w.g.close());

  it('SS-PLAT-111 GP-008 accruals: G10 2,200.00, G11 550.00, 1B 250.00', async () => {
    const r = await report(w, { from: '2026-11-03', to: '2026-11-03', basis: 'accruals' });
    expect(r.labels).toEqual(full({ G10: '2200.00', G11: '550.00', '1B': '250.00' }));
  });

  it('SS-PLAT-112 GP-008 cash: nothing until the bill is paid, then all of it', async () => {
    // Before payment only GP-012 (cash at receipt, 2026-11-10) is in the window; the unpaid bill
    // and the unpaid GP-001 invoice report nothing.
    const unpaid = await report(w, { from: '2026-11-03', to: '2026-11-29', basis: 'cash' });
    expect(unpaid.labels).toEqual(full({ G1: '3300.00', '1A': '300.00' }));
    const paid = await report(w, { from: '2026-11-30', to: '2026-11-30', basis: 'cash' });
    expect(paid.labels).toEqual(full({ G10: '2200.00', G11: '550.00', '1B': '250.00' }));
  });

  it('SS-PLAT-111/112 GP-012 prepayment: G1 3,300.00, 1A 300.00 at receipt on both bases', async () => {
    for (const basis of ['accruals', 'cash'] as const) {
      const r = await report(w, { from: '2026-11-10', to: '2026-11-10', basis });
      expect(r.labels, basis).toEqual(full({ G1: '3300.00', '1A': '300.00' }));
    }
  });

  it('SS-PLAT-112 a half payment reports half the invoice on the cash basis', async () => {
    const r = await report(w, { from: '2026-12-01', to: '2026-12-31', basis: 'cash' });
    expect(r.labels).toEqual(full({ G1: '687.50', '1A': '62.50' }));
  });

  it('SS-PLAT-111 GP-010 payroll: W1 10,000.00, W2 2,000.00 on both bases', async () => {
    for (const basis of ['accruals', 'cash'] as const) {
      const r = await report(w, { from: '2027-07-01', to: '2027-07-31', basis });
      expect(r.labels, basis).toEqual(full({ W1: '10000.00', W2: '2000.00' }));
    }
  });

  it('SS-PLAT-113 Simpler BAS shows only G1, 1A and 1B with the full-format amounts', async () => {
    const q = { from: '2026-11-01', to: '2026-11-30', basis: 'accruals' } as const;
    const fullR = await report(w, q);
    expect(fullR.labels).toEqual(
      full({ G1: '4675.00', '1A': '425.00', G10: '2200.00', G11: '550.00', '1B': '250.00' }),
    );
    const simpler = await report(w, { ...q, format: 'simpler' });
    expect(simpler.format).toBe('simpler');
    expect(simpler.labels).toEqual({ G1: '4675.00', '1A': '425.00', '1B': '250.00' });
  });
});
