/**
 * Customer refund documents (T-0055, UC-11, GP-006, DL-0305), against a real PostgreSQL as lf_app:
 * a refund is requested against the customer's available credit (AR credit balance less refunds
 * already requested), is paid exactly once by its own posted ar_refund entry (GP-006), and its row
 * can only move forward (migration 0049 guard). The batch flow is proven in
 * packages/modules/ap/src/customer-refund.db.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveCreditNote, createCreditNote } from './credit-notes.ts';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import { recordReceipt } from './receipts.ts';
import {
  createCustomerRefund,
  customerCredit,
  getCustomerRefund,
  payCustomerRefund,
  type RefundError,
} from './refunds.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005502');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 3,
    prefix: 'Refund',
    billDate: '2026-11-01',
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** A paid 1,375.00 invoice and a 220.00 credit note: the party holds a 220.00 credit. */
async function creditOf220(party: string) {
  const inv = await f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: party,
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
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
      receiptDate: '2026-11-10',
      amount: '1375.00',
      method: 'eft',
      depositTo: { accountId: f.acct['1010'] ?? '' },
      idempotencyKey: `r-${inv.invoiceId}`,
      allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
    }),
  );
  return f.inTenant(async (trx) => {
    const d = await createCreditNote(trx, {
      companyId: f.companyId,
      invoiceId: inv.invoiceId,
      issueDate: '2026-11-20',
      reasonCode: 'scope_reduction',
      lines: [{ invoiceLineNo: 1, amount: '200.00' }],
    });
    return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
  });
}

const refusal = (pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as RefundError,
  );

describe('Customer refund document (T-0055)', () => {
  it('is requested against the available credit, replays on its id, and refuses Stripe until T-0122', async () => {
    const party = customers[0] ?? '';
    // No credit yet: the party owes its billing lines only (nothing posted) → nothing to refund.
    const none = await f.inTenant((trx) => customerCredit(trx, f.companyId, party));
    expect(none).toEqual({ balance: '0.0000', requested: '0.0000', available: '0.0000' });
    const base = {
      companyId: f.companyId,
      partyId: party,
      refundDate: '2026-11-24',
      amount: '10.00',
      method: 'bank_batch' as const,
    };
    expect(
      (await refusal(f.inTenant((trx) => createCustomerRefund(trx, { ...base, id: randomUUID() }))))
        ?.code,
    ).toBe('REFUND_EXCEEDS_CREDIT');

    await creditOf220(party);
    const id = randomUUID();
    const r = await f.inTenant((trx) =>
      createCustomerRefund(trx, { ...base, id, amount: '220.00' }),
    );
    expect(r).toMatchObject({ refundId: id, status: 'requested', amount: '220.0000' });
    const credit = await f.inTenant((trx) => customerCredit(trx, f.companyId, party));
    expect(credit).toEqual({ balance: '-220.0000', requested: '220.0000', available: '0.0000' });
    // Same id again: the stored refund, not a second one.
    const again = await f.inTenant((trx) =>
      createCustomerRefund(trx, { ...base, id, amount: '220.00' }),
    );
    expect(again).toMatchObject({ refundId: id, refundNo: r.refundNo, replayed: true });

    for (const [patch, code] of [
      [{ amount: '0' }, 'INVALID_REFUND'],
      [{ amount: '1.001' }, 'INVALID_REFUND'],
      [{ amount: '-5.00' }, 'INVALID_REFUND'],
      [{ refundDate: '2026-02-30' }, 'INVALID_REFUND'],
      [{ method: 'stripe' }, 'METHOD_NOT_AVAILABLE'],
    ] as const) {
      const e = await refusal(
        f.inTenant((trx) => createCustomerRefund(trx, { ...base, ...patch, id: randomUUID() })),
      );
      expect(e?.code, JSON.stringify(patch)).toBe(code);
    }
  });

  it('is paid once by its own GP-006 entry, which clears the credit; the row only moves forward', async () => {
    const party = customers[1] ?? '';
    const cn = await creditOf220(party);
    const r = await f.inTenant((trx) =>
      createCustomerRefund(trx, {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: party,
        refundDate: '2026-11-24',
        amount: '220.00',
        method: 'bank_batch',
      }),
    );
    const pay = () =>
      f.inTenant((trx) =>
        payCustomerRefund(trx, {
          companyId: f.companyId,
          refundId: r.refundId,
          paidOn: '2026-11-25',
          bankAccountId: f.acct['1010'] ?? '',
        }),
      );
    // Not before the refund date.
    expect(
      (
        await refusal(
          f.inTenant((trx) =>
            payCustomerRefund(trx, {
              companyId: f.companyId,
              refundId: r.refundId,
              paidOn: '2026-11-23',
              bankAccountId: f.acct['1010'] ?? '',
            }),
          ),
        )
      )?.code,
    ).toBe('INVALID_REFUND');
    const paid = await pay();
    expect(paid).toMatchObject({ status: 'paid', paidOn: '2026-11-25', replayed: false });
    const [cnItem] = await f.inTenant((trx) => subledgerEntriesOf(trx, cn.entryId ?? ''));
    expect(cnItem?.openAmount).toBe('0.0000');
    const again = await pay();
    expect(again).toMatchObject({ entryId: paid.entryId, replayed: true });
    const n = await f.inTenant(
      async (trx) =>
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM app.journal_entry
             WHERE source_type = 'ar_refund' AND source_id = ${r.refundId}`.execute(trx)
        ).rows[0]?.n,
    );
    expect(n).toBe('1');

    // The database refuses changes other than moving forward (migration 0049 guard).
    const sqlErr = (q: Promise<unknown>) =>
      q.then(
        () => null,
        (e: unknown) => (e as { code?: string }).code ?? 'error',
      );
    expect(
      await sqlErr(
        f.inTenant((trx) =>
          sql`UPDATE app.customer_refund SET amount = 1 WHERE id = ${r.refundId}`.execute(trx),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlErr(
        f.inTenant((trx) =>
          sql`UPDATE app.customer_refund SET status = 'cancelled', updated_at = clock_timestamp()
               WHERE id = ${r.refundId}`.execute(trx),
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlErr(
        f.inTenant((trx) =>
          sql`DELETE FROM app.customer_refund WHERE id = ${r.refundId}`.execute(trx),
        ),
      ),
    ).toBe('42501');
  });

  it('a requested refund can only be marked paid by its own posted ar_refund entry', async () => {
    const party = customers[2] ?? '';
    const cn = await creditOf220(party);
    const r = await f.inTenant((trx) =>
      createCustomerRefund(trx, {
        companyId: f.companyId,
        id: randomUUID(),
        partyId: party,
        refundDate: '2026-11-24',
        amount: '50.00',
        method: 'bank_batch',
      }),
    );
    const code = await f
      .inTenant((trx) =>
        sql`UPDATE app.customer_refund SET status = 'paid', entry_id = ${cn.entryId}::uuid,
                   paid_on = '2026-11-25', updated_at = clock_timestamp()
             WHERE id = ${r.refundId}`.execute(trx),
      )
      .then(
        () => null,
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(code).toBe('23514');
    const still = await f.inTenant((trx) => getCustomerRefund(trx, f.companyId, r.refundId));
    expect(still.status).toBe('requested');
  });
});
