/**
 * Bad-debt write-off through the expected-credit-loss allowance (T-0048, design §3.8 row 5,
 * GP-024 (supersedes GP-007), GP-025, Q3, RQ-0090, DL-0276), against a real PostgreSQL as lf_app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { post, subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { basLabels } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveInvoice,
  createDraftInvoice,
  setArSettings,
  type DocumentOutbox,
} from './invoices.ts';
import { writeOffInvoice, type WriteOffError } from './write-off.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp024 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-024',
);

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };
const codeOf: Record<string, string> = {};
const money = (s: string) => (s === '0' ? '0.0000' : `${s}${s.includes('.') ? '00' : '.0000'}`);

async function invoice(partyId: string, date: string) {
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
/** GP-025: period-end allowance movement (Dr impairment / Cr ECL allowance). */
const fundAllowance = (amount: string, date: string, key: string) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: key,
      entryDate: date,
      sourceType: 'ar_ecl_adjustment',
      lines: [
        { account: { id: f.acct['6500'] ?? '' }, debit: amount },
        { account: { id: f.acct['1220'] ?? '' }, credit: amount },
      ],
    }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004801');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Gone',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    await setArSettings(trx, f.companyId, {
      autoApprove: false,
      eclAllowanceAccountId: f.acct['1220'] ?? '',
      badDebtAccountId: f.acct['6500'] ?? '',
    });
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
    codeOf['system:AR_ECL_ALLOWANCE'] = '1220';
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0048: bad-debt write-off (GP-024)', () => {
  it('SS-PLAT-106 writing off a 1,375.00 invoice fully covered by the allowance posts exactly GP-024 and closes the invoice', async () => {
    const acme = customers[0] ?? '';
    const inv = await invoice(acme, '2026-08-05');
    await fundAllowance('1250.00', '2026-09-30', 'ecl-sep');
    const w = await f.inTenant((trx) =>
      writeOffInvoice(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        writeOffDate: '2026-12-01',
        reason: 'Customer in liquidation; debt overdue 12 months',
      }),
    );
    expect(w).toMatchObject({
      gross: '1375.0000',
      allowance: '1250.0000',
      expense: '0.0000',
      gstAdjustment: '125.0000',
    });
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${w.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    expect(rows).toHaveLength(gp024?.lines.length ?? -1);
    gp024?.lines.forEach((g, i) => {
      const at = `GP-024 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
    const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, inv.entryId ?? ''));
    expect(item?.openAmount).toBe('0.0000');
  });

  it('SS-PLAT-106 the BAS shows the decreasing adjustment 1B +125.00 on accruals and nothing on cash', async () => {
    const q = { companyId: f.companyId, from: '2026-12-01', to: '2026-12-31' };
    const accrual = await f.inTenant((trx) => basLabels(trx, { ...q, basis: 'accrual' }));
    expect(accrual['1B']).toBe('125.0000');
    const cash = await f.inTenant((trx) => basLabels(trx, { ...q, basis: 'cash' }));
    expect({ '1A': cash['1A'], '1B': cash['1B'], G1: cash.G1 }).toEqual({
      '1A': '0.0000',
      '1B': '0.0000',
      G1: '0.0000',
    });
  });

  it('SS-PLAT-106 when the allowance holds only 1,000.00 the rest goes to the bad-debt expense (GP-024 variant)', async () => {
    const bolt = customers[1] ?? '';
    const inv = await invoice(bolt, '2026-08-06');
    await fundAllowance('1000.00', '2026-10-31', 'ecl-oct');
    const w = await f.inTenant((trx) =>
      writeOffInvoice(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        writeOffDate: '2026-12-02',
        reason: 'Unrecoverable',
      }),
    );
    expect(w).toMatchObject({
      allowance: '1000.0000',
      expense: '250.0000',
      gstAdjustment: '125.0000',
    });
    const again = await f
      .inTenant((trx) =>
        writeOffInvoice(trx, {
          companyId: f.companyId,
          invoiceId: inv.invoiceId,
          writeOffDate: '2026-12-03',
          reason: 'again',
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as WriteOffError,
      );
    expect(again?.code).toBe('NOTHING_OPEN');
  });

  it('a write-off needs a written reason', async () => {
    const inv = await invoice(customers[1] ?? '', '2026-08-07');
    const err = await f
      .inTenant((trx) =>
        writeOffInvoice(trx, {
          companyId: f.companyId,
          invoiceId: inv.invoiceId,
          writeOffDate: '2026-12-04',
          reason: ' ',
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e as WriteOffError,
      );
    expect(err?.code).toBe('INVALID_WRITE_OFF');
  });
});
