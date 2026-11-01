/**
 * Customer receipts and allocations (T-0046, design §3.8 row 2, UC-03, GP-002, DL-0274), against a
 * real PostgreSQL as lf_app. The receipt journal is compared line for line with the Approved GP-002.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import {
  allocateReceipt,
  invoicePaymentStatus,
  recordReceipt,
  type ReceiptError,
} from './receipts.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp002 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-002',
);

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };

async function gp001Invoice(partyId: string, date: string) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate: date,
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
}

const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004601');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 3,
    prefix: 'Payer',
    billDate: '2026-11-01',
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC03-07: Bank-transfer receipt posts GP-002', () => {
  it('SS-UC03-07 an EFT receipt of 1,375.00 allocated to the invoice posts exactly GP-002 and the invoice is Paid', async () => {
    const acme = customers[0] ?? '';
    const inv = await gp001Invoice(acme, '2026-11-05');
    expect(
      await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, inv.invoiceId)),
    ).toEqual({
      status: 'unpaid',
      open: '1375.0000',
    });
    const r = await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-15',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'eft-1',
        allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
      }),
    );
    expect(r.receiptNo).toMatch(/^RCT-\d{6}$/);
    expect(r.unallocated).toBe('0.0000');
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${r.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    const codeOf: Record<string, string> = {
      'bank:OPERATING': '1010',
      'system:AR_CONTROL': '1200',
    };
    expect(rows).toHaveLength(gp002?.lines.length ?? -1);
    gp002?.lines.forEach((g, i) => {
      const at = `GP-002 line ${String(i + 1)}`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
    expect(
      await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, inv.invoiceId)),
    ).toEqual({
      status: 'paid',
      open: '0.0000',
    });
    // Idempotent: the same key returns the same receipt.
    const again = await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-15',
        amount: '1375.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'eft-1',
        allocations: [{ invoiceId: inv.invoiceId, amount: '1375.00' }],
      }),
    );
    expect(again).toMatchObject({ receiptId: r.receiptId, replayed: true });
  });
});

describe('SS-UC03-08: Partial payment leaves the correct open amount', () => {
  it('SS-UC03-08 a 375.00 receipt leaves the invoice Partially paid with 1,000.00 open; AR subledger = AR control', async () => {
    const bolt = customers[1] ?? '';
    const inv = await gp001Invoice(bolt, '2026-11-06');
    await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: bolt,
        receiptDate: '2026-11-16',
        amount: '375.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'eft-2',
        allocations: [{ invoiceId: inv.invoiceId, amount: '375.00' }],
      }),
    );
    expect(
      await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, inv.invoiceId)),
    ).toEqual({
      status: 'partially_paid',
      open: '1000.0000',
    });
    const rec = await f.inTenant((trx) => subledgerReconciliation(trx, { companyId: f.companyId }));
    expect(rec.every((x) => x.reconciled)).toBe(true);
  });

  it('a cheque into undeposited funds held unallocated can be allocated later; over-allocation is refused', async () => {
    const third = customers[2] ?? '';
    const inv = await gp001Invoice(third, '2026-11-07');
    const r = await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: third,
        receiptDate: '2026-11-17',
        amount: '500.00',
        method: 'cheque',
        depositTo: { undeposited: true },
        idempotencyKey: 'chq-1',
        allocations: [],
      }),
    );
    expect(r.unallocated).toBe('500.0000');
    const line = await f.inTenant((trx) =>
      sql<{ role: string }>`
        SELECT r.role FROM app.journal_line l JOIN app.account_system_role r ON r.account_id = l.account_id
         WHERE l.entry_id = ${r.entryId} AND l.debit > 0`.execute(trx),
    );
    expect(line.rows.map((x) => x.role)).toEqual(['UNDEPOSITED_FUNDS']);
    const tooMuch = await f
      .inTenant((trx) =>
        allocateReceipt(trx, {
          companyId: f.companyId,
          receiptId: r.receiptId,
          invoiceId: inv.invoiceId,
          amount: '600.00',
          allocationDate: '2026-11-18',
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as ReceiptError,
      );
    expect(tooMuch?.code).toBe('OVER_ALLOCATED');
    const ok = await f.inTenant((trx) =>
      allocateReceipt(trx, {
        companyId: f.companyId,
        receiptId: r.receiptId,
        invoiceId: inv.invoiceId,
        amount: '500.00',
        allocationDate: '2026-11-18',
      }),
    );
    expect(ok.unallocated).toBe('0.0000');
    expect(
      await f.inTenant((trx) => invoicePaymentStatus(trx, f.companyId, inv.invoiceId)),
    ).toEqual({
      status: 'partially_paid',
      open: '875.0000',
    });
  });

  it('a receipt from another customer cannot pay this invoice', async () => {
    const inv = await gp001Invoice(customers[0] ?? '', '2026-11-08');
    const err = await f
      .inTenant((trx) =>
        recordReceipt(trx, {
          companyId: f.companyId,
          partyId: customers[1] ?? '',
          receiptDate: '2026-11-18',
          amount: '10.00',
          method: 'eft',
          depositTo: { accountId: f.acct['1010'] ?? '' },
          idempotencyKey: 'eft-wrong',
          allocations: [{ invoiceId: inv.invoiceId, amount: '10.00' }],
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as ReceiptError,
      );
    expect(err?.code).toBe('INVALID_RECEIPT');
  });
});
