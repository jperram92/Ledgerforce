/**
 * Customer receipts and allocations against a real PostgreSQL as lf_app (T-0046, design §3.8
 * row 2, §3.2 allocation, UC-03 A1/A2; RQ-0112; migration 0039). A receipt posts only through
 * the posting engine (source type ar_receipt, key ar_receipt:<id>: Dr bank or undeposited funds /
 * Cr AR control) and is allocated through the ledger's allocate(); GP-002 line-for-line equality
 * is proved in receipt.golden.db.test.ts.
 *
 * SS-UC03-08 — a 375.00 receipt on INV-000123 (1,375.00) leaves it Partially paid with open
 *   amount 1,000.00, and AR subledger = AR control.
 * SS-PLAT-150 — one receipt allocated to many invoices; an over-payment leaves an unallocated
 *   credit that is allocated later; undeposited funds (GP-002 variant).
 * SS-PLAT-151 — unallocate only by reversal: a negative allocation is appended, the journal is
 *   untouched, the invoice status is recomputed; a second unallocate is refused.
 * SS-PLAT-152 — preview shows the journal and the allocation plan and writes nothing.
 * SS-PLAT-153 — refusals (no allocation, over-allocation, more than received, another party's or
 *   an unposted invoice, a card or malformed receipt, an unknown bank account) write nothing.
 * SS-PLAT-154 — idempotent replay; the receipt document is immutable and must name the engine's
 *   ar_receipt posting of it (database guard).
 */
import {
  createLedgerFixture,
  databaseFingerprint,
  storedJournal,
  type LedgerFixture,
} from '@ledgerforce/ledger/testing';
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ReceiptError,
  allocateReceipt,
  getReceipt,
  invoicePaymentStatus,
  previewReceipt,
  recordReceipt,
  unallocateReceipt,
  type ReceiptInput,
} from './receipts.ts';
import { autoApproveSalesInvoice, createSalesInvoice } from './sales-invoices.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';
import { setupReceipts, type ReceiptWorld } from './testing/receipt-world.ts';

let f: LedgerFixture;
let w: InvoiceWorld;
let rw: ReceiptWorld;
let clerk: string;
let acme: string;
let beta: string;

const AUTO = { autoApprove: true, threshold: '100000.0000' } as const;

/** A posted GP-001-shaped invoice (1,375.00 incl. GST, or `net` + 10 % GST). */
async function invoice(partyId: string, net = '1250.00', date = '2026-11-05'): Promise<string> {
  return f.inTenant(async (trx) => {
    const { id } = await createSalesInvoice(trx, {
      input: {
        companyId: f.companyId,
        partyId,
        invoiceDate: date,
        dueDate: '2026-11-30',
        amountsAre: 'exclusive',
        lines: [{ productId: w.products.PROFESSIONAL_SERVICES, amount: net }],
      },
      createdBy: clerk,
      idempotencyKey: randomUUID(),
    });
    const r = await autoApproveSalesInvoice(trx, { id, settings: AUTO });
    if (r.outcome !== 'posted') throw new Error(`invoice not posted: ${r.reason}`);
    return id;
  });
}

async function draftInvoice(partyId: string): Promise<string> {
  return f.inTenant(async (trx) => {
    const { id } = await createSalesInvoice(trx, {
      input: {
        companyId: f.companyId,
        partyId,
        invoiceDate: '2026-11-05',
        dueDate: '2026-11-30',
        lines: [{ productId: w.products.PROFESSIONAL_SERVICES, amount: '100.00' }],
      },
      createdBy: clerk,
      idempotencyKey: randomUUID(),
    });
    return id;
  });
}

const receiptInput = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  companyId: f.companyId,
  partyId: acme,
  receiptDate: '2026-11-15',
  amount: '1375.00',
  method: 'eft',
  depositTo: { kind: 'bank', bankAccountId: rw.operatingBankAccountId },
  allocations: [],
  ...over,
});

const record = (input: ReceiptInput, key = randomUUID()) =>
  f.inTenant((trx) => recordReceipt(trx, { input, idempotencyKey: key, createdBy: clerk }));
const status = (invoiceId: string) => f.inTenant((trx) => invoicePaymentStatus(trx, invoiceId));
const receipt = (id: string) => f.inTenant((trx) => getReceipt(trx, id));
const arReconciled = async () => {
  const r = await f.inTenant((trx) => subledgerReconciliation(trx, { companyId: f.companyId }));
  return r.find((x) => x.controlRole === 'AR_CONTROL');
};

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (e instanceof ReceiptError) return { code: e.code, message: e.message };
  throw new Error(`expected a ReceiptError, got ${String(e)}`);
}

