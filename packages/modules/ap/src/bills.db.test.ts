/**
 * Supplier bills against a real PostgreSQL as lf_app (T-0050, UC-05, migration 0038, RQ-0106).
 *
 * Entry (gapless BILL- number, duplicate warning), coding (chosen account, product profile,
 * suggestion), preview (writes nothing), posting through the posting engine (one ap_bill entry,
 * AP open item), duplicate refusal on post, immutability of posted bills, and AP lock
 * (SS-UC05-07). The GP-008 journal itself is asserted line for line in golden/gp-008.
 */
import { databaseFingerprint, storedJournal } from '@ledgerforce/ledger/testing';
import { findPeriod, setPeriodStatus, subledgerEntriesOf } from '@ledgerforce/ledger';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBill,
  findDuplicateBills,
  postBill,
  previewBill,
  suggestBillLineCoding,
  type CreateBillInput,
} from './bills.ts';
import { createBillWorld, type BillWorld } from './testing/bill-world.ts';

let w: BillWorld;

beforeAll(async () => {
  w = await createBillWorld('01900000-0000-7000-8000-000000005001');
});

afterAll(async () => {
  await w.close();
});

/** GP-008's bill: stationery $500 GST (non-capital) and a laptop $2,000 CAP. */
const gp008 = (over: Partial<CreateBillInput> = {}): CreateBillInput => ({
  companyId: w.companyId,
  supplierId: w.supplierId,
  supplierRef: 'INV-0045',
  billDate: '2026-11-03',
  dueDate: '2026-11-30',
  enteredBy: w.users.apClerk,
  lines: [
    {
      description: 'Stationery and consumables',
      amount: '500.00',
      accountId: w.acct.office,
      taxCode: 'GST',
    },
    { description: 'Laptop', amount: '2000.00', accountId: w.acct.computers, taxCode: 'CAP' },
  ],
  ...over,
});

const create = (input: CreateBillInput) => w.inTenant((trx) => createBill(trx, input));
const fp = () => databaseFingerprint(w.g.fixture.admin);
const billRow = (id: string) =>
  w.inTenant((trx) =>
    trx.selectFrom('app.bill').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

let firstBill: { id: string; billNo: string };

describe('bill entry', () => {
  it('creates a draft bill numbered from the gapless series, lines in order', async () => {
    const r = await create(gp008());
    firstBill = r;
    expect(r.billNo).toBe('BILL-000045');
    expect(r.duplicates).toEqual([]);
    const row = await billRow(r.id);
    expect(row).toMatchObject({ status: 'draft', currency: 'AUD', journal_entry_id: null });
    const lines = await w.inTenant((trx) =>
      trx
        .selectFrom('app.bill_line')
        .select(['line_no', 'amount', 'tax_code', 'coding_source'])
        .where('bill_id', '=', r.id)
        .orderBy('line_no')
        .execute(),
    );
    expect(lines).toEqual([
      { line_no: 1, amount: '500.0000', tax_code: 'GST', coding_source: 'manual' },
      { line_no: 2, amount: '2000.0000', tax_code: 'CAP', coding_source: 'manual' },
    ]);
  });

  it('SS-UC05-09: Duplicate supplier invoice — the same supplier invoice number (any formatting) is a warning on entry, not a refusal', async () => {
    const r = await create(gp008({ supplierRef: 'inv 0045' }));
    expect(r.billNo).toBe('BILL-000046');
    expect(r.duplicates).toEqual([
      { id: firstBill.id, billNo: 'BILL-000045', status: 'draft', billDate: '2026-11-03' },
    ]);
    const other = await w.inTenant((trx) =>
      findDuplicateBills(trx, {
        companyId: w.companyId,
        supplierId: w.otherSupplierId,
        supplierRef: 'INV-0045',
      }),
    );
    expect(other).toEqual([]);
  });

  it('refuses a party that is not a supplier, a non-positive amount and a foreign currency', async () => {
    expect(await refusal(create(gp008({ supplierId: w.customerId })))).toMatchObject({
      code: 'NOT_A_SUPPLIER',
    });
    expect(
      await refusal(
        create(gp008({ lines: [{ description: 'x', amount: '0', accountId: w.acct.office }] })),
      ),
    ).toMatchObject({ code: 'INVALID_BILL' });
    expect(
      await refusal(
        create(gp008({ lines: [{ description: 'x', amount: '-5.00', accountId: w.acct.office }] })),
      ),
    ).toMatchObject({ code: 'INVALID_BILL' });
    expect(await refusal(create(gp008({ currency: 'USD' })))).toMatchObject({
      code: 'BILL_CURRENCY',
    });
  });
});

describe('preview and post', () => {
  it('SS-UC05-10: Bill preview — builds the GP-008-shaped journal and writes nothing', async () => {
    const before = await fp();
    const p = await w.inTenant((trx) => previewBill(trx, firstBill.id));
    expect(await fp()).toEqual(before);
    expect(p.entry.sourceType).toBe('ap_bill');
    expect(p.entry.total).toBe('2750.0000');
    expect(
      p.entry.lines.map((l) => [l.accountId, l.debit, l.credit, l.taxAmount, l.partyId]),
    ).toEqual([
      [w.acct.office, '500.0000', '0.0000', '50.0000', w.supplierId],
      [w.acct.computers, '2000.0000', '0.0000', '200.0000', w.supplierId],
      [w.acct.gstPaid, '50.0000', '0.0000', null, null],
      [w.acct.gstPaid, '200.0000', '0.0000', null, null],
      [w.acct.apControl, '0.0000', '2750.0000', null, w.supplierId],
    ]);
    expect((await billRow(firstBill.id)).status).toBe('draft');
  });

  it('posts through the posting engine: one ap_bill entry, AP open item 2,750.00 due 2026-11-30', async () => {
    const r = await w.inTenant((trx) =>
      postBill(trx, firstBill.id, { createdBy: w.users.apClerk, approvedBy: w.users.approver }),
    );
    expect(r.replayed).toBe(false);
    const row = await billRow(firstBill.id);
    expect(row).toMatchObject({
      status: 'posted',
      journal_entry_id: r.entryId,
      approved_by: w.users.approver,
    });
    const items = await w.inTenant((trx) => subledgerEntriesOf(trx, r.entryId));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      controlRole: 'AP_CONTROL',
      partyId: w.supplierId,
      originalAmount: '-2750.0000',
      openAmount: '-2750.0000',
      dueDate: '2026-11-30',
      documentDate: '2026-11-03',
    });
    const j = await w.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(j).toMatchObject({ sourceType: 'ap_bill', sourceId: firstBill.id });
  });

  it('posting again replays the same entry and writes nothing', async () => {
    const before = await fp();
    const r = await w.inTenant((trx) => postBill(trx, firstBill.id));
    expect(r.replayed).toBe(true);
    expect(r.billNo).toBe('BILL-000045');
    expect(await fp()).toEqual(before);
  });

  it('SS-UC05-09: Duplicate supplier invoice — a duplicate supplier invoice cannot post twice; nothing is written', async () => {
    const dup = (
      await w.inTenant((trx) =>
        findDuplicateBills(trx, {
          companyId: w.companyId,
          supplierId: w.supplierId,
          supplierRef: 'INV/0045',
        }),
      )
    ).find((d) => d.status === 'draft');
    expect(dup?.billNo).toBe('BILL-000046');
    const before = await fp();
    expect(await refusal(w.inTenant((trx) => postBill(trx, dup?.id ?? '')))).toMatchObject({
      code: 'DUPLICATE_SUPPLIER_REF',
    });
    expect(await fp()).toEqual(before);
  });
});

