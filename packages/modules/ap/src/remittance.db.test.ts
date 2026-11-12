/**
 * Remittance advices (T-0057, UC-06 step 4, T-0042 recipients rule, DL-0304), real PostgreSQL as
 * lf_app and real SMTP to an in-process sink. The confirmation's `ledger.entry.posted` event
 * (written by the posting engine in the same transaction) reaches the remittance handler, which
 * emails each supplier's Remittance contact one advice listing the bills paid; a supplier without
 * a Remittance contact gets nothing (reported, not thrown); a redelivery sends nothing more.
 */
import { randomUUID } from 'node:crypto';
import { SmtpSender } from '@ledgerforce/email';
import { SmtpSink } from '@ledgerforce/email/testing';
import type { PostedEvent } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { OutboxEvent } from '@ledgerforce/outbox';
import { addContact, setContactRole } from '@ledgerforce/parties';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBill } from './bills.ts';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import { createPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import { remittanceAdviceHandler, sendBatchRemittances } from './remittance.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
const sink = new SmtpSink();
const posted: PostedEvent[] = [];
let clerk = '';
let releaser = '';

beforeAll(async () => {
  await sink.start();
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005703');
  await f.inTenant((trx) =>
    trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd' })
      .where('id', '=', f.companyId)
      .execute(),
  );
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

/** A contact of the supplier; only `remittance: true` gives it the Remittance role. */
const contact = (party: string, name: string, email: string, remittance: boolean) =>
  f.inTenant(async (trx) => {
    const c = await addContact(trx, f.companyId, party, { name, email });
    if (remittance) await setContactRole(trx, c, 'remittance', true);
  });

const asEvent = (e: PostedEvent): OutboxEvent => ({
  id: randomUUID(),
  tenantId: f.tenantId,
  companyId: e.companyId,
  topic: 'ledger.entry.posted',
  aggregateType: 'journal_entry',
  aggregateId: e.entryId,
  payload: { ...e },
  createdAt: new Date(),
});

describe('SS-UC06-08: Remittance advices emailed', () => {
  it('SS-UC06-08 each supplier Remittance contact receives one advice listing the bills paid', async () => {
    const alpha = await p.addSupplier('Alpha Paper Pty Ltd', 72);
    const beta = await p.addSupplier('Beta Freight Pty Ltd', 72);
    const gamma = await p.addSupplier('Gamma Cleaning Pty Ltd', 72);
    await contact(alpha, 'Alpha Accounts', 'Remit@Alpha.example', true);
    await contact(alpha, 'Alpha Buyer', 'buyer@alpha.example', false);
    await contact(beta, 'Beta Accounts', 'pay@beta.example', true);
    await contact(gamma, 'Gamma Office', 'office@gamma.example', false);
    const a1 = await p.postBill(alpha, 'ALPHA-INV-11', '1200.50', '2026-11-27');
    const a2 = await p.postBill(alpha, 'ALPHA-INV-12', '99.95', '2026-11-27');
    const b1 = await p.postBill(beta, 'BETA-77', '2750.00', '2026-11-27');
    await p.postBill(gamma, 'G-5', '10.00', '2026-11-27');
    const billNo = async (id: string) =>
      (await f.inTenant((trx) => getBill(trx, f.companyId, id))).billNo ?? '';

    const batchId = randomUUID();
    const batch = await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: batchId,
        paymentDate: '2026-11-27',
        dueBy: '2026-11-27',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    await f.inTenant((trx) =>
      releasePaymentBatch(trx, { companyId: f.companyId, batchId, releasedBy: releaser }),
    );
    // Nothing is emailed before the bank confirms.
    expect(sink.messages).toHaveLength(0);

    const c = await f.inTenant((trx) =>
      confirmPaymentBatch(
        trx,
        { companyId: f.companyId, batchId, confirmedOn: '2026-11-28' },
        { outbox: { enqueue: async (_t, e) => void posted.push(e) } },
      ),
    );
    expect(c.remittanceMissing).toEqual([gamma]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ sourceType: 'ap_payment', entryId: c.entryId });

    const handler = remittanceAdviceHandler({
      sender: new SmtpSender({ url: sink.url, from: 'accounts@harbour.example' }),
    });
    expect(handler.topics).toEqual(['ledger.entry.posted']);
    await f.inTenant((trx) => handler.handle(trx, asEvent(posted[0] as PostedEvent)));

    expect(sink.messages).toHaveLength(2);
    const toAlpha = sink.messages.find((m) => m.to.includes('remit@alpha.example'));
    const toBeta = sink.messages.find((m) => m.to.includes('pay@beta.example'));
    expect(toAlpha?.to).toEqual(['remit@alpha.example']);
    expect(toBeta?.to).toEqual(['pay@beta.example']);
    const body = (raw: string) => raw.replace(/=\r?\n/g, '');
    expect(toAlpha?.raw).toMatch(
      new RegExp(`^Subject: Remittance advice ${batch.batchNo} from Harbour Co Pty Ltd`, 'm'),
    );
    for (const [id, ref, amount] of [
      [a1, 'ALPHA-INV-11', '$1,200.50'],
      [a2, 'ALPHA-INV-12', '$99.95'],
    ] as const) {
      expect(body(toAlpha?.raw ?? '')).toContain(await billNo(id));
      expect(body(toAlpha?.raw ?? '')).toContain(ref);
      expect(body(toAlpha?.raw ?? '')).toContain(amount);
    }
    expect(body(toAlpha?.raw ?? '')).toMatch(/Total\s+\$1,300\.45/);
    expect(body(toAlpha?.raw ?? '')).not.toContain('BETA-77');
    expect(body(toBeta?.raw ?? '')).toContain(await billNo(b1));
    expect(body(toBeta?.raw ?? '')).toMatch(/Total\s+\$2,750\.00/);
    expect(sink.messages.some((m) => m.to.includes('office@gamma.example'))).toBe(false);
    expect(sink.messages.some((m) => m.to.includes('buyer@alpha.example'))).toBe(false);

    // Redelivery, or sending again by hand, emails nothing more.
    await f.inTenant((trx) => handler.handle(trx, asEvent(posted[0] as PostedEvent)));
    const again = await f.inTenant((trx) =>
      sendBatchRemittances(
        trx,
        { companyId: f.companyId, batchId },
        { sender: new SmtpSender({ url: sink.url, from: 'accounts@harbour.example' }) },
      ),
    );
    expect(again).toEqual({ sent: [], alreadySent: [alpha, beta], noRecipient: [gamma] });
    expect(sink.messages).toHaveLength(2);
  });

  it('other posted entries (a bill) send no remittance; an unconfirmed batch cannot be remitted', async () => {
    const before = sink.messages.length;
    const delta = await p.addSupplier('Delta Hire Pty Ltd', 72);
    await contact(delta, 'Delta Accounts', 'ar@delta.example', true);
    const handler = remittanceAdviceHandler({
      sender: new SmtpSender({ url: sink.url, from: 'accounts@harbour.example' }),
    });
    const bill = await p.postBill(delta, 'D-1', '45.00', '2026-12-04');
    const entryId = (await f.inTenant((trx) => getBill(trx, f.companyId, bill))).entryId ?? '';
    await f.inTenant((trx) =>
      handler.handle(
        trx,
        asEvent({
          companyId: f.companyId,
          entryId,
          entryNo: 'x',
          entryDate: '2026-11-02',
          sourceType: 'ap_bill',
          sourceId: bill,
          idempotencyKey: 'x',
        }),
      ),
    );
    expect(sink.messages).toHaveLength(before);
    const batchId = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: batchId,
        paymentDate: '2026-12-04',
        dueBy: '2026-12-04',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    const err = await f
      .inTenant((trx) =>
        sendBatchRemittances(
          trx,
          { companyId: f.companyId, batchId },
          { sender: new SmtpSender({ url: sink.url, from: 'accounts@harbour.example' }) },
        ),
      )
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
    expect(err?.code).toBe('NOT_CONFIRMED');
    expect(sink.messages).toHaveLength(before);
  });
});
