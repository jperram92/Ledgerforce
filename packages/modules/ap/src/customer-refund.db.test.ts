/**
 * Customer refunds through the payment batch (T-0055, UC-11 step 3, GP-006, postings Q9, DL-0305),
 * against a real PostgreSQL as lf_app. A requested refund of a customer credit goes into the next
 * payment batch like a supplier bill — to the customer's verified bank account, after the same
 * cooling-off (Q9) — and posts GP-006 (its own entry, source ar_refund) when the bank confirms the
 * batch; the refund is then allocated to the credit, which is cleared. The journal is compared
 * line for line with the Approved GP-006. SS-UC11-05: the Opportunity write-back snapshot then
 * carries the net amount paid, mapped by the Salesforce connector's own parser.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  approveCreditNote,
  approveCustomerRefund,
  approveInvoice,
  createCreditNote,
  createCustomerRefund,
  createDraftInvoice,
  getCustomerRefund,
  opportunityWriteBack,
  recordReceipt,
  type DocumentOutbox,
  type RefundError,
} from '@ledgerforce/ar';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { mapToRecords, parseWriteBackPayload, SfNumber } from '@ledgerforce/connector-salesforce';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPaymentBatchAba } from './aba-export.ts';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import {
  createPaymentBatch,
  getPaymentBatch,
  releasePaymentBatch,
  type PaymentBatchError,
} from './payment-batches.ts';
import {
  payablesKms,
  seedPayablesCompany,
  type PayablesFixture,
} from './testing/payables-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp006 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-006',
);

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaser = '';
let treasurer = '';
let refundApprover = '';
const outbox: DocumentOutbox = { publish: async () => {} };
const codeOf: Record<string, string> = {};
const OPPORTUNITY = '006000000000001AAA';

const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005501');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
  treasurer = await f.addUser('approver');
  refundApprover = await f.addUser('approver');
  await f.inTenant(async (trx) => {
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['bank:OPERATING'] = '1010';
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** GP-001 INV to `party` on `date`, paid in full on `paidOn` (GP-002 shape), then GP-005's credit note. */
async function paidInvoiceWithCredit(party: string, date: string, paidOn: string, cnOn: string) {
  const inv = await f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: party,
        issueDate: date,
        lines: [
          {
            productProfileId: p.profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: p.profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '250.00',
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
      receiptDate: paidOn,
      amount: '1375.00',
      method: 'eft',
      depositTo: { accountId: f.acct['1010'] ?? '' },
      idempotencyKey: `receipt-${inv.invoiceId}`,
      allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
    }),
  );
  const cn = await f.inTenant(async (trx) => {
    const d = await createCreditNote(trx, {
      companyId: f.companyId,
      invoiceId: inv.invoiceId,
      issueDate: cnOn,
      reasonCode: 'scope_reduction',
      lines: [{ invoiceLineNo: 1, amount: '200.00' }],
    });
    return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
  });
  return { inv, cn };
}

/** Requested by the clerk and not yet approved (T-0152: a batch pays only approved refunds). */
const requestUnapproved = (party: string, amount: string, refundDate: string) =>
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

const approveRefund = (refundId: string) =>
  f.inTenant((trx) =>
    approveCustomerRefund(trx, { companyId: f.companyId, refundId, approvedBy: refundApprover }),
  );

/** Requested by the clerk, then approved by another person (ADR-0074); returns the request. */
const requestRefund = async (party: string, amount: string, refundDate: string) => {
  const r = await requestUnapproved(party, amount, refundDate);
  await approveRefund(r.refundId);
  return r;
};

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

const confirm = (batchId: string, confirmedOn: string) =>
  f.inTenant((trx) =>
    confirmPaymentBatch(trx, {
      companyId: f.companyId,
      batchId,
      confirmedOn,
      confirmedBy: treasurer,
    }),
  );

const refusal = <E>(pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as E,
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

const entriesOf = (sourceType: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ id: string; source_id: string | null; d: string }>`
          SELECT id::text, source_id::text, to_char(entry_date, 'YYYY-MM-DD') AS d
            FROM app.journal_entry
           WHERE company_id = ${f.companyId} AND source_type = ${sourceType}
           ORDER BY entry_no`.execute(trx)
      ).rows,
  );