describe('posted bills are immutable (database guard)', () => {
  it('refuses edits of a posted bill and its lines', async () => {
    const e1 = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill')
          .set({ memo: 'changed' })
          .where('id', '=', firstBill.id)
          .execute(),
      ),
    );
    expect(e1.message).toMatch(/immutable/);
    const e2 = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill_line')
          .set({ amount: '1.00' })
          .where('bill_id', '=', firstBill.id)
          .execute(),
      ),
    );
    expect(e2.message).toMatch(/only while it is draft/);
  });

  it('refuses marking a bill posted without its ap_bill journal entry', async () => {
    const b = await create(gp008({ supplierRef: 'GUARD-1' }));
    const other = await w.inTenant((trx) =>
      trx
        .selectFrom('app.journal_entry')
        .select('id')
        .where('source_type', '=', 'ap_bill')
        .executeTakeFirstOrThrow(),
    );
    const e = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill')
          .set({ status: 'posted', journal_entry_id: other.id, posted_at: new Date() })
          .where('id', '=', b.id)
          .execute(),
      ),
    );
    expect(e.message).toMatch(/posted needs the posted ap_bill journal entry of this bill/);
  });

  it('refuses creating a bill other than as draft', async () => {
    const e = await refusal(
      w.inTenant(async (trx) => {
        await sql`INSERT INTO app.bill (company_id, bill_no, supplier_id, supplier_ref, bill_date, due_date, currency, status)
          VALUES (${w.companyId}, 'X-1', ${w.supplierId}, 'R', '2026-11-01', '2026-11-01', 'AUD', 'approved')`.execute(
          trx,
        );
      }),
    );
    expect(e.message).toMatch(/created as draft/);
  });
});

