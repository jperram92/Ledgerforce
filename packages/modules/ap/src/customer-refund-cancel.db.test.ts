/**
 * Cancelling a requested bank refund (T-0207, UC-11, RQ-0189, ADR-0107), against a real
 * PostgreSQL as lf_app. A requested `bank_batch` refund, approved or not, that no live payment
 * batch pays is cancelled and stops counting as requested. One that a live batch pays (draft,
 * released or confirmed) is refused: by the module (NOT_CANCELLABLE, naming the batch) and by
 * the 0055 guard. A cancelled refund can never be put into a batch (migration 0084 guard), also
 * when the batch build and the cancel race.
 */
import { randomUUID } from 'node:crypto';
import {
  approveCreditNote,
  approveCustomerRefund,
  approveInvoice,
  cancelCustomerRefund,
  createCreditNote,
  createCustomerRefund,
  createDraftInvoice,
  customerCredit,
  getCustomerRefund,
  recordReceipt,
  type DocumentOutbox,
  type RefundError,
} from '@ledgerforce/ar';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import { createPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaser = '';
let treasurer = '';
let refundApprover = '';
const outbox: DocumentOutbox = { publish: async () => {} };

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020701');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ar_clerk');
  releaser = await f.addUser('approver');
  treasurer = await f.addUser('approver');
  refundApprover = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** A paid 1,375.00 invoice and a 220.00 credit note on `day`: the party holds a 220.00 credit. */
async function customerWithCredit(name: string, day: string) {
  const party = await p.addSupplier(name, 72, 'customer');
  const inv = await f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: party,
        issueDate: day,
        lines: [
          {
            productProfileId: p.profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox },
    );
    return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
  });
  await f.inTenant((trx) =>
    recordReceipt(trx, {
      companyId: f.companyId,
      partyId: party,
      receiptDate: day,
      amount: '1375.00',
      method: 'eft',
      depositTo: { accountId: f.acct['1010'] ?? '' },
      idempotencyKey: `receipt-${inv.invoiceId}`,
      allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
    }),
  );
  await f.inTenant(async (trx) => {
    const d = await createCreditNote(trx, {
      companyId: f.companyId,
      invoiceId: inv.invoiceId,
      issueDate: day,
      reasonCode: 'scope_reduction',
      lines: [{ invoiceLineNo: 1, amount: '200.00' }],
    });
    return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
  });
  return party;
}

const request = (party: string, amount: string, refundDate: string) =>
  f.inTenant((trx) =>
    createCustomerRefund(trx, {
      companyId: f.companyId,
      id: randomUUID(),
      partyId: party,
      refundDate,
      amount,
      method: 'bank_batch',
      createdBy: clerk,
    }),
  );

const approve = (refundId: string) =>
  f.inTenant((trx) =>
    approveCustomerRefund(trx, { companyId: f.companyId, refundId, approvedBy: refundApprover }),
  );

const cancel = (refundId: string) =>
  f.inTenant((trx) => cancelCustomerRefund(trx, { companyId: f.companyId, refundId }));

const read = (refundId: string) =>
  f.inTenant((trx) => getCustomerRefund(trx, f.companyId, refundId));

const credit = (party: string) => f.inTenant((trx) => customerCredit(trx, f.companyId, party));

const draftBatch = async (day: string) => {
  const id = randomUUID();
  const b = await f.inTenant((trx) =>
    createPaymentBatch(trx, {
      companyId: f.companyId,
      id,
      paymentDate: day,
      dueBy: day,
      accountId: f.acct['1010'] ?? '',
      createdBy: clerk,
    }),
  );
  return b;
};

const refusal = (pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as RefundError,
  );

/** The status move as lf_app, straight at the table: only the 0055 guard decides. */
const rawCancel = (refundId: string) =>
  f
    .inTenant((trx) =>
      sql`UPDATE app.customer_refund SET status = 'cancelled' WHERE id = ${refundId}::uuid`.execute(
        trx,
      ),
    )
    .then(
      () => 'updated',
      (e: unknown) => String(e),
    );