const arOpen = (party: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ open: string }>`
          SELECT coalesce(sum(base_open_amount), 0)::text AS open FROM app.subledger_entry
           WHERE party_id = ${party}::uuid AND control_role = 'AR_CONTROL'`.execute(trx)
      ).rows[0]?.open,
  );

let acme = '';
let acmeInvoice = '';

describe('SS-UC11-03: Refund via payment batch posts GP-006', () => {
  it('SS-UC11-03 the 220.00 credit refunded in a confirmed batch posts exactly GP-006 and the credit is cleared', async () => {
    expect(gp006?.lines).toHaveLength(2);
    acme = await p.addSupplier('Acme Pty Ltd', 72, 'customer');
    await f.inTenant((trx) =>
      trx
        .updateTable('app.party')
        .set({ salesforce_account_id: '001000000000001AAA' })
        .where('id', '=', acme)
        .execute(),
    );
    const { inv, cn } = await paidInvoiceWithCredit(acme, '2026-11-05', '2026-11-10', '2026-11-20');
    acmeInvoice = inv.invoiceId;
    expect(await arOpen(acme)).toBe('-220.0000');

    // Before the refund: Salesforce shows the full 1,375.00 paid (the credit is not cash back).
    const before = await f.inTenant((trx) =>
      opportunityWriteBack(trx, {
        companyId: f.companyId,
        sfId: OPPORTUNITY,
        invoiceIds: [inv.invoiceId],
      }),
    );
    expect(before).toEqual({ sfId: OPPORTUNITY, amountPaid: '1375.0000' });

    const refund = await requestRefund(acme, '220.00', '2026-11-24');
    expect(refund).toMatchObject({
      partyId: acme,
      amount: '220.0000',
      method: 'bank_batch',
      status: 'requested',
      entryId: null,
    });
    expect(refund.refundNo).toMatch(/^RF-\d{6}$/);

    // The refund goes into the next batch, to Acme's verified bank account; nothing posts yet.
    const batchId = await releasedBatch('2026-11-24');
    const released = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, batchId));
    expect(released).toMatchObject({
      status: 'released',
      total: '220.0000',
      paymentCount: 1,
      payments: [],
      excluded: [],
      excludedRefunds: [],
    });
    expect(released.refunds).toEqual([
      {
        refundId: refund.refundId,
        refundNo: refund.refundNo,
        partyId: acme,
        amount: '220.0000',
        bankAccountId: expect.any(String) as string,
      },
    ]);
    expect(await entriesOf('ar_refund')).toEqual([]);

    // Bank confirms: GP-006 posts as its own entry; no GP-009 entry (no bills in the batch).
    const c = await confirm(batchId, '2026-11-24');
    expect(c).toMatchObject({ entryId: null, payments: [], total: '220.0000', replayed: false });
    const refunds = await entriesOf('ar_refund');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ source_id: refund.refundId, d: '2026-11-24' });
    expect(c.refunds).toEqual([
      {
        refundId: refund.refundId,
        refundNo: refund.refundNo,
        partyId: acme,
        amount: '220.0000',
        entryId: refunds[0]?.id,
      },
    ]);
    expect(await entriesOf('ap_payment')).toEqual([]);

    // Line for line GP-006.
    const rows = await linesOf(refunds[0]?.id ?? '');
    expect(rows).toHaveLength(gp006?.lines.length ?? -1);
    gp006?.lines.forEach((g, i) => {
      const at = `GP-006 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });

    // Subledger: refund +220.00 allocated to the credit note → both 0.00; Acme AR balance 0.00.
    const [cnItem] = await f.inTenant((trx) => subledgerEntriesOf(trx, cn.entryId ?? ''));
    expect(cnItem?.openAmount).toBe('0.0000');
    const [refundItem] = await f.inTenant((trx) => subledgerEntriesOf(trx, refunds[0]?.id ?? ''));
    expect(refundItem).toMatchObject({ originalAmount: '220.0000', openAmount: '0.0000' });
    expect(await arOpen(acme)).toBe('0.0000');

    // The refund is paid by that entry.
    const paid = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, refund.refundId));
    expect(paid).toMatchObject({ status: 'paid', entryId: refunds[0]?.id, paidOn: '2026-11-24' });

    // A repeat confirmation changes nothing.
    const again = await confirm(batchId, '2026-11-25');
    expect(again.replayed).toBe(true);
    expect(await entriesOf('ar_refund')).toHaveLength(1);
  });

  it('SS-UC11-03 a batch with a bill and a refund: GP-009 credits the bank for the bills, GP-006 for the refund; the ABA file pays both', async () => {
    const supplier = await p.addSupplier('Northwind Stationery Pty Ltd', 72);
    await p.postBill(supplier, 'NW-1', '330.00', '2026-12-02');
    const beta = await p.addSupplier('Beta Customer Pty Ltd', 72, 'customer');
    await paidInvoiceWithCredit(beta, '2026-11-25', '2026-11-26', '2026-11-27');
    const refund = await requestRefund(beta, '220.00', '2026-12-01');
    const batchId = await releasedBatch('2026-12-02');
    const b = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, batchId));
    expect(b).toMatchObject({ total: '550.0000', paymentCount: 2 });
    expect(b.payments.map((x) => x.amount)).toEqual(['330.0000']);
    expect(b.refunds.map((x) => [x.refundId, x.amount])).toEqual([[refund.refundId, '220.0000']]);

    await f.inTenant((trx) =>
      createCompanyBankAccount(trx, payablesKms, f.companyId, {
        glAccountId: f.acct['1010'] ?? '',
        name: 'Operating',
        bsb: '062000',
        accountNumber: '987654321',
        accountName: 'LedgerForce Operating',
        currency: 'AUD',
        apcaUserId: '654321',
        abaUserName: 'LEDGERFORCE OPERATING',
        abaFiMnemonic: 'WBC',
      }),
    );
    const aba = await f.inTenant((trx) =>
      exportPaymentBatchAba(trx, payablesKms, { companyId: f.companyId, batchId }),
    );
    expect(aba).toMatchObject({ paymentCount: 2, total: '550.0000' });
    const details = aba.content.split('\r\n').filter((r) => r.startsWith('1'));
    expect(details).toHaveLength(2);
    // Amount (cents, 10 digits) at positions 21–30; lodgement reference at 63–80 (RQ-0006).
    expect(details.map((r) => r.slice(20, 30))).toEqual(['0000033000', '0000022000']);
    expect(details[1]?.slice(62, 80).trim()).toBe(refund.refundNo);
    // The ABA file's trailer total is the batch total.
    const trailer = aba.content.split('\r\n').find((r) => r.startsWith('7'));
    expect(trailer?.slice(20, 30)).toBe('0000055000');

    const c = await confirm(batchId, '2026-12-02');
    expect(c.entryId).not.toBeNull();
    expect(await linesOf(c.entryId ?? '')).toEqual([
      {
        code: codeOf['system:AP_CONTROL'],
        debit: '330.0000',
        credit: '0.0000',
        party_id: supplier,
      },
      { code: '1010', debit: '0.0000', credit: '330.0000', party_id: null },
    ]);
    const refundEntry = c.refunds[0]?.entryId ?? '';
    expect(await linesOf(refundEntry)).toEqual([
      { code: codeOf['system:AR_CONTROL'], debit: '220.0000', credit: '0.0000', party_id: beta },
      { code: '1010', debit: '0.0000', credit: '220.0000', party_id: null },
    ]);
    expect(await arOpen(beta)).toBe('0.0000');
  });

  it('Q9: a customer whose bank details are cooling off is excluded with the reason; the refund stays requested', async () => {
    const gamma = await p.addSupplier('Gamma Customer Pty Ltd', 1, 'customer');
    await paidInvoiceWithCredit(gamma, '2026-12-03', '2026-12-04', '2026-12-05');
    const refund = await requestRefund(gamma, '100.00', '2026-12-08');
    const err = await refusal<PaymentBatchError>(
      f.inTenant((trx) =>
        createPaymentBatch(trx, {
          companyId: f.companyId,
          id: randomUUID(),
          paymentDate: '2026-12-08',
          dueBy: '2026-12-08',
          accountId: f.acct['1010'] ?? '',
          createdBy: clerk,
        }),
      ),
    );
    expect(err?.code).toBe('NOTHING_DUE');
    // With a payable bill alongside, the refund is listed as excluded (cooling off).
    const s = await p.addSupplier('Delta Freight Pty Ltd', 72);
    await p.postBill(s, 'DF-1', '45.00', '2026-12-09');
    const id = randomUUID();
    const b = await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id,
        paymentDate: '2026-12-09',
        dueBy: '2026-12-09',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    expect(b).toMatchObject({ total: '45.0000', paymentCount: 1, refunds: [] });
    expect(b.excludedRefunds).toEqual([
      {
        refundId: refund.refundId,
        refundNo: refund.refundNo,
        partyId: gamma,
        amount: '100.0000',
        reason: 'BANK_DETAILS_COOLING_OFF',
        payableFrom: expect.any(Date) as Date,
      },
    ]);
    const still = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, refund.refundId));
    expect(still.status).toBe('requested');
  });

  it('Q9: a customer without verified bank details (customer-only party) is excluded with NO_VERIFIED_BANK_DETAILS', async () => {
    const zeta = await p.addSupplier('Zeta Customer Pty Ltd', null, 'customer-only');
    await paidInvoiceWithCredit(zeta, '2026-12-14', '2026-12-15', '2026-12-16');
    const refund = await requestRefund(zeta, '220.00', '2026-12-17');
    const s = await p.addSupplier('Eta Couriers Pty Ltd', 72);
    await p.postBill(s, 'EC-1', '12.50', '2026-12-17');
    const b = await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: randomUUID(),
        paymentDate: '2026-12-17',
        dueBy: '2026-12-17',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    expect(b.refunds).toEqual([]);
    expect(b.excludedRefunds).toContainEqual({
      refundId: refund.refundId,
      refundNo: refund.refundNo,
      partyId: zeta,
      amount: '220.0000',
      reason: 'NO_VERIFIED_BANK_DETAILS',
      payableFrom: null,
    });
  });

  it('a refund cannot exceed the customer credit, including refunds already requested', async () => {
    const delta = await p.addSupplier('Epsilon Customer Pty Ltd', 72, 'customer');
    await paidInvoiceWithCredit(delta, '2026-12-10', '2026-12-11', '2026-12-12');
    expect((await refusal<RefundError>(requestRefund(delta, '220.01', '2026-12-13')))?.code).toBe(
      'REFUND_EXCEEDS_CREDIT',
    );
    await requestRefund(delta, '120.00', '2026-12-13');
    expect((await refusal<RefundError>(requestRefund(delta, '100.01', '2026-12-13')))?.code).toBe(
      'REFUND_EXCEEDS_CREDIT',
    );
    const last = await requestRefund(delta, '100.00', '2026-12-13');
    expect(last.status).toBe('requested');
  });

  it('ADR-0074: a refund that is not approved stays out of the payment batch; once approved, the next batch pays it', async () => {
    const supplier = await p.addSupplier('Unapproved Test Supplier Pty Ltd', 72);
    await p.postBill(supplier, 'UA-1', '110.00', '2026-12-20');
    const kappa = await p.addSupplier('Kappa Customer Pty Ltd', 72, 'customer');
    await paidInvoiceWithCredit(kappa, '2026-12-14', '2026-12-15', '2026-12-16');
    const refund = await requestUnapproved(kappa, '220.00', '2026-12-17');
    const first = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: first,
        paymentDate: '2026-12-20',
        dueBy: '2026-12-20',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    const b = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, first));
    const ids = [...b.refunds, ...b.excludedRefunds].map((r) => r.refundId);
    expect(ids).not.toContain(refund.refundId);
    await approveRefund(refund.refundId);
    const second = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: second,
        paymentDate: '2026-12-20',
        dueBy: '2026-12-20',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    const b2 = await f.inTenant((trx) => getPaymentBatch(trx, f.companyId, second));
    expect(b2.refunds.map((r) => r.refundId)).toContain(refund.refundId);
  });
});

describe('SS-UC11-05: Salesforce shows net amount paid', () => {
  it('SS-UC11-05 after the confirmed refund the Opportunity write-back carries LF_Amount_Paid__c = 1,155.00', async () => {
    const snap = await f.inTenant((trx) =>
      opportunityWriteBack(trx, {
        companyId: f.companyId,
        sfId: OPPORTUNITY,
        invoiceIds: [acmeInvoice],
      }),
    );
    expect(snap).toEqual({ sfId: OPPORTUNITY, amountPaid: '1155.0000' });
    // Through the connector's own contract: parsed and mapped to the Opportunity field.
    const parsed = parseWriteBackPayload({ writeBack: { version: 1, opportunities: [snap] } });
    const records = mapToRecords(parsed);
    expect(records).toEqual([
      {
        op: 'update',
        sobject: 'Opportunity',
        key: OPPORTUNITY,
        fields: { LF_Amount_Paid__c: new SfNumber('1155.00') },
      },
    ]);
  });
});
