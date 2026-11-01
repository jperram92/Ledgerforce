/**
 * Aged receivables, the Account write-back snapshot and customer statements (T-0049, design §8.1,
 * UC-12, DL-0277), against a real PostgreSQL as lf_app.
 */
import { mapToRecords, parseWriteBackPayload } from '@ledgerforce/connector-salesforce';
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountWriteBack, agedReceivables, customerStatement } from './aged.ts';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import { recordReceipt } from './receipts.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
let acme = '';
let bolt = '';
const outbox: DocumentOutbox = { publish: async () => {} };
const AS_OF = '2026-12-31';

async function invoice(partyId: string, issueDate: string, dueDate: string) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate,
        dueDate,
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Services',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox },
    );
    return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
  });
}
const receipt = (
  partyId: string,
  date: string,
  amount: string,
  key: string,
  allocations: { invoiceId: string; amount: string }[],
) =>
  f.inTenant((trx) =>
    recordReceipt(trx, {
      companyId: f.companyId,
      partyId,
      receiptDate: date,
      amount,
      method: 'eft',
      depositTo: { accountId: f.acct['1010'] ?? '' },
      idempotencyKey: key,
      allocations,
    }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004901');
  profiles = await seedBillingCompany(f);
  [acme = '', bolt = ''] = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Aged',
    billDate: '2026-11-01',
  });
  await f.inTenant((trx) =>
    trx
      .updateTable('app.party')
      .set({ salesforce_account_id: '001000000000001AAA' })
      .where('id', '=', acme)
      .execute(),
  );
  const a = await invoice(acme, '2026-12-06', '2026-12-20'); // 11 days overdue → 1–30
  const b = await invoice(acme, '2026-10-01', '2026-10-15'); // 77 days → 61–90, part paid
  await invoice(acme, '2026-12-27', '2027-01-10'); // not yet due → current
  await invoice(bolt, '2026-07-15', '2026-08-01'); // 152 days → 90+
  await receipt(acme, '2026-11-20', '375.00', 'r-b', [
    { invoiceId: b.invoiceId, amount: '375.00' },
  ]);
  await receipt(bolt, '2026-12-30', '200.00', 'r-unapplied', []); // unapplied credit, current
  await receipt(acme, '2027-01-05', '1375.00', 'r-after', [
    { invoiceId: a.invoiceId, amount: '1375.00' },
  ]); // after AS_OF
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0049 AC-1: aged AR buckets sum to the AR control balance at date', () => {
  it('SS-PLAT-107 ages every open item by due date as at 31 Dec 2026 and the buckets sum to AR control', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: AS_OF }),
    );
    const byParty = Object.fromEntries(r.rows.map((x) => [x.partyId, x]));
    expect(byParty[acme]).toMatchObject({
      current: '1375.0000',
      days1to30: '1375.0000',
      days31to60: '0.0000',
      days61to90: '1000.0000',
      days90plus: '0.0000',
      total: '3750.0000',
    });
    expect(byParty[bolt]).toMatchObject({
      current: '-200.0000',
      days90plus: '1375.0000',
      total: '1175.0000',
    });
    expect(r.totals.total).toBe('4925.0000');
    const [ar] = await f.inTenant((trx) =>
      subledgerReconciliation(trx, { companyId: f.companyId, asOf: AS_OF }),
    );
    expect(ar?.controlBalance).toBe(r.totals.total);
    const sum = ['current', 'days1to30', 'days31to60', 'days61to90', 'days90plus'] as const;
    expect(sum.map((k) => r.totals[k])).toEqual([
      '1175.0000',
      '1375.0000',
      '0.0000',
      '1000.0000',
      '1375.0000',
    ]);
  });
});

describe('SS-UC12-05: Salesforce values reconcile to LedgerForce aged AR', () => {
  it('SS-UC12-05 the Account write-back carries balance due and overdue amount equal to the aged-AR totals, and maps to LF_ fields', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: AS_OF }),
    );
    const aged = r.rows.find((x) => x.partyId === acme);
    const snap = await f.inTenant((trx) =>
      accountWriteBack(trx, { companyId: f.companyId, partyId: acme, asOf: AS_OF }),
    );
    expect(snap).toEqual({
      sfId: '001000000000001AAA',
      balanceDue: aged?.total,
      overdueAmount: '2375.0000',
      creditStatus: 'overdue',
      lastPaymentDate: '2026-11-20',
    });
    const parsed = parseWriteBackPayload({ writeBack: { version: 1, accounts: [snap] } });
    const records = JSON.stringify(mapToRecords(parsed));
    expect(records).toContain('LF_Balance_Due__c');
    expect(records).toContain('3750.00');
    expect(records).toContain('2375.00');
  });
});

describe('Customer statement (T-0049)', () => {
  it('lists the period movements between opening and closing balances; closing equals the aged total', async () => {
    const s = await f.inTenant((trx) =>
      customerStatement(trx, {
        companyId: f.companyId,
        partyId: acme,
        from: '2026-11-01',
        to: AS_OF,
      }),
    );
    expect(s.openingBalance).toBe('1375.0000');
    expect(s.closingBalance).toBe('3750.0000');
    expect(s.lines.map((l) => [l.date, l.kind, l.debit, l.credit])).toEqual([
      ['2026-11-20', 'receipt', '0.0000', '375.0000'],
      ['2026-12-06', 'invoice', '1375.0000', '0.0000'],
      ['2026-12-27', 'invoice', '1375.0000', '0.0000'],
    ]);
  });
});
