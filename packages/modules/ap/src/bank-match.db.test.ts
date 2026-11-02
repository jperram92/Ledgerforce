/**
 * A confirmed supplier payment batch (T-0057, GP-009) is matched automatically to the bank's
 * debit for the batch total when the line carries the batch number (T-0060, UC-08 step 2,
 * RQ-0108). Lives in @ledgerforce/ap because ap depends on bank (not the other way round).
 * Real PostgreSQL as lf_app.
 */
import { randomUUID } from 'node:crypto';
import {
  createCompanyBankAccount,
  importStatement,
  listLineMatching,
  runMatching,
  validateCsvMapping,
} from '@ledgerforce/bank';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import { createPaymentBatch, getPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import {
  payablesKms,
  seedPayablesCompany,
  type PayablesFixture,
} from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaser = '';
let treasurer = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000006002');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
  treasurer = await f.addUser('accountant');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC08-03: Exact match auto-matches (supplier payment batch)', () => {
  it('SS-UC08-03 a confirmed 2,200.00 batch and a −2,200.00 line naming its batch number are matched automatically', async () => {
    const supplier = await p.addSupplier('Office Rent Pty Ltd', 72);
    await p.postBill(supplier, 'RENT-NOV', '2200.00', '2026-11-05');
    const batchId = randomUUID();
    await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id: batchId,
        paymentDate: '2026-11-05',
        dueBy: '2026-11-05',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    await f.inTenant((trx) =>
      releasePaymentBatch(trx, { companyId: f.companyId, batchId, releasedBy: releaser }),
    );
    const confirmation = await f.inTenant((trx) =>
      confirmPaymentBatch(trx, {
        companyId: f.companyId,
        batchId,
        confirmedOn: '2026-11-05',
        confirmedBy: treasurer,
      }),
    );
    const { batchNo, total } = await f.inTenant((trx) =>
      getPaymentBatch(trx, f.companyId, batchId),
    );
    expect(total).toBe('2200.0000');

    const bankAccountId = await f.inTenant((trx) =>
      createCompanyBankAccount(trx, payablesKms, f.companyId, {
        name: 'Operating',
        bsb: '062000',
        accountNumber: '12345678',
        accountName: 'Harbour & Co Pty Ltd',
        currency: 'AUD',
        glAccountId: f.acct['1010'] ?? '',
      }),
    );
    const csv = [
      'Date,Description,Reference,Debit,Credit',
      `05/11/2026,Direct entry ${batchNo},,"2,200.00",`,
      '05/11/2026,Direct entry other batch,,"2,200.00",',
    ].join('\n');
    await f.inTenant((trx) =>
      importStatement(trx, {
        bankAccountId,
        content: new TextEncoder().encode(csv),
        csvMapping: validateCsvMapping({
          header: true,
          dateFormat: 'DD/MM/YYYY',
          columns: {
            date: 'Date',
            description: ['Description'],
            reference: 'Reference',
            debit: 'Debit',
            credit: 'Credit',
          },
        }),
      }),
    );

    const run = await f.inTenant((trx) => runMatching(trx, { bankAccountId, runBy: treasurer }));
    expect(run).toMatchObject({ linesConsidered: 2, autoMatched: 1, suggested: 0 });
    const lines = await f.inTenant(
      async (trx) =>
        (
          await sql<{ id: string; description: string; status: string }>`
            SELECT id::text, description, status FROM app.bank_statement_line
             WHERE bank_account_id = ${bankAccountId} ORDER BY line_no`.execute(trx)
        ).rows,
    );
    expect(lines.map((l) => l.status)).toEqual(['matched', 'unmatched']);
    const m = await f.inTenant((trx) => listLineMatching(trx, lines[0]?.id ?? ''));
    expect(m.match).toMatchObject({
      sourceKind: 'supplier_payment',
      sourceId: batchId,
      journalEntryId: confirmation.entryId,
      method: 'auto_exact',
    });
  });
});