describe('coding by product profile (T-0039 resolver, purchase direction)', () => {
  it('a product line resolves the slot account; the tax code comes from party/product defaults', async () => {
    const b = await create(
      gp008({
        supplierRef: 'PAPER-1',
        lines: [{ description: 'Copy paper', amount: '100.00', productId: w.products.paper }],
      }),
    );
    const p = await w.inTenant((trx) => previewBill(trx, b.id));
    expect(p.entry.lines[0]).toMatchObject({ accountId: w.acct.office, taxAmount: '10.0000' });
    expect(p.entry.lines[0]?.taxCodeId).toBe(w.taxCodeIds.get('GST'));
  });

  it('DL-0260: differing party (GST) and product (CAP) defaults need an explicit tax code on the line', async () => {
    const b = await create(
      gp008({
        supplierRef: 'LAPTOP-1',
        lines: [
          {
            description: 'Laptop',
            amount: '2000.00',
            productId: w.products.laptop,
            postingSlot: 'asset',
          },
        ],
      }),
    );
    expect(await refusal(w.inTenant((trx) => previewBill(trx, b.id)))).toMatchObject({
      code: 'TAX_CODE_REQUIRED',
    });
    const ok = await create(
      gp008({
        supplierRef: 'LAPTOP-2',
        lines: [
          {
            description: 'Laptop',
            amount: '2000.00',
            productId: w.products.laptop,
            postingSlot: 'asset',
            taxCode: 'CAP',
          },
        ],
      }),
    );
    const p = await w.inTenant((trx) => previewBill(trx, ok.id));
    expect(p.entry.lines[0]).toMatchObject({ accountId: w.acct.computers, taxAmount: '200.0000' });
  });

  it('an uncoded line cannot be previewed or posted', async () => {
    const b = await create(
      gp008({ supplierRef: 'UNCODED-1', lines: [{ description: 'Something', amount: '10.00' }] }),
    );
    expect(await refusal(w.inTenant((trx) => previewBill(trx, b.id)))).toMatchObject({
      code: 'BILL_LINE_UNCODED',
    });
  });
});

describe('suggested coding (UC-05 step 2)', () => {
  it("SS-UC05-02 (db): suggests the account and tax code the supplier's posted bills used", async () => {
    for (const ref of ['HIST-1', 'HIST-2', 'HIST-3']) {
      const b = await create(
        gp008({
          supplierId: w.otherSupplierId,
          supplierRef: ref,
          lines: [
            { description: 'Courier', amount: '40.00', accountId: w.acct.office, taxCode: 'GST' },
          ],
        }),
      );
      await w.inTenant((trx) => postBill(trx, b.id));
    }
    const s = await w.inTenant((trx) =>
      suggestBillLineCoding(trx, {
        companyId: w.companyId,
        supplierId: w.otherSupplierId,
        on: '2026-11-20',
      }),
    );
    expect(s).toEqual({
      accountId: w.acct.office,
      taxCode: 'GST',
      source: 'supplier_history',
      basis: '3 of 3 lines on the last 3 posted bills',
    });
  });

  it('without history falls back to the product profile; a tax-code conflict leaves the tax code open', async () => {
    const s = await w.inTenant((trx) =>
      suggestBillLineCoding(trx, {
        companyId: w.companyId,
        supplierId: w.supplierId,
        productId: w.products.laptop,
        slot: 'asset',
        on: '2026-11-20',
      }),
    );
    expect(s).toMatchObject({
      accountId: w.acct.computers,
      taxCode: null,
      source: 'product_profile',
    });
  });

  it('accepting a suggestion records it as the coding source', async () => {
    const b = await create(
      gp008({
        supplierRef: 'SUGGESTED-1',
        lines: [
          {
            description: 'Courier',
            amount: '40.00',
            accountId: w.acct.office,
            taxCode: 'GST',
            codingSource: 'supplier_history',
          },
        ],
      }),
    );
    const line = await w.inTenant((trx) =>
      trx
        .selectFrom('app.bill_line')
        .select('coding_source')
        .where('bill_id', '=', b.id)
        .executeTakeFirstOrThrow(),
    );
    expect(line.coding_source).toBe('supplier_history');
  });
});

describe('SS-UC05-07: Bill in AP-locked period rejected', () => {
  it('a bill dated 2026-10-20 posted without override in an AP-locked October is rejected with PERIOD_LOCKED; nothing is written', async () => {
    await w.inTenant(async (trx) => {
      const period = await findPeriod(trx, w.companyId, '2026-10-15');
      if (!period) throw new Error('no October period');
      await setPeriodStatus(trx, {
        periodId: period.id,
        status: 'ap_locked',
        actorId: w.users.financeAdmin,
      });
    });
    const b = await create(
      gp008({ supplierRef: 'OCT-LATE', billDate: '2026-10-20', dueDate: '2026-11-19' }),
    );
    const before = await fp();
    expect(await refusal(w.inTenant((trx) => postBill(trx, b.id)))).toMatchObject({
      code: 'PERIOD_LOCKED',
    });
    expect(await fp()).toEqual(before);
    expect((await billRow(b.id)).status).toBe('draft');
  });

  it('UC-05 A2: with a recorded override by a holder of period.lock.override the same bill posts', async () => {
    const b = (
      await w.inTenant((trx) =>
        findDuplicateBills(trx, {
          companyId: w.companyId,
          supplierId: w.supplierId,
          supplierRef: 'OCT-LATE',
        }),
      )
    )[0];
    const r = await w.inTenant((trx) =>
      postBill(trx, b?.id ?? '', {
        createdBy: w.users.financeAdmin,
        periodOverride: { reason: 'Late supplier invoice approved by the Finance Admin' },
      }),
    );
    expect(r.replayed).toBe(false);
    expect((await billRow(b?.id ?? '')).status).toBe('posted');
  });
});
