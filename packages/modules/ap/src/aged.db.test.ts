/**
 * Aged payables (T-0077, design §8.1, DL-0290) against a real PostgreSQL as lf_app — the AP mirror
 * of T-0049's aged receivables.
 *
 * SS-PLAT-109 — every AP open item dated on or before the as-at date, at its open amount as at
 * that date (allocations after it ignored), on the AP credit side, bucketed current / 1–30 /
 * 31–60 / 61–90 / 90+ by days past due; supplier debits (unapplied payments) sit in current; a
 * bill paid by a confirmed payment batch (GP-009) drops out; the totals equal the AP control
 * balance at the date.
 *
 * Bills post through approveBill (GP-008 path); payment batches through createPaymentBatch,
 * releasePaymentBatch and confirmPaymentBatch (GP-009). The part payment and the unapplied
 * payment are raw ap_payment journals through the posting engine, allocated with the ledger's
 * allocate() — the AP control account accepts ap.* source types only (design §3.2).
 */
import { randomUUID } from 'node:crypto';
import { allocate, post, subledgerEntriesOf, subledgerReconciliation } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agedPayables } from './aged.ts';
import { approveBill, createBill, submitBill } from './bills.ts';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import { createPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let alpha = '';
let beta = '';
let gamma = '';
let clerk = '';
let releaser = '';
let treasurer = '';
const AS_OF = '2026-12-31';

const bill = (supplier: string, ref: string, amount: string, billDate: string, dueDate: string) =>
  f.inTenant(async (trx) => {
    const b = await createBill(trx, {
      companyId: f.companyId,
      partyId: supplier,
      supplierRef: ref,
      billDate,
      dueDate,
      lines: [
        { accountId: f.acct['6230'] ?? '', description: 'Supplies', amount, taxCode: 'GST-FREE' },
      ],
    });
    await submitBill(trx, { companyId: f.companyId, billId: b.billId });
    return approveBill(trx, { companyId: f.companyId, billId: b.billId });
  });

/** A supplier payment not made through a batch: debit AP control (with the supplier), credit bank. */
const payment = (supplier: string, date: string, amount: string) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate: date,
      sourceType: 'ap_payment',
      lines: [
        { account: { role: 'AP_CONTROL' }, debit: amount, partyId: supplier },
        { account: { id: f.acct['1010'] ?? '' }, credit: amount },
      ],
    }),
  );

const paidByBatch = async (date: string, dueBy: string) => {
  const id = randomUUID();
  await f.inTenant((trx) =>
    createPaymentBatch(trx, {
      companyId: f.companyId,
      id,
      paymentDate: date,
      dueBy,
      accountId: f.acct['1010'] ?? '',
      createdBy: clerk,
    }),
  );
  await f.inTenant((trx) =>
    releasePaymentBatch(trx, { companyId: f.companyId, batchId: id, releasedBy: releaser }),
  );
  await f.inTenant((trx) =>
    confirmPaymentBatch(trx, {
      companyId: f.companyId,
      batchId: id,
      confirmedOn: date,
      confirmedBy: treasurer,
    }),
  );
};

const aged = (asOf: string) =>
  f.inTenant((trx) => agedPayables(trx, { companyId: f.companyId, asOf }));

