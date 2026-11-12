/**
 * Supplier bills (T-0050, design §3.8 row 6, UC-05, GP-008, DL-0278), against a real PostgreSQL as
 * lf_app. The approved bill's journal is compared line for line with the Approved GP-008.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import { findPeriod, setPeriodStatus, subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBill, createBill, suggestCoding, type BillError } from './bills.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp008 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-008',
);

let f: LedgerFixture;
let supplier = '';
const money = (s: string) =>
  s === '0' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005001');
  await seedBillingCompany(f);
  supplier = await f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({
        company_id: f.companyId,
        legal_name: 'Officeworks-like Supplies Pty Ltd',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'supplier' })
      .execute();
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ap_bill_document', prefix: 'BILL-' })
      .execute();
    return p.id;
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const gp008Bill = (supplierRef: string, billDate: string) => ({
  companyId: f.companyId,
  partyId: supplier,
  supplierRef,
  billDate,
  dueDate: '2026-11-30',
  lines: [
    {
      accountId: f.acct['6230'] ?? '',
      description: 'Stationery and consumables',
      amount: '500.00',
      taxCode: 'GST',
    },
    {
      accountId: f.acct['1500'] ?? '',
      description: 'Laptop',
      amount: '2000.00',
      taxCode: 'GST-CAP',
    },
  ],
});

describe('SS-UC05-04: Approved bill posts GP-008', () => {
  it('SS-UC05-04 approving BILL as in GP-008 posts exactly GP-008 and leaves an AP open item of 2,750.00', async () => {
    const b = await f.inTenant(async (trx) => {
      const d = await createBill(trx, gp008Bill('SUP-INV-778', '2026-11-03'));
      expect(d).toMatchObject({
        status: 'draft',
        net: '2500.0000',
        tax: '250.0000',
        gross: '2750.0000',
      });
      return approveBill(trx, { companyId: f.companyId, billId: d.billId });
    });
    expect(b.billNo).toMatch(/^BILL-\d{6}$/);
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${b.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    const codeOf: Record<string, string> = {
      'expense: Office expenses': '6230',
      'asset: Computer equipment': '1500',
      'tax:GST.paid': '1820',
      'system:AP_CONTROL': '2000',
    };
    expect(rows).toHaveLength(gp008?.lines.length ?? -1);
    gp008?.lines.forEach((g, i) => {
      const at = `GP-008 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? supplier : null);
    });
    const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, b.entryId ?? ''));
    expect(item?.openAmount).toBe('-2750.0000');
  });

  it('the same supplier invoice number cannot be entered twice (duplicate bill)', async () => {
    const err = await f
      .inTenant((trx) => createBill(trx, gp008Bill('SUP-INV-778', '2026-11-04')))
      .then(
        () => undefined,
        (e: unknown) => e as BillError,
      );
    expect(err?.code).toBe('DUPLICATE_BILL');
  });

  it('SS-UC05-02 the suggestion for this supplier comes from its posted bills', async () => {
    for (const [ref, date] of [
      ['SUP-INV-779', '2026-11-05'],
      ['SUP-INV-780', '2026-11-06'],
    ] as const) {
      await f.inTenant(async (trx) => {
        const d = await createBill(trx, {
          ...gp008Bill(ref, date),
          lines: [
            {
              accountId: f.acct['6230'] ?? '',
              description: 'Paper',
              amount: '50.00',
              taxCode: 'GST',
            },
          ],
        });
        return approveBill(trx, { companyId: f.companyId, billId: d.billId });
      });
    }
    const s = await f.inTenant((trx) =>
      suggestCoding(trx, { companyId: f.companyId, partyId: supplier }),
    );
    expect(s).toEqual({ accountId: f.acct['6230'], taxCode: 'GST' });
  });
});

describe('SS-UC05-07: Bill in AP-locked period rejected', () => {
  it('SS-UC05-07 a bill dated 2026-10-20 in an AP-locked October is rejected with PERIOD_LOCKED and nothing posts', async () => {
    const admin = await f.addUser('finance_admin');
    await f.inTenant(async (trx) => {
      const period = await findPeriod(trx, f.companyId, '2026-10-15');
      await setPeriodStatus(trx, {
        periodId: period?.id ?? '',
        status: 'ap_locked',
        actorId: admin,
      });
    });
    const before = await f.countEntries();
    const err = await f
      .inTenant(async (trx) => {
        const d = await createBill(trx, gp008Bill('SUP-INV-OCT', '2026-10-20'));
        return approveBill(trx, { companyId: f.companyId, billId: d.billId });
      })
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
    expect(err?.code).toBe('PERIOD_LOCKED');
    expect(await f.countEntries()).toBe(before);
  });
});