const dbRefusal = (q: ReturnType<typeof sql>) =>
  f
    .inTenant((trx) => q.execute(trx))
    .then(
      () => 'accepted',
      (e: unknown) => String((e as Error).message),
    );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004601');
  clerk = await f.addUser('ar_clerk');
  ({ w, rw } = await f.inTenant(async (trx) => ({
    w: await setupInvoicing(trx, f.companyId),
    rw: await setupReceipts(trx, f.companyId),
  })));
  acme = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Acme Pty Ltd' })))
    .partyId;
  beta = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Beta Pty Ltd' })))
    .partyId;
});

afterAll(async () => {
  await f?.close();
});

describe('SS-UC03-08: Partial payment leaves the correct open amount', () => {
  it('SS-UC03-08: Partial payment leaves the correct open amount', async () => {
    const inv = await invoice(acme);
    expect(await status(inv)).toEqual({
      invoiceId: inv,
      status: 'unpaid',
      total: '1375.0000',
      openAmount: '1375.0000',
    });
    const r = await record(
      receiptInput({ amount: '375.00', allocations: [{ invoiceId: inv, amount: '375.00' }] }),
    );
    expect(r).toMatchObject({ replayed: false, unallocated: '0.0000' });
    expect(r.entryNo).toMatch(/^ARR-/);
    expect(await status(inv)).toEqual({
      invoiceId: inv,
      status: 'part_paid',
      total: '1375.0000',
      openAmount: '1000.0000',
    });
    const journal = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(journal.lines.map((l) => [l.accountId, l.debit, l.credit, l.partyId])).toEqual([
      [f.acct['1010'], '375.0000', '0.0000', null],
      [f.acct['1200'], '0.0000', '375.0000', acme],
    ]);
    const ar = await arReconciled();
    expect(ar).toMatchObject({ reconciled: true, difference: '0.0000' });
  });
});

describe('SS-PLAT-150: one receipt, many invoices; over-payment credit; undeposited funds', () => {
  it('SS-PLAT-150 allocates one receipt across two invoices (Paid + Partially paid)', async () => {
    const a = await invoice(acme);
    const b = await invoice(acme);
    const r = await record(
      receiptInput({
        amount: '2000.00',
        allocations: [
          { invoiceId: a, amount: '1375.00' },
          { invoiceId: b, amount: '625.00' },
        ],
      }),
    );
    expect(r.allocations.map((x) => [x.invoiceId, x.amount])).toEqual([
      [a, '1375.0000'],
      [b, '625.0000'],
    ]);
    expect((await status(a)).status).toBe('paid');
    expect(await status(b)).toMatchObject({ status: 'part_paid', openAmount: '750.0000' });
    expect((await receipt(r.receiptId)).unallocated).toBe('0.0000');
    expect((await arReconciled())?.reconciled).toBe(true);
  });

  it('SS-PLAT-150 an over-payment leaves an unallocated credit, allocated to a later invoice', async () => {
    const a = await invoice(acme);
    const r = await record(
      receiptInput({ amount: '1500.00', allocations: [{ invoiceId: a, amount: '1375.00' }] }),
    );
    expect(r.unallocated).toBe('125.0000');
    expect((await status(a)).status).toBe('paid');
    // The whole amount received is in the bank and credited to AR (GP-002 shape).
    const journal = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(journal.lines.map((l) => [l.debit, l.credit])).toEqual([
      ['1500.0000', '0.0000'],
      ['0.0000', '1500.0000'],
    ]);
    expect(await receipt(r.receiptId)).toMatchObject({
      amount: '1500.0000',
      unallocated: '125.0000',
      partyId: acme,
      method: 'eft',
      depositTo: 'bank',
      bankAccountId: rw.operatingBankAccountId,
    });

    const later = await invoice(acme, '500.00', '2026-11-20');
    const more = await f.inTenant((trx) =>
      allocateReceipt(trx, {
        receiptId: r.receiptId,
        allocationDate: '2026-11-20',
        allocations: [{ invoiceId: later, amount: '125.00' }],
        idempotencyKey: randomUUID(),
        createdBy: clerk,
      }),
    );
    expect(more.unallocated).toBe('0.0000');
    expect(await status(later)).toMatchObject({ status: 'part_paid', openAmount: '425.0000' });
    expect(
      await refusal(
        f.inTenant((trx) =>
          allocateReceipt(trx, {
            receiptId: r.receiptId,
            allocationDate: '2026-11-20',
            allocations: [{ invoiceId: later, amount: '0.01' }],
            idempotencyKey: randomUUID(),
          }),
        ),
      ),
    ).toMatchObject({ code: 'EXCEEDS_RECEIPT' });
    expect((await arReconciled())?.reconciled).toBe(true);
  });

  it('SS-PLAT-150 a cheque recorded before banking debits UNDEPOSITED_FUNDS (GP-002 variant)', async () => {
    const a = await invoice(acme);
    const r = await record(
      receiptInput({
        method: 'cheque',
        depositTo: { kind: 'undeposited_funds' },
        allocations: [{ invoiceId: a, amount: '1375.00' }],
      }),
    );
    const journal = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(journal.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [f.acct['1100'], '1375.0000', '0.0000'],
      [f.acct['1200'], '0.0000', '1375.0000'],
    ]);
    expect(await receipt(r.receiptId)).toMatchObject({
      depositTo: 'undeposited_funds',
      bankAccountId: null,
    });
    expect((await status(a)).status).toBe('paid');
  });
});