/** The AP control balance at a date on its credit side (reconciliation amounts are debit +). */
const apControl = async (asOf: string) => {
  const recs = await f.inTenant((trx) =>
    subledgerReconciliation(trx, { companyId: f.companyId, asOf }),
  );
  const ap = recs.find((r) => r.controlRole === 'AP_CONTROL');
  expect(ap?.reconciled).toBe(true);
  return ap?.controlBalance.startsWith('-')
    ? ap.controlBalance.slice(1)
    : `-${ap?.controlBalance ?? ''}`;
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007702');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
  treasurer = await f.addUser('approver');
  alpha = await p.addSupplier('Alpha Aged Supplies Pty Ltd', null);
  beta = await p.addSupplier('Beta Aged Supplies Pty Ltd', null);
  gamma = await p.addSupplier('Gamma Aged Supplies Pty Ltd', 72);

  await bill(alpha, 'A1', '1000.00', '2026-12-01', '2026-12-20'); // 11 days → 1–30
  await bill(alpha, 'A2', '500.00', '2026-12-20', '2027-01-15'); // not yet due → current
  const a3 = await bill(alpha, 'A3', '300.00', '2026-10-01', '2026-10-15'); // 77 days → 61–90
  const part = await payment(alpha, '2026-11-20', '100.0000'); // part payment of A3
  await f.inTenant(async (trx) => {
    const [billItem] = await subledgerEntriesOf(trx, a3.entryId ?? '');
    const [payItem] = await subledgerEntriesOf(trx, part.entryId);
    await allocate(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      fromEntryId: payItem?.id ?? '',
      toEntryId: billItem?.id ?? '',
      amount: '100.0000',
      allocationDate: '2026-11-20',
    });
  });

  await bill(beta, 'B1', '800.00', '2026-07-15', '2026-08-01'); // 152 days → 90+
  await payment(beta, '2026-12-30', '200.0000'); // unapplied supplier debit → current
  await bill(beta, 'B2', '999.00', '2027-01-02', '2027-01-30'); // dated after AS_OF

  await bill(gamma, 'C1', '400.00', '2026-11-01', '2026-11-05'); // paid 10 Nov
  await bill(gamma, 'C2', '600.00', '2026-11-01', '2026-11-25'); // paid after AS_OF → 31–60
  await paidByBatch('2026-11-10', '2026-11-10');
  await paidByBatch('2027-01-05', '2026-11-30');
}, 240_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-109 aged AP buckets sum to the AP control balance at date [T-0077]', () => {
  it('SS-PLAT-109 ages every open AP item by due date as at 31 Dec 2026 on the credit side; the buckets sum to AP control', async () => {
    const r = await aged(AS_OF);
    expect(r.asOf).toBe(AS_OF);
    expect(r.rows.map((x) => x.partyName)).toEqual([
      'Alpha Aged Supplies Pty Ltd',
      'Beta Aged Supplies Pty Ltd',
      'Gamma Aged Supplies Pty Ltd',
    ]);
    const byParty = Object.fromEntries(r.rows.map((x) => [x.partyId, x]));
    expect(byParty[alpha]).toEqual({
      partyId: alpha,
      partyName: 'Alpha Aged Supplies Pty Ltd',
      current: '500.0000',
      days1to30: '1000.0000',
      days31to60: '0.0000',
      days61to90: '200.0000',
      days90plus: '0.0000',
      total: '1700.0000',
    });
    expect(byParty[beta]).toMatchObject({
      current: '-200.0000',
      days90plus: '800.0000',
      total: '600.0000',
    });
    expect(byParty[gamma]).toMatchObject({
      current: '0.0000',
      days31to60: '600.0000',
      total: '600.0000',
    });
    expect(r.totals).toEqual({
      current: '300.0000',
      days1to30: '1000.0000',
      days31to60: '600.0000',
      days61to90: '200.0000',
      days90plus: '800.0000',
      total: '2900.0000',
    });
    expect(await apControl(AS_OF)).toBe(r.totals.total);
  });

  it('SS-PLAT-109 as at an earlier date: later bills, payments and allocations are ignored', async () => {
    const r = await aged('2026-11-15');
    const byParty = Object.fromEntries(r.rows.map((x) => [x.partyId, x]));
    expect(byParty[alpha]).toMatchObject({ days31to60: '300.0000', total: '300.0000' });
    expect(byParty[beta]).toMatchObject({ days90plus: '800.0000', total: '800.0000' });
    expect(byParty[gamma]).toMatchObject({ current: '600.0000', total: '600.0000' });
    expect(r.totals.total).toBe('1700.0000');
    expect(await apControl('2026-11-15')).toBe('1700.0000');
  });

  it('SS-PLAT-109 leaves other companies out and refuses a malformed date', async () => {
    const r = await f.inTenant((trx) =>
      agedPayables(trx, { companyId: f.otherCompanyId, asOf: AS_OF }),
    );
    expect(r.rows).toEqual([]);
    expect(r.totals.total).toBe('0.0000');
    await expect(aged('31/12/2026')).rejects.toBeInstanceOf(RangeError);
  });
});
