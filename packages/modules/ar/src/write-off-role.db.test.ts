/**
 * The bad-debt write-off finds the ECL allowance by its system role (T-0145, ADR-0068, design
 * §3.2, GP-024). Since T-0117 (ADR-0061) AR_ECL_ALLOWANCE is a bound system role. A company with
 * that role bound and no `ar_settings.ecl_allowance_account_id` can write off a debt against the
 * allowance. The remaining-allowance figure reads the role-bound account. The deprecated setting
 * may only agree with the role; when it differs, the write-off is refused rather than draining a
 * second account. Runs against a real PostgreSQL as lf_app.
 */
import { post } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveInvoice,
  createDraftInvoice,
  setArSettings,
  type DocumentOutbox,
} from './invoices.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';
import { writeOffInvoice } from './write-off.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
let allowanceAccount = '';
const outbox: DocumentOutbox = { publish: async () => {} };

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

/** GP-025 provision posted by role, as the period-end routine will. */
const fundAllowance = (amount: string, date: string, key: string) =>
  f.inTenant((trx) =>
    post(trx, {
      companyId: f.companyId,
      idempotencyKey: key,
      entryDate: date,
      sourceType: 'ar_ecl_adjustment',
      lines: [
        { account: { id: f.acct['6500'] ?? '' }, debit: amount },
        { account: { role: 'AR_ECL_ALLOWANCE' }, credit: amount },
      ],
    }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014501');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Role',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    // Only the bad-debt expense is configured: no ECL allowance account in AR settings.
    await setArSettings(trx, f.companyId, {
      autoApprove: false,
      badDebtAccountId: f.acct['6500'] ?? '',
    });
    allowanceAccount =
      (
        await sql<{ account_id: string }>`
          SELECT account_id::text FROM app.account_role_binding
           WHERE company_id = ${f.companyId} AND role = 'AR_ECL_ALLOWANCE'`.execute(trx)
      ).rows[0]?.account_id ?? '';
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0145: write-off resolves the ECL allowance by role', () => {
  it('the template bound AR_ECL_ALLOWANCE (precondition)', () => {
    expect(allowanceAccount).not.toBe('');
  });

  it('AC-1/AC-3 with no allowance setting, the write-off draws the role-bound allowance (GP-024 shape)', async () => {
    const inv = await invoice(customers[0] ?? '', '2026-08-05');
    await fundAllowance('1000.00', '2026-09-30', 'role-ecl-sep');
    const w = await f.inTenant((trx) =>
      writeOffInvoice(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        writeOffDate: '2026-12-01',
        reason: 'Customer in liquidation',
      }),
    );
    // 1,375.00 open: 125.00 GST adjustment; 1,000.00 from the allowance; 250.00 to expense.
    expect(w).toMatchObject({
      allowance: '1000.0000',
      expense: '250.0000',
      gstAdjustment: '125.0000',
    });
    const allowanceLines = await f.inTenant(
      async (trx) =>
        (
          await sql<{ account_id: string; debit: string }>`
            SELECT account_id::text, debit::text FROM app.journal_line
             WHERE entry_id = ${w.entryId} AND debit > 0 ORDER BY line_no LIMIT 1`.execute(trx)
        ).rows,
    );
    expect(allowanceLines).toEqual([{ account_id: allowanceAccount, debit: '1000.0000' }]);
  });

  it('a deprecated allowance setting that disagrees with the role is refused, nothing posted', async () => {
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, {
        autoApprove: false,
        eclAllowanceAccountId: f.acct['6500'] ?? '',
        badDebtAccountId: f.acct['6500'] ?? '',
      }),
    );
    const inv = await invoice(customers[1] ?? '', '2026-08-06');
    const before = await f.countEntries();
    await expect(
      f.inTenant((trx) =>
        writeOffInvoice(trx, {
          companyId: f.companyId,
          invoiceId: inv.invoiceId,
          writeOffDate: '2026-12-02',
          reason: 'Unrecoverable',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: expect.stringMatching(/AR_ECL_ALLOWANCE/),
    });
    expect(await f.countEntries()).toBe(before);
  });
});