describe('SS-PLAT-151: unallocate only by reversal', () => {
  it('SS-PLAT-151 appends a reversing allocation; the journal is untouched; status recomputed', async () => {
    const a = await invoice(acme);
    const r = await record(receiptInput({ allocations: [{ invoiceId: a, amount: '1375.00' }] }));
    const allocationId = r.allocations[0]?.allocationId ?? '';
    const journalBefore = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    const entriesBefore = await f.countEntries();

    const u = await f.inTenant((trx) =>
      unallocateReceipt(trx, {
        receiptId: r.receiptId,
        allocationId,
        date: '2026-11-16',
        idempotencyKey: randomUUID(),
        createdBy: clerk,
      }),
    );
    expect(u).toMatchObject({ amount: '-1375.0000', reversalOfId: allocationId });
    expect(await status(a)).toMatchObject({ status: 'unpaid', openAmount: '1375.0000' });
    const doc = await receipt(r.receiptId);
    expect(doc.unallocated).toBe('1375.0000');
    expect(doc.allocations).toEqual([
      expect.objectContaining({ allocationId, amount: '1375.0000', reversed: true }),
    ]);
    expect(await f.countEntries()).toBe(entriesBefore);
    expect(await f.inTenant((trx) => storedJournal(trx, r.entryId))).toEqual(journalBefore);
    const rows = await f.admin.query<{ amount: string }>(
      `SELECT amount::text FROM app.allocation WHERE tenant_id = $1 AND (id = $2 OR reversal_of_id = $2)
        ORDER BY amount DESC`,
      [f.tenantId, allocationId],
    );
    expect(rows.rows.map((x) => x.amount)).toEqual(['1375.0000', '-1375.0000']);
    expect((await arReconciled())?.reconciled).toBe(true);

    expect(
      await refusal(
        f.inTenant((trx) =>
          unallocateReceipt(trx, {
            receiptId: r.receiptId,
            allocationId,
            date: '2026-11-16',
            idempotencyKey: randomUUID(),
          }),
        ),
      ),
    ).toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('SS-PLAT-151 refuses an allocation that is not this receipt’s', async () => {
    const a = await invoice(acme);
    const b = await invoice(acme);
    const r1 = await record(receiptInput({ allocations: [{ invoiceId: a, amount: '1375.00' }] }));
    const r2 = await record(receiptInput({ allocations: [{ invoiceId: b, amount: '1375.00' }] }));
    const foreign = r2.allocations[0]?.allocationId ?? '';
    expect(
      await refusal(
        f.inTenant((trx) =>
          unallocateReceipt(trx, {
            receiptId: r1.receiptId,
            allocationId: foreign,
            date: '2026-11-16',
            idempotencyKey: randomUUID(),
          }),
        ),
      ),
    ).toMatchObject({ code: 'NOT_THIS_RECEIPT' });
    expect((await status(b)).status).toBe('paid');
  });
});

describe('SS-PLAT-152: receipt preview writes nothing', () => {
  it('SS-PLAT-152 shows the journal and the allocation plan; the database is unchanged', async () => {
    const a = await invoice(acme);
    const before = await databaseFingerprint(f.admin);
    const p = await f.inTenant((trx) =>
      previewReceipt(
        trx,
        receiptInput({ amount: '1500.00', allocations: [{ invoiceId: a, amount: '1000.00' }] }),
      ),
    );
    expect(p.entry.sourceType).toBe('ar_receipt');
    expect(p.entry.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      [f.acct['1010'], '1500.0000', '0.0000'],
      [f.acct['1200'], '0.0000', '1500.0000'],
    ]);
    expect(p.allocations).toEqual([
      {
        invoiceId: a,
        amount: '1000.0000',
        openBefore: '1375.0000',
        openAfter: '375.0000',
        statusAfter: 'part_paid',
      },
    ]);
    expect(p.unallocated).toBe('500.0000');
    expect(await databaseFingerprint(f.admin)).toEqual(before);
  });
});

describe('SS-PLAT-153: refused receipts write nothing', () => {
  it('SS-PLAT-153 refuses with a clear code and leaves no entry, receipt or allocation', async () => {
    const a = await invoice(acme);
    const other = await invoice(beta);
    const draft = await draftInvoice(acme);
    const before = await databaseFingerprint(f.admin);
    const cases: [Partial<ReceiptInput>, string][] = [
      [{ allocations: [] }, 'NO_ALLOCATION'],
      [
        { allocations: [{ invoiceId: a, amount: '1375.01' }], amount: '2000.00' },
        'OVER_ALLOCATION',
      ],
      [{ amount: '100.00', allocations: [{ invoiceId: a, amount: '100.01' }] }, 'EXCEEDS_RECEIPT'],
      [{ allocations: [{ invoiceId: other, amount: '10.00' }] }, 'PARTY_MISMATCH'],
      [{ allocations: [{ invoiceId: draft, amount: '10.00' }] }, 'INVOICE_NOT_POSTED'],
      [
        {
          allocations: [
            { invoiceId: a, amount: '10.00' },
            { invoiceId: a, amount: '10.00' },
          ],
        },
        'DUPLICATE_INVOICE',
      ],
      [
        { method: 'card' as never, allocations: [{ invoiceId: a, amount: '1.00' }] },
        'INVALID_RECEIPT',
      ],
      [{ amount: '1.005', allocations: [{ invoiceId: a, amount: '1.00' }] }, 'INVALID_RECEIPT'],
      [{ amount: '0.00', allocations: [{ invoiceId: a, amount: '1.00' }] }, 'INVALID_RECEIPT'],
      [
        { receiptDate: '2026-11-04', allocations: [{ invoiceId: a, amount: '1.00' }] },
        'DATE_BEFORE_INVOICE',
      ],
      [
        {
          depositTo: { kind: 'bank', bankAccountId: randomUUID() },
          allocations: [{ invoiceId: a, amount: '1.00' }],
        },
        'UNKNOWN_BANK_ACCOUNT',
      ],
    ];
    for (const [over, code] of cases) {
      const r = await refusal(record(receiptInput(over)));
      expect(r.code, JSON.stringify(over)).toBe(code);
    }
    expect(await databaseFingerprint(f.admin)).toEqual(before);
    expect((await status(a)).status).toBe('unpaid');
  });
});

describe('SS-PLAT-154: idempotent and immutable receipt document', () => {
  it('SS-PLAT-154 a repeat with the same key returns the first receipt and writes nothing', async () => {
    const a = await invoice(acme);
    const key = randomUUID();
    const input = receiptInput({
      amount: '500.00',
      allocations: [{ invoiceId: a, amount: '500.00' }],
    });
    const first = await record(input, key);
    const before = await databaseFingerprint(f.admin);
    const again = await record(input, key);
    expect(again).toMatchObject({
      receiptId: first.receiptId,
      entryId: first.entryId,
      replayed: true,
    });
    expect(await databaseFingerprint(f.admin)).toEqual(before);
    expect(await status(a)).toMatchObject({ openAmount: '875.0000' });
    expect(await refusal(record({ ...input, amount: '600.00' }, key))).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('SS-PLAT-154 the receipt row never changes and must name its own ar_receipt entry', async () => {
    const a = await invoice(acme);
    const r = await record(receiptInput({ allocations: [{ invoiceId: a, amount: '1375.00' }] }));
    expect(
      await dbRefusal(sql`UPDATE app.ar_receipt SET memo = 'x' WHERE id = ${r.receiptId}`),
    ).toMatch(/permission denied|never change/);
    expect(await dbRefusal(sql`DELETE FROM app.ar_receipt WHERE id = ${r.receiptId}`)).toMatch(
      /permission denied|never/,
    );
    // A receipt row pointing at another document's entry (an invoice's) is refused.
    const invoiceEntry = await f.inTenant((trx) =>
      sql<{
        id: string;
      }>`SELECT journal_entry_id::text AS id FROM app.sales_invoice WHERE id = ${a}`.execute(trx),
    );
    const msg = await dbRefusal(
      sql`INSERT INTO app.ar_receipt (company_id, party_id, receipt_date, amount, currency, method,
            deposit_to, bank_account_id, idempotency_key, journal_entry_id)
          VALUES (${f.companyId}, ${acme}, '2026-11-15', 1375, 'AUD', 'eft', 'bank',
                  ${rw.operatingBankAccountId}, ${randomUUID()}, ${invoiceEntry.rows[0]?.id ?? null})`,
    );
    expect(msg).toMatch(/not the engine's ar_receipt posting/);
  });
});
