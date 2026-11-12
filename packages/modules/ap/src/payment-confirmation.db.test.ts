/**
 * Payment confirmation (T-0057, UC-06 step 5, design §3.8 row 7, GP-009, DL-0304), against a real
 * PostgreSQL as lf_app: nothing posts when a batch is released; recording the bank's confirmation
 * posts one journal per batch — one AP_CONTROL debit per bill (with the supplier) and one bank
 * credit for the batch total (postings.md Q6, RQ-0096) — and allocates each payment to its bill,
 * which is then paid (open 0.00). The journal is compared line for line with the Approved GP-009.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBill, createBill, submitBill } from './bills.ts';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import {
  createPaymentBatch,
  getPaymentBatch,
  releasePaymentBatch,
  type PaymentBatchError,
} from './payment-batches.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp009 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-009',
);

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaser = '';
let treasurer = '';

const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005701');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
  treasurer = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** The GP-008 bill (BILL-000045 in the golden scenario): 2,750.00 incl. 250.00 GST. */
const postGp008Bill = (supplier: string, ref: string, dueDate: string) =>
  f.inTenant(async (trx) => {
    const d = await createBill(trx, {
      companyId: f.companyId,
      partyId: supplier,
      supplierRef: ref,
      billDate: '2026-11-03',
      dueDate,
      lines: [
        {
          accountId: f.acct['6230'] ?? '',
          description: 'Stationery',
          amount: '500.00',
          taxCode: 'GST',
        },
        {
          accountId: f.acct['1500'] ?? '',
          description: 'Laptop',
          amount: '2000.00',
          taxCode: 'GST-CAP',
        },
      ],
    });
    await submitBill(trx, { companyId: f.companyId, billId: d.billId });
    return approveBill(trx, { companyId: f.companyId, billId: d.billId });
  });

const releasedBatch = async (paymentDate: string) => {
  const id = randomUUID();
  await f.inTenant((trx) =>
    createPaymentBatch(trx, {
      companyId: f.companyId,
      id,
      paymentDate,
      dueBy: paymentDate,
      accountId: f.acct['1010'] ?? '',
      createdBy: clerk,
    }),
  );
  await f.inTenant((trx) =>
    releasePaymentBatch(trx, { companyId: f.companyId, batchId: id, releasedBy: releaser }),
  );
  return id;
};

const confirm = (batchId: string, confirmedOn: string, bankReference?: string) =>
  f.inTenant((trx) =>
    confirmPaymentBatch(trx, {
      companyId: f.companyId,
      batchId,
      confirmedOn,
      ...(bankReference ? { bankReference } : {}),
      confirmedBy: treasurer,
    }),
  );

const refusal = (pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as PaymentBatchError,
  );

const paymentEntries = () =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ id: string; source_id: string | null }>`
          SELECT id::text, source_id::text FROM app.journal_entry
           WHERE company_id = ${f.companyId} AND source_type = 'ap_payment'`.execute(trx)
      ).rows,
  );

const linesOf = (entryId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id
           WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(trx)
      ).rows,
  );

