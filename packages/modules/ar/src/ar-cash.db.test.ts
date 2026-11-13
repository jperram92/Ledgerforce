/**
 * AR cash read side for the receipt allocation and credit-note screens (T-0151, split from T-0085,
 * UC-03, UC-11, DL-0490), against a real PostgreSQL as lf_app:
 *  - listReceipts lists a company's receipts with what is still unallocated (customer credit);
 *  - allocateReceipt with an idempotency key allocates once and replays on a repeat;
 *  - previewCreditNoteJournal is the posting engine's preview of exactly what approving the draft
 *    credit note posts (GP-005 builder) and writes nothing.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveCreditNote,
  createCreditNote,
  previewCreditNoteJournal,
  type CreditNoteError,
} from './credit-notes.ts';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import {
  allocateReceipt,
  invoicePaymentStatus,
  listReceipts,
  recordReceipt,
  type ReceiptError,
} from './receipts.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };

async function invoiceFor(partyId: string, unitPrice: string) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate: '2026-11-05',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice,
          },
        ],
      },
      { outbox },
    );
    return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
  });
}

const count = (table: 'journal_entry' | 'allocation') =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM ${sql.table(`app.${table}`)}`.execute(trx)
      ).rows[0]?.n ?? -1,
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000015101');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Harbour',
    billDate: '2026-11-01',
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0151 AC-1: receipts list and idempotent allocation', () => {
  it('AC-1 lists an unallocated receipt; one keyed allocation pays the invoice and a repeat replays [T-0151]', async () => {
    const party = customers[0] ?? '';
    const inv = await invoiceFor(party, '1000.00'); // 1,100.00 incl. GST
    const r = await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: party,
        receiptDate: '2026-11-10',
        amount: '1100.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        reference: 'EFT 4471',
        idempotencyKey: 'rcpt-151-1',
        allocations: [],
      }),
    );
    const open = await f.inTenant((trx) =>
      listReceipts(trx, { companyId: f.companyId, unallocatedOnly: true }),
    );
    expect(open).toEqual([
      {
        receiptId: r.receiptId,
        receiptNo: r.receiptNo,
        partyId: party,
        partyName: expect.stringMatching(/^Harbour/),
        receiptDate: '2026-11-10',
        method: 'eft',
        reference: 'EFT 4471',
        amount: '1100.0000',
        unallocated: '1100.0000',
      },
    ]);

    const before = await count('allocation');
    const first = await f.inTenant((trx) =>
      allocateReceipt(trx, {
        companyId: f.companyId,
        receiptId: r.receiptId,
        invoiceId: inv.invoiceId,
        amount: '1100.00',
        allocationDate: '2026-11-10',
        idempotencyKey: 'alloc-151-1',
      }),
    );
    expect(first).toMatchObject({ unallocated: '0.0000', replayed: false });
    const again = await f.inTenant((trx) =>
      allocateReceipt(trx, {
        companyId: f.companyId,
        receiptId: r.receiptId,
        invoiceId: inv.invoiceId,
        amount: '1100.00',
        allocationDate: '2026-11-10',
        idempotencyKey: 'alloc-151-1',
      }),
    );
    expect(again).toMatchObject({ receiptId: r.receiptId, unallocated: '0.0000', replayed: true });
    expect(await count('allocation')).toBe(before + 1);
    expect(
      await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, inv.invoiceId)),
    ).toEqual({ status: 'paid', open: '0.0000' });
    expect(
      await f.inTenant((trx) =>
        listReceipts(trx, { companyId: f.companyId, unallocatedOnly: true }),
      ),
    ).toEqual([]);
    const all = await f.inTenant((trx) => listReceipts(trx, { companyId: f.companyId }));
    expect(all.map((x) => [x.receiptNo, x.unallocated])).toEqual([[r.receiptNo, '0.0000']]);
  });

  it('AC-1 a receipt of another company is RECEIPT_NOT_FOUND [T-0151]', async () => {
    await expect(
      f.inTenant((trx) =>
        allocateReceipt(trx, {
          companyId: f.companyId,
          receiptId: '01900000-0000-7000-8000-0000000151ff',
          invoiceId: '01900000-0000-7000-8000-0000000151fe',
          amount: '1.00',
          allocationDate: '2026-11-10',
          idempotencyKey: 'alloc-151-x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'RECEIPT_NOT_FOUND' } satisfies Partial<ReceiptError>);
  });
});

describe('T-0151 AC-2: credit-note journal preview', () => {
  it('AC-2 the preview equals the journal approval posts (GP-005 builder) and writes nothing [T-0151]', async () => {
    const party = customers[1] ?? '';
    const inv = await invoiceFor(party, '1250.00');
    const draft = await f.inTenant((trx) =>
      createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        id: '01900000-0000-7000-8000-000000015111',
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      }),
    );
    const entries = await count('journal_entry');
    const p = await f.inTenant((trx) =>
      previewCreditNoteJournal(trx, { companyId: f.companyId, creditNoteId: draft.creditNoteId }),
    );
    expect(await count('journal_entry')).toBe(entries);
    expect(p.total).toBe('220.0000');
    expect(p.entryDate).toBe('2026-11-20');
    expect(p.lines.map((l) => [l.accountName.length > 0, l.debit, l.credit])).toEqual([
      [true, '200.0000', '0.0000'],
      [true, '20.0000', '0.0000'],
      [true, '0.0000', '220.0000'],
    ]);
    const cn = await f.inTenant((trx) =>
      approveCreditNote(trx, { companyId: f.companyId, creditNoteId: draft.creditNoteId }),
    );
    const posted = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${cn.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    expect(
      p.lines.map((l) => ({
        code: l.accountCode,
        debit: l.debit,
        credit: l.credit,
        party_id: l.partyId,
      })),
    ).toEqual(posted);
    await expect(
      f.inTenant((trx) =>
        previewCreditNoteJournal(trx, { companyId: f.companyId, creditNoteId: draft.creditNoteId }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_DRAFT' } satisfies Partial<CreditNoteError>);
  });
});
