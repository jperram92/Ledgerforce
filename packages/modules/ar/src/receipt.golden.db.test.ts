/**
 * Golden posting GP-002 produced by the customer-receipt code (T-0046, RQ-0112). The producer
 * posts INV-000123 through the sales-invoice code (the GP-001 document, as in
 * invoice.golden.db.test.ts), then records the scenario's receipt — 2026-11-15, $1,375.00 by EFT
 * into the operating bank account, allocated to INV-000123 — with recordReceipt(). The stored
 * journal must equal the Approved golden line for line (runGolden).
 *
 * SS-UC03-07 — the journal equals GP-002, the receipt and the invoice open items are both 0.00
 *   (allocation 1,375.00, fx_difference 0.00) and the invoice is Paid.
 * GP-002 Tax/BAS — cash basis: G1 +1,375.00, 1A +125.00 in the period of 2026-11-15 and nothing
 *   on the invoice date, read by the T-0035 BAS report from the receipt's allocation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import {
  expectedLines,
  goldenModeFrom,
  parseGoldenPostings,
  planGoldenRun,
  repoGoldenGate,
  runGolden,
  type GoldenPosting,
  type GoldenProducer,
  type GoldenWorld,
  type LineView,
} from '@ledgerforce/ledger/golden';
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { storedJournal } from '@ledgerforce/ledger/testing';
import { createGoldenWorld, type GoldenFixture } from '@ledgerforce/ledger/testing/golden-world';
import { basReport } from '@ledgerforce/tax';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReceipt, invoicePaymentStatus, recordReceipt } from './receipts.ts';
import { autoApproveSalesInvoice, createSalesInvoice } from './sales-invoices.ts';
import {
  addBillingTo,
  makeCustomer,
  setupInvoicing,
  type InvoiceWorld,
} from './testing/invoice-world.ts';
import { setupReceipts, type ReceiptWorld } from './testing/receipt-world.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8')).filter(
  (gp) => gp.id === 'GP-002',
);
const plan = planGoldenRun(postings, goldenModeFrom(process.env), repoGoldenGate(REPO));
const AUTO = { autoApprove: true, threshold: '2000.0000' } as const;

let g: GoldenFixture;
let w: InvoiceWorld;
let rw: ReceiptWorld;
let world: GoldenWorld;
let acme: string;
const produced: { invoiceId: string; receiptId: string; entryId: string }[] = [];

const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
  withTenant(g.fixture.db, g.fixture.tenantId, fn);

/** INV-000123 (GP-001's document), posted through the sales-invoice code. */
async function postInvoice(trx: Transaction<Database>): Promise<string> {
  const companyId = g.fixture.companyId;
  const { id } = await createSalesInvoice(trx, {
    input: {
      companyId,
      partyId: acme,
      invoiceDate: '2026-11-05',
      dueDate: '2026-11-19',
      amountsAre: 'exclusive',
      lines: [
        {
          productId: w.products.PROFESSIONAL_SERVICES,
          description: 'Professional services',
          amount: '1000.00',
        },
        { productId: w.products.SUBSCRIPTION, description: 'Subscription', amount: '250.00' },
      ],
    },
    createdBy: null,
    idempotencyKey: `golden:GP-002:invoice:${randomUUID()}`,
  });
  const r = await autoApproveSalesInvoice(trx, { id, settings: AUTO });
  if (r.outcome !== 'posted') throw new Error(`INV-000123 was not posted (${r.reason})`);
  return id;
}

