/**
 * Supplier payment batches (T-0054, UC-06, design §6.5 rule 1, DL-0281), against a real PostgreSQL
 * as lf_app: a batch holds one payment per due bill at its open amount; suppliers whose bank
 * details are still cooling off (or missing) are excluded with the reason; above the two-releaser
 * threshold a batch needs two releases. Who may release (SoD) and step-up are the API's (see
 * apps/api/src/ap/payment-batches.db.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPaymentBatch,
  getPaymentBatch,
  releasePaymentBatch,
  type PaymentBatchError,
} from './payment-batches.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaserA = '';
let releaserB = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005401');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaserA = await f.addUser('approver');
  releaserB = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const build = (id: string, dueBy: string) =>
  f.inTenant((trx) =>
    createPaymentBatch(trx, {
      companyId: f.companyId,
      id,
      paymentDate: dueBy,
      dueBy,
      accountId: f.acct['1010'] ?? '',
      createdBy: clerk,
    }),
  );
const release = (batchId: string, by: string) =>
  f.inTenant((trx) =>
    releasePaymentBatch(trx, { companyId: f.companyId, batchId, releasedBy: by }),
  );
const refusal = (pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as PaymentBatchError,
  );

describe('SS-UC06-01: Batch created from 12 due bills', () => {
  it('SS-UC06-01 twelve posted bills due this week become twelve payments totalling their open amounts', async () => {
    const amounts: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const s = await p.addSupplier(`Weekly Supplier ${String(i)}`, 72);
      const amount = `${String(100 * i)}.${String(10 + i)}`;
      amounts.push(amount);
      await p.postBill(s, `WK-${String(i)}`, amount, '2026-11-06');
    }
    // Not yet due: stays out of the batch.
    const later = await p.addSupplier('Next Month Pty Ltd', 72);
    await p.postBill(later, 'NM-1', '999.00', '2026-12-15');

    const id = randomUUID();
    const b = await build(id, '2026-11-06');
    expect(b).toMatchObject({
      batchId: id,
      status: 'draft',
      batchNo: expect.stringMatching(/^PB-/),
      paymentCount: 12,
      total: '7801.9800',
      releasesRequired: 1,
      excluded: [],
    });
    expect(b.payments).toHaveLength(12);
    expect(b.payments.map((x) => x.amount).sort()).toEqual(amounts.map((a) => `${a}00`).sort());
    // Replay with the same id returns the stored batch.
    expect(await build(id, '2026-11-06')).toMatchObject({
      batchId: id,
      replayed: true,
      total: '7801.9800',
    });
    // A bill is paid by one live batch only: nothing is left due.
    expect((await refusal(build(randomUUID(), '2026-11-06')))?.code).toBe('NOTHING_DUE');
  });
});

describe('SS-UC06-05: Recently changed bank details excluded with reason', () => {
  it('SS-UC06-05 a supplier verified 3 hours ago is excluded with BANK_DETAILS_COOLING_OFF; one without details with NO_VERIFIED_BANK_DETAILS', async () => {
    const recent = await p.addSupplier('Changed Recently Pty Ltd', 3);
    const none = await p.addSupplier('No Details Pty Ltd', null);
    const settled = await p.addSupplier('Settled Pty Ltd', 30);
    const billRecent = await p.postBill(recent, 'CR-1', '400.00', '2026-11-13');
    const billNone = await p.postBill(none, 'ND-1', '300.00', '2026-11-13');
    await p.postBill(settled, 'ST-1', '200.00', '2026-11-13');
    const b = await build(randomUUID(), '2026-11-13');
    expect(b).toMatchObject({ paymentCount: 1, total: '200.0000' });
    expect(b.excluded).toEqual([
      expect.objectContaining({
        billId: billRecent,
        partyId: recent,
        amount: '400.0000',
        reason: 'BANK_DETAILS_COOLING_OFF',
        payableFrom: expect.any(Date),
      }),
      expect.objectContaining({
        billId: billNone,
        partyId: none,
        amount: '300.0000',
        reason: 'NO_VERIFIED_BANK_DETAILS',
        payableFrom: null,
      }),
    ]);
    // Once the cooling-off has passed the excluded bill is still due and can be paid.
    const stored = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, b.batchId));
    expect(stored.excluded.map((x) => x.reason)).toEqual([
      'BANK_DETAILS_COOLING_OFF',
      'NO_VERIFIED_BANK_DETAILS',
    ]);
  });
});

describe('SS-UC06-04: Batch over $10,000 needs two releasers', () => {
  it('SS-UC06-04 a $25,000 batch is partially released after one release and released after a second', async () => {
    const s1 = await p.addSupplier('Big Supplier One', 48);
    const s2 = await p.addSupplier('Big Supplier Two', 48);
    await p.postBill(s1, 'BIG-1', '15000.00', '2026-11-20');
    await p.postBill(s2, 'BIG-2', '10000.00', '2026-11-20');
    const b = await build(randomUUID(), '2026-11-20');
    expect(b).toMatchObject({ total: '25000.0000', releasesRequired: 2, status: 'draft' });
    expect(await release(b.batchId, releaserA)).toMatchObject({
      status: 'partially_released',
      releases: [{ releasedBy: releaserA }],
    });
    expect(await release(b.batchId, releaserB)).toMatchObject({
      status: 'released',
      releases: [{ releasedBy: releaserA }, { releasedBy: releaserB }],
    });
    expect((await refusal(release(b.batchId, releaserB)))?.code).toBe('NOT_RELEASABLE');
  });

  it('at or below the threshold one release completes the batch', async () => {
    const s = await p.addSupplier('Small Supplier', 48);
    await p.postBill(s, 'SM-1', '10000.00', '2026-11-27');
    const b = await build(randomUUID(), '2026-11-27');
    expect(b).toMatchObject({ total: '10000.0000', releasesRequired: 1 });
    expect(await release(b.batchId, releaserA)).toMatchObject({ status: 'released' });
  });

  it('refuses a batch from a non-bank account or with a bad date', async () => {
    const bad = await refusal(
      f.inTenant((trx) =>
        createPaymentBatch(trx, {
          companyId: f.companyId,
          id: randomUUID(),
          paymentDate: '2026-11-30',
          dueBy: '2026-11-30',
          accountId: f.acct['6230'] ?? '',
        }),
      ),
    );
    expect(bad?.code).toBe('INVALID_BATCH');
    const date = await refusal(
      f.inTenant((trx) =>
        createPaymentBatch(trx, {
          companyId: f.companyId,
          id: randomUUID(),
          paymentDate: '30/11/2026',
          dueBy: '2026-11-30',
          accountId: f.acct['1010'] ?? '',
        }),
      ),
    );
    expect(date?.code).toBe('INVALID_BATCH');
  });
});
