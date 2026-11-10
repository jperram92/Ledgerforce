/** GP-038: gross allowance, statutory GST relief, then explicit remeasurement. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { post, subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture } from '@ledgerforce/ledger/testing';
import { Money } from '@ledgerforce/shared/money';
import { basLabels } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { approveInvoice, createDraftInvoice, setArSettings } from './invoices.ts';
import { writeOffInvoice } from './write-off.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

it('SS-PLAT-106 GP-038 preserves the residual until reassessment and reports relief only on accruals', async () => {
  const goldens = approvedTables(
    parsePostings(
      readFileSync(resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md'), 'utf8'),
    ),
  ).filter((t) => t.entryId === 'GP-038');
  expect(goldens).toHaveLength(3);
  const f = await createLedgerFixture('01900000-0000-7000-8000-000000016601');
  try {
    const profiles = await seedBillingCompany(f);
    const [partyId = ''] = await seedBillableCustomers(f, profiles, {
      count: 1,
      prefix: 'Gross',
      billDate: '2026-11-01',
    });
    const outbox = { publish: async () => {} };
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, {
        autoApprove: false,
        eclAllowanceAccountId: f.acct['1220'] ?? '',
        badDebtAccountId: f.acct['6500'] ?? '',
      }),
    );
    const invoice = await f.inTenant(async (trx) => {
      const draft = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId,
          issueDate: '2026-08-05',
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
      return approveInvoice(
        trx,
        { companyId: f.companyId, invoiceId: draft.invoiceId },
        { outbox },
      );
    });
    const allowance = await f.inTenant((trx) =>
      post(trx, {
        companyId: f.companyId,
        idempotencyKey: 'gross-ecl',
        entryDate: '2026-09-30',
        sourceType: 'ar_ecl_adjustment',
        lines: [
          { account: { id: f.acct['6500'] ?? '' }, debit: '1375.00' },
          { account: { id: f.acct['1220'] ?? '' }, credit: '1375.00' },
        ],
      }),
    );
    const writeoff = await f.inTenant((trx) =>
      writeOffInvoice(trx, {
        companyId: f.companyId,
        invoiceId: invoice.invoiceId,
        writeOffDate: '2026-12-01',
        reason: 'Written off as unrecoverable following liquidation assessment',
      }),
    );
    expect(writeoff).toMatchObject({
      gross: '1375.0000',
      allowance: '1250.0000',
      expense: '0.0000',
      gstAdjustment: '125.0000',
    });
    const balance = (code: string) =>
      f.inTenant(
        async (trx) =>
          (
            await sql<{
              amount: string;
            }>`SELECT sum(l.debit - l.credit)::text AS amount FROM app.journal_line l JOIN app.account a ON a.id=l.account_id WHERE a.id=${f.acct[code] ?? ''}`.execute(
              trx,
            )
          ).rows[0]?.amount,
      );
    expect(await balance('1220')).toBe('-125.0000');
    const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, invoice.entryId ?? ''));
    expect(item?.openAmount).toBe('0.0000');
    const release = await f.inTenant((trx) =>
      post(trx, {
        companyId: f.companyId,
        idempotencyKey: 'ecl-reassessment',
        entryDate: '2026-12-31',
        sourceType: 'ar_ecl_adjustment',
        lines: [
          { account: { id: f.acct['1220'] ?? '' }, debit: '125.00' },
          { account: { id: f.acct['6500'] ?? '' }, credit: '125.00' },
        ],
      }),
    );
    expect(await balance('1220')).toBe('0.0000');
    expect(await balance('6500')).toBe('1250.0000');
    const bindings: Record<string, string> = {
      'setting:ar.bad_debt_account': '6500',
      'system:AR_ECL_ALLOWANCE': '1220',
      'tax:GST.collected': '2200',
      'system:AR_CONTROL': '1200',
    };
    for (const [index, id] of [allowance.entryId, writeoff.entryId, release.entryId].entries()) {
      const rows = await f.inTenant(
        async (trx) =>
          (
            await sql<{
              code: string;
              debit: string;
              credit: string;
              party: string | null;
            }>`SELECT a.code, l.debit::text, l.credit::text, l.party_id::text AS party FROM app.journal_line l JOIN app.account a ON a.id=l.account_id WHERE l.entry_id=${id} ORDER BY l.line_no`.execute(
              trx,
            )
          ).rows,
      );
      expect(rows).toEqual(
        goldens[index]?.lines.map((line) => ({
          code: bindings[line.binding],
          debit: Money.of(line.debit, 'AUD').toNumericString(),
          credit: Money.of(line.credit, 'AUD').toNumericString(),
          party: line.party ? partyId : null,
        })),
      );
    }
    for (const basis of ['accrual', 'cash'] as const) {
      const labels = await f.inTenant((trx) =>
        basLabels(trx, { companyId: f.companyId, from: '2026-12-01', to: '2026-12-31', basis }),
      );
      expect(labels['1B']).toBe(basis === 'accrual' ? '125.0000' : '0.0000');
      const releaseDay = await f.inTenant((trx) =>
        basLabels(trx, { companyId: f.companyId, from: '2026-12-31', to: '2026-12-31', basis }),
      );
      expect(releaseDay['1B']).toBe('0.0000');
      expect(releaseDay['1A']).toBe('0.0000');
    }
  } finally {
    await f.close();
  }
}, 180_000);