const produce: GoldenProducer = async (gp: GoldenPosting, index: number) => {
  const expected = expectedLines(gp, index, world);
  const companyId = g.fixture.companyId;
  const result = await inTenant(async (trx) => {
    const invoiceId = await postInvoice(trx);
    // GP-002 scenario: 2026-11-15, $1,375.00 by EFT into the operating account, allocated to INV-000123.
    const r = await recordReceipt(trx, {
      input: {
        companyId,
        partyId: acme,
        receiptDate: '2026-11-15',
        amount: '1375.00',
        method: 'eft',
        depositTo: { kind: 'bank', bankAccountId: rw.operatingBankAccountId },
        reference: 'INV-000123',
        allocations: [{ invoiceId, amount: '1375.00' }],
      },
      idempotencyKey: `golden:GP-002:${String(index)}:${randomUUID()}`,
    });
    return {
      invoiceId,
      receiptId: r.receiptId,
      entryId: r.entryId,
      journal: await storedJournal(trx, r.entryId),
    };
  });
  produced.push({
    invoiceId: result.invoiceId,
    receiptId: result.receiptId,
    entryId: result.entryId,
  });
  const actual: LineView[] = result.journal.lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    accountLabel: l.accountId,
    debit: l.debit,
    credit: l.credit,
    taxCodeId: l.taxCodeId,
    taxLabel: l.taxCodeId,
    taxAmount: l.taxAmount,
    partyId: l.partyId,
    partyLabel: l.partyId === null ? null : world.partyLabel(l.partyId),
  }));
  return { expected, actual };
};

beforeAll(async () => {
  g = await createGoldenWorld('01900000-0000-7000-8000-000000004602');
  const companyId = g.fixture.companyId;
  const party = g.world.partyId('Acme');
  if (party === undefined) throw new Error('golden world has no Acme');
  acme = party;
  ({ w, rw } = await inTenant(async (trx) => {
    const iw = await setupInvoicing(trx, companyId);
    await makeCustomer(trx, companyId, acme);
    await addBillingTo(trx, companyId, acme);
    return { w: iw, rw: await setupReceipts(trx, companyId) };
  }));
  world = g.world;
});

afterAll(async () => {
  await g?.close();
});

describe('T-0046 golden posting GP-002 produced by the customer-receipt code', () => {
  it('GP-002 is Approved, in phase and runs (not PENDING)', () => {
    expect(plan.map((p) => [p.gp.id, p.label, p.run])).toEqual([['GP-002', 'APPROVED', true]]);
  });

  it('SS-UC03-07: Bank-transfer receipt posts GP-002', async () => {
    const p = plan.find((x) => x.gp.id === 'GP-002');
    if (!p) throw new Error('GP-002 missing from postings.md');
    // The golden's bank:OPERATING is the company bank account's GL account.
    expect(world.account({ kind: 'bank', name: 'OPERATING' }).accountId).toBe(
      rw.operatingGlAccountId,
    );
    const outcome = await runGolden(p, produce);
    expect(outcome.status, outcome.report).toBe('PASS');

    const doc = produced[0];
    if (!doc) throw new Error('GP-002 produced nothing');
    const { receipt, status } = await inTenant(async (trx) => ({
      receipt: await getReceipt(trx, doc.receiptId),
      status: await invoicePaymentStatus(trx, doc.invoiceId),
    }));
    // Subledger: receipt and invoice open 0.00; allocation 1,375.00, fx_difference 0.00 → Paid.
    expect(receipt).toMatchObject({
      amount: '1375.0000',
      unallocated: '0.0000',
      sourceEntryId: doc.entryId,
      allocations: [
        { invoiceId: doc.invoiceId, amount: '1375.0000', fxDifference: '0.0000', reversed: false },
      ],
    });
    expect(status).toEqual({
      invoiceId: doc.invoiceId,
      status: 'paid',
      total: '1375.0000',
      openAmount: '0.0000',
    });
    const rec = await inTenant((trx) =>
      subledgerReconciliation(trx, { companyId: g.fixture.companyId }),
    );
    expect(rec.find((r) => r.controlRole === 'AR_CONTROL')?.reconciled).toBe(true);
  });

  it('GP-002 Tax/BAS: cash basis reports G1 1,375.00 and 1A 125.00 in the receipt period only', async () => {
    const companyId = g.fixture.companyId;
    const cash = (from: string, to: string) =>
      inTenant((trx) => basReport(trx, { companyId, from, to, basis: 'cash' }));
    const onReceipt = await cash('2026-11-15', '2026-11-15');
    expect(onReceipt.labels).toMatchObject({ G1: '1375.00', '1A': '125.00' });
    const onInvoice = await cash('2026-11-05', '2026-11-05');
    expect(onInvoice.labels).toMatchObject({ G1: '0.00', '1A': '0.00' });
  });
});