describe('SS-UC11-18: a requested bank refund no live payment batch pays is cancelled', () => {
  it('SS-UC11-18 an approved bank refund outside any batch is cancelled, stops counting as requested, and a repeat replays', async () => {
    const party = await customerWithCredit('Cancel Approved Pty Ltd', '2026-11-02');
    const r = await request(party, '120.00', '2026-11-03');
    await approve(r.refundId);
    expect(await credit(party)).toEqual({
      balance: '-220.0000',
      requested: '120.0000',
      available: '100.0000',
    });
    expect((await read(r.refundId)).paymentBatch).toBeNull();
    const done = await cancel(r.refundId);
    expect(done).toMatchObject({
      refundId: r.refundId,
      status: 'cancelled',
      approval: 'approved',
      replayed: false,
      entryId: null,
    });
    expect(await credit(party)).toEqual({
      balance: '-220.0000',
      requested: '0.0000',
      available: '220.0000',
    });
    expect(await cancel(r.refundId)).toMatchObject({ status: 'cancelled', replayed: true });
    // Cancelled is final (0055 guard) and the next batch does not take it.
    const back = await f
      .inTenant((trx) =>
        sql`UPDATE app.customer_refund SET status = 'requested' WHERE id = ${r.refundId}::uuid`.execute(
          trx,
        ),
      )
      .then(
        () => 'updated',
        (e: unknown) => String(e),
      );
    expect(back).toMatch(/cannot move from cancelled to requested/);
  });

  it('SS-UC11-18 an unapproved bank request is withdrawn; it can then never be approved', async () => {
    const party = await customerWithCredit('Withdraw Pty Ltd', '2026-11-02');
    const r = await request(party, '220.00', '2026-11-03');
    expect(await cancel(r.refundId)).toMatchObject({
      status: 'cancelled',
      approval: 'pending',
      replayed: false,
    });
    expect((await credit(party)).available).toBe('220.0000');
    expect((await refusal(approve(r.refundId)))?.code).toBe('NOT_APPROVABLE');
  });
});

