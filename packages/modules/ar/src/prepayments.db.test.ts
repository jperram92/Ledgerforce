/**
 * Customer prepayments and deposit invoices (T-0047, design §3.8 row 10, §4.3 deposit, §4.5,
 * GP-014, GP-015, GP-020, GP-022, Q7/Q10, DL-0275), against a real PostgreSQL as lf_app. Each
 * journal is compared line for line with its Approved golden posting; the BAS shows the GST once.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { basLabels } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import { applyPrepayment, recordPrepayment, type PrepaymentError } from './prepayments.ts';
import { recordReceipt } from './receipts.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const golden = (id: string): GoldenJournal => {
  const t = tables.find((x) => `${x.entryId}${x.label}` === id);
  if (!t) throw new Error(`${id} not Approved`);
  return t;
};

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };
const codeOf: Record<string, string> = {};
const money = (s: string) => (s === '0' ? '0.0000' : `${s}${s.includes('.') ? '00' : '.0000'}`);

async function expectGolden(entryId: string, id: string, party: string) {
  const t = golden(id);
  const rows = await f.inTenant(
    async (trx) =>
      (
        await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
          JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(
          trx,
        )
      ).rows,
  );
  expect(rows, id).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const at = `${id} line ${String(i + 1)} (${g.binding})`;
    expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
    expect(rows[i]?.debit, at).toBe(money(g.debit));
    expect(rows[i]?.credit, at).toBe(money(g.credit));
    expect(rows[i]?.party_id ?? null, at).toBe(g.party ? party : null);
  });
}

const services = (amount: string) => [
  {
    productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
    description: 'Website rebuild',
    quantity: '1',
    unitPrice: amount,
  },
];

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004701');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
    codeOf['bank:OPERATING'] = '1010';
    codeOf['product:PROFESSIONAL_SERVICES.revenue'] = '4110';
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('Prepayment received, then applied to the final invoice (GP-020, GP-022)', () => {
  it('SS-PLAT-105 a progressive-supply prepayment of 3,300.00 posts GP-020 (GST at receipt)', async () => {
    const acme = customers[0] ?? '';
    const p = await f.inTenant((trx) =>
      recordPrepayment(trx, {
        companyId: f.companyId,
        partyId: acme,
        receiptDate: '2026-11-10',
        gross: '3300.00',
        supplyType: 'progressive_periodic',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'pre-1',
      }),
    );
    expect(p).toMatchObject({ net: '3000.0000', tax: '300.0000', unappliedNet: '3000.0000' });
    await expectGolden(p.entryId, 'GP-020', acme);
  });

  it('SS-PLAT-105 the final invoice posts GP-022a and the application posts GP-022b; the invoice is left 7,700.00 open', async () => {
    const acme = customers[0] ?? '';
    const inv = await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: acme,
          issueDate: '2026-12-15',
          lines: services('10000.00'),
        },
        { outbox },
      );
      return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
    });
    await expectGolden(inv.entryId ?? '', 'GP-022a', acme);
    const prepayment = await f.inTenant((trx) =>
      trx
        .selectFrom('app.customer_prepayment')
        .select('id')
        .where('party_id', '=', acme)
        .executeTakeFirstOrThrow(),
    );
    const applied = await f.inTenant((trx) =>
      applyPrepayment(trx, {
        companyId: f.companyId,
        prepaymentId: prepayment.id,
        invoiceId: inv.invoiceId,
        applicationDate: '2026-12-15',
      }),
    );
    expect(applied).toMatchObject({ net: '3000.0000', tax: '300.0000', unappliedNet: '0.0000' });
    await expectGolden(applied.entryId, 'GP-022b', acme);
    const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, inv.entryId ?? ''));
    expect(item?.openAmount).toBe('7700.0000');
    const again = await f
      .inTenant((trx) =>
        applyPrepayment(trx, {
          companyId: f.companyId,
          prepaymentId: prepayment.id,
          invoiceId: inv.invoiceId,
          applicationDate: '2026-12-16',
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as PrepaymentError,
      );
    expect(again?.code).toBe('NOTHING_TO_APPLY');
  });

  it('SS-PLAT-105 the BAS reports the project GST once: 300.00 in November, 700.00 in December', async () => {
    const nov = await f.inTenant((trx) =>
      basLabels(trx, {
        companyId: f.companyId,
        basis: 'accrual',
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    );
    expect({ G1: nov.G1, '1A': nov['1A'] }).toEqual({ G1: '3300.0000', '1A': '300.0000' });
    const dec = await f.inTenant((trx) =>
      basLabels(trx, {
        companyId: f.companyId,
        basis: 'accrual',
        from: '2026-12-01',
        to: '2026-12-31',
      }),
    );
    expect({ G1: dec.G1, '1A': dec['1A'] }).toEqual({ G1: '7700.0000', '1A': '700.0000' });
  });

  it('a security deposit is untaxed (GP-012 shape): Cr customer prepayments gross, no GST', async () => {
    const p = await f.inTenant((trx) =>
      recordPrepayment(trx, {
        companyId: f.companyId,
        partyId: customers[1] ?? '',
        receiptDate: '2026-11-11',
        gross: '500.00',
        supplyType: 'security_deposit',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'bond-1',
      }),
    );
    expect(p).toMatchObject({ net: '500.0000', tax: '0.0000' });
    const lines = await f.inTenant((trx) =>
      trx
        .selectFrom('app.journal_line')
        .select(['debit', 'credit'])
        .where('entry_id', '=', p.entryId)
        .execute(),
    );
    expect(lines).toHaveLength(2);
  });
});

describe('Deposit invoice, then the final invoice net of the deposit (GP-014, GP-015)', () => {
  it('SS-PLAT-105 a 30 % deposit invoice posts GP-014; once paid, the final invoice posts GP-015 and is 7,700.00 open', async () => {
    const bolt = customers[1] ?? '';
    const dep = await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: bolt,
          issueDate: '2026-11-02',
          kind: 'deposit',
          lines: services('3000.00'),
        },
        { outbox },
      );
      return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
    });
    await expectGolden(dep.entryId ?? '', 'GP-014', bolt);
    await f.inTenant((trx) =>
      recordReceipt(trx, {
        companyId: f.companyId,
        partyId: bolt,
        receiptDate: '2026-11-20',
        amount: '3300.00',
        method: 'eft',
        depositTo: { accountId: f.acct['1010'] ?? '' },
        idempotencyKey: 'dep-paid',
        allocations: [{ invoiceId: dep.invoiceId, amount: '3300.00' }],
      }),
    );
    const fin = await f.inTenant(async (trx) => {
      const d = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: bolt,
          issueDate: '2026-12-15',
          depositInvoiceIds: [dep.invoiceId],
          lines: services('10000.00'),
        },
        { outbox },
      );
      return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
    });
    expect(fin.gross).toBe('7700.0000');
    await expectGolden(fin.entryId ?? '', 'GP-015', bolt);
    const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, fin.entryId ?? ''));
    expect(item?.openAmount).toBe('7700.0000');
  });
});