describe('SS-UC06-07: Batch posts GP-009 on confirmation only', () => {
  it('SS-UC06-07 a released batch posts nothing; the bank confirmation posts exactly GP-009 and pays the bill', async () => {
    expect(gp009?.lines).toHaveLength(2);
    const supplier = await p.addSupplier('Officeworks-like Supplies Pty Ltd', 72);
    const bill = await postGp008Bill(supplier, 'SUP-INV-9001', '2026-11-27');
    const batchId = await releasedBatch('2026-11-27');

    // After release: released, and no payment journal exists.
    const released = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, batchId));
    expect(released).toMatchObject({ status: 'released', total: '2750.0000', confirmation: null });
    expect(await paymentEntries()).toEqual([]);
    const [billItem] = await f.inTenant((trx) => subledgerEntriesOf(trx, bill.entryId ?? ''));
    expect(billItem?.openAmount).toBe('-2750.0000');

    // Bank confirms the next day.
    const c = await confirm(batchId, '2026-11-28', 'CBA-20261128-001');
    expect(c).toMatchObject({
      batchId,
      batchNo: released.batchNo,
      confirmedOn: '2026-11-28',
      bankReference: 'CBA-20261128-001',
      confirmedBy: treasurer,
      replayed: false,
      payments: [
        { billId: bill.billId, billNo: bill.billNo, partyId: supplier, amount: '2750.0000' },
      ],
    });
    const entries = await paymentEntries();
    expect(entries).toEqual([{ id: c.entryId, source_id: batchId }]);
    const entry = await f.inTenant(
      async (trx) =>
        (
          await sql<{ d: string }>`SELECT to_char(entry_date, 'YYYY-MM-DD') AS d
             FROM app.journal_entry WHERE id = ${c.entryId}`.execute(trx)
        ).rows[0]?.d,
    );
    expect(entry).toBe('2026-11-28');

    // Line for line GP-009.
    const codeOf: Record<string, string> = {
      'system:AP_CONTROL': '2000',
      'bank:OPERATING': '1010',
    };
    const rows = await linesOf(c.entryId ?? '');
    expect(rows).toHaveLength(gp009?.lines.length ?? -1);
    gp009?.lines.forEach((g, i) => {
      const at = `GP-009 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? supplier : null);
    });

    // Subledger: payment −2,750.00 allocated to the bill → 0.00 (Paid).
    const [paid] = await f.inTenant((trx) => subledgerEntriesOf(trx, bill.entryId ?? ''));
    expect(paid?.openAmount).toBe('0.0000');
    const [payment] = await f.inTenant((trx) => subledgerEntriesOf(trx, c.entryId ?? ''));
    expect(payment).toMatchObject({ originalAmount: '2750.0000', openAmount: '0.0000' });

    // The batch shows its confirmation; status is still released (the confirmation is a fact).
    const after = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, batchId));
    expect(after.status).toBe('released');
    expect(after.confirmation).toMatchObject({
      entryId: c.entryId,
      confirmedOn: '2026-11-28',
      bankReference: 'CBA-20261128-001',
      confirmedBy: treasurer,
    });

    // A repeat (the bank file re-imported, a double click) changes nothing.
    const again = await confirm(batchId, '2026-11-29', 'other');
    expect(again).toMatchObject({ entryId: c.entryId, confirmedOn: '2026-11-28', replayed: true });
    expect(await paymentEntries()).toHaveLength(1);
  });

  it('SS-UC06-07 one entry per batch: one AP_CONTROL line per bill with its supplier, one bank line for the total', async () => {
    const a = await p.addSupplier('Alpha Paper Pty Ltd', 72);
    const b = await p.addSupplier('Beta Freight Pty Ltd', 72);
    const a1 = await p.postBill(a, 'A-1', '120.10', '2026-12-04');
    const a2 = await p.postBill(a, 'A-2', '80.05', '2026-12-04');
    const b1 = await p.postBill(b, 'B-1', '999.99', '2026-12-04');
    const batchId = await releasedBatch('2026-12-04');
    const before = (await paymentEntries()).length;
    const c = await confirm(batchId, '2026-12-04');
    expect(await paymentEntries()).toHaveLength(before + 1);
    const rows = await linesOf(c.entryId ?? '');
    expect(rows).toEqual([
      { code: '2000', debit: '120.1000', credit: '0.0000', party_id: a },
      { code: '2000', debit: '80.0500', credit: '0.0000', party_id: a },
      { code: '2000', debit: '999.9900', credit: '0.0000', party_id: b },
      { code: '1010', debit: '0.0000', credit: '1200.1400', party_id: null },
    ]);
    for (const billId of [a1, a2, b1]) {
      const e = await f.inTenant(
        async (trx) =>
          (
            await trx
              .selectFrom('app.supplier_bill')
              .select('entry_id')
              .where('id', '=', billId)
              .executeTakeFirstOrThrow()
          ).entry_id ?? '',
      );
      const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, e));
      expect(item?.openAmount, billId).toBe('0.0000');
    }
  });

  it('two confirmations at the same time post one journal', async () => {
    const s = await p.addSupplier('Gamma Cleaning Pty Ltd', 72);
    await p.postBill(s, 'G-1', '330.00', '2026-12-11');
    const batchId = await releasedBatch('2026-12-11');
    const [x, y] = await Promise.all([
      confirm(batchId, '2026-12-11'),
      confirm(batchId, '2026-12-11'),
    ]);
    expect(x.entryId).toBe(y.entryId);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    const all = await paymentEntries();
    expect(all.filter((e) => e.source_id === batchId)).toHaveLength(1);
  });

  it('only a released batch can be confirmed, never before its payment date; nothing is written on refusal', async () => {
    const s = await p.addSupplier('Delta Hire Pty Ltd', 72);
    await p.postBill(s, 'D-1', '45.00', '2026-12-18');
    const id = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id,
        paymentDate: '2026-12-18',
        dueBy: '2026-12-18',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    const before = (await paymentEntries()).length;
    expect((await refusal(confirm(id, '2026-12-18')))?.code).toBe('NOT_CONFIRMABLE');
    await f.inTenant((trx) =>
      releasePaymentBatch(trx, { companyId: f.companyId, batchId: id, releasedBy: releaser }),
    );
    expect((await refusal(confirm(id, '2026-12-17')))?.code).toBe('INVALID_BATCH');
    expect((await refusal(confirm(id, '18/12/2026')))?.code).toBe('INVALID_BATCH');
    expect((await refusal(confirm(id, '2026-12-18', 'x'.repeat(101))))?.code).toBe('INVALID_BATCH');
    expect(
      (
        await refusal(
          f.inTenant((trx) =>
            confirmPaymentBatch(trx, {
              companyId: f.companyId,
              batchId: randomUUID(),
              confirmedOn: '2026-12-18',
            }),
          ),
        )
      )?.code,
    ).toBe('INVALID_BATCH');
    expect(await paymentEntries()).toHaveLength(before);
  });

  it('the database refuses a confirmation of an unreleased batch and cancelling a confirmed one', async () => {
    const s = await p.addSupplier('Epsilon Print Pty Ltd', 72);
    await p.postBill(s, 'E-1', '60.00', '2026-12-24');
    const batchId = await releasedBatch('2026-12-24');
    const c = await confirm(batchId, '2026-12-24');
    // Cancelling after confirmation (the money has left the bank) is refused.
    const cancel = await f
      .inTenant((trx) =>
        trx
          .updateTable('app.payment_batch')
          .set({ status: 'cancelled' })
          .where('id', '=', batchId)
          .execute(),
      )
      .then(
        () => '',
        (e: unknown) => String(e),
      );
    expect(cancel).toMatch(/confirmed/);
    // A confirmation row for a draft batch, even pointing at a real ap_payment entry, is refused.
    const s2 = await p.addSupplier('Zeta Couriers Pty Ltd', 72);
    await p.postBill(s2, 'Z-1', '70.00', '2026-12-31');
    const draft = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: draft,
        paymentDate: '2026-12-31',
        dueBy: '2026-12-31',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    const direct = await f
      .inTenant((trx) =>
        trx
          .insertInto('app.payment_batch_confirmation')
          .values({
            company_id: f.companyId,
            batch_id: draft,
            entry_id: c.entryId ?? '',
            confirmed_on: '2026-12-31',
          })
          .execute(),
      )
      .then(
        () => '',
        (e: unknown) => String(e),
      );
    expect(direct).toMatch(/released/);
  });
});