describe('SS-UC11-19: a bank refund a live payment batch pays is never cancelled', () => {
  it('SS-UC11-19 in a draft batch: NOT_CANCELLABLE naming the batch, the 0055 guard refuses too, the view shows the batch', async () => {
    const party = await customerWithCredit('Draft Batch Pty Ltd', '2026-11-04');
    const r = await request(party, '220.00', '2026-11-05');
    await approve(r.refundId);
    const b = await draftBatch('2026-11-05');
    expect(b.status).toBe('draft');
    expect(b.refunds.map((x) => x.refundId)).toEqual([r.refundId]);
    expect((await read(r.refundId)).paymentBatch).toEqual({
      batchId: b.batchId,
      batchNo: b.batchNo,
      status: 'draft',
    });
    const e = await refusal(cancel(r.refundId));
    expect(e?.code).toBe('NOT_CANCELLABLE');
    expect(e?.message).toContain(b.batchNo);
    expect(e?.message).toMatch(/draft/);
    expect(await rawCancel(r.refundId)).toMatch(
      /is in a live payment batch and cannot be cancelled/,
    );
    expect(await read(r.refundId)).toMatchObject({ status: 'requested' });
    expect((await credit(party)).requested).toBe('220.0000');
  });

  it('SS-UC11-19 in a released batch, and once the batch is confirmed (paid): NOT_CANCELLABLE', async () => {
    const party = await customerWithCredit('Released Batch Pty Ltd', '2026-11-06');
    const r = await request(party, '220.00', '2026-11-07');
    await approve(r.refundId);
    const b = await draftBatch('2026-11-07');
    await f.inTenant((trx) =>
      releasePaymentBatch(trx, {
        companyId: f.companyId,
        batchId: b.batchId,
        releasedBy: releaser,
      }),
    );
    expect((await read(r.refundId)).paymentBatch).toMatchObject({ status: 'released' });
    const released = await refusal(cancel(r.refundId));
    expect(released?.code).toBe('NOT_CANCELLABLE');
    expect(released?.message).toMatch(/released/);
    expect(await rawCancel(r.refundId)).toMatch(/is in a live payment batch/);

    await f.inTenant((trx) =>
      confirmPaymentBatch(trx, {
        companyId: f.companyId,
        batchId: b.batchId,
        confirmedOn: '2026-11-08',
        confirmedBy: treasurer,
      }),
    );
    expect(await read(r.refundId)).toMatchObject({
      status: 'paid',
      paymentBatch: { batchId: b.batchId, status: 'confirmed' },
    });
    expect((await refusal(cancel(r.refundId)))?.code).toBe('NOT_CANCELLABLE');
  });

  it('SS-UC11-19 a payable batch line for a cancelled refund is refused (migration 0084 guard)', async () => {
    const party = await customerWithCredit('Late Line Pty Ltd', '2026-11-09');
    const r = await request(party, '220.00', '2026-11-10');
    await approve(r.refundId);
    // A draft batch built from a bill, so there is a batch to add a line to.
    const s = await p.addSupplier('Late Line Freight Pty Ltd', 72);
    await p.postBill(s, 'LL-1', '30.00', '2026-11-09');
    const b = await draftBatch('2026-11-09');
    expect(b.refunds).toEqual([]);
    await cancel(r.refundId);
    const bank = (
      await f.admin.query<{ id: string }>(
        `SELECT id::text FROM app.party_bank_account WHERE tenant_id = $1 AND party_id = $2`,
        [f.tenantId, party],
      )
    ).rows[0]?.id;
    const line = await f
      .inTenant((trx) =>
        sql`INSERT INTO app.payment_batch_refund
              (company_id, batch_id, line_no, refund_id, party_id, amount, bank_account_id)
            VALUES (${f.companyId}::uuid, ${b.batchId}::uuid, 9000, ${r.refundId}::uuid,
                    ${party}::uuid, 220, ${bank ?? null}::uuid)`.execute(trx),
      )
      .then(
        () => 'inserted',
        (e: unknown) => String(e),
      );
    expect(line).toMatch(/is cancelled and cannot be paid in a batch/);
  });

  it('SS-UC11-19 a batch build and a cancel racing: the cancel waits for the line and is refused by the 0055 guard', async () => {
    const party = await customerWithCredit('Race Pty Ltd', '2026-11-11');
    const r = await request(party, '220.00', '2026-11-12');
    await approve(r.refundId);
    const s = await p.addSupplier('Race Freight Pty Ltd', 72);
    await p.postBill(s, 'RF-1', '30.00', '2026-11-11');
    const b = await draftBatch('2026-11-11');
    const bank = (
      await f.admin.query<{ id: string }>(
        `SELECT id::text FROM app.party_bank_account WHERE tenant_id = $1 AND party_id = $2`,
        [f.tenantId, party],
      )
    ).rows[0]?.id;
    let inserted!: () => void;
    let commit!: () => void;
    const lineInserted = new Promise<void>((res) => (inserted = res));
    const mayCommit = new Promise<void>((res) => (commit = res));
    // The batch build's transaction: the line is in, not yet committed.
    const build = f.inTenant(async (trx) => {
      await sql`INSERT INTO app.payment_batch_refund
                  (company_id, batch_id, line_no, refund_id, party_id, amount, bank_account_id)
                VALUES (${f.companyId}::uuid, ${b.batchId}::uuid, 9001, ${r.refundId}::uuid,
                        ${party}::uuid, 220, ${bank ?? null}::uuid)`.execute(trx);
      inserted();
      await mayCommit;
    });
    await lineInserted;
    // The cancel cannot see the uncommitted line, so the module lets it through to the UPDATE,
    // which waits for the line's row lock and then meets the committed line in the guard.
    const cancelling = refusal(cancel(r.refundId));
    await new Promise((res) => setTimeout(res, 300));
    commit();
    await build;
    const e = await cancelling;
    expect(String(e)).toMatch(/is in a live payment batch and cannot be cancelled/);
    expect(await read(r.refundId)).toMatchObject({
      status: 'requested',
      paymentBatch: { batchId: b.batchId, status: 'draft' },
    });
  });
});
