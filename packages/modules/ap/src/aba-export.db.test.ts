/**
 * ABA file of a released supplier payment batch (T-0056, UC-06 step 3, SS-UC06-06, DL-0292),
 * against a real PostgreSQL as lf_app. The operating account's BSB, sealed account number, APCA
 * user id, user name and FI mnemonic come from app.bank_account (T-0058); each supplier's account
 * number is unsealed from app.party_bank_account. The expected file was derived field by field
 * from the RQ-0006 record tables, not from the writer.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPaymentBatchAba, type AbaExportError } from './aba-export.ts';
import { createPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import {
  payablesKms,
  seedPayablesCompany,
  type PayablesFixture,
} from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let clerk = '';
let releaser = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005601');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const exportAba = (batchId: string) =>
  f.inTenant((trx) => exportPaymentBatchAba(trx, payablesKms, { companyId: f.companyId, batchId }));
const refusal = (pr: Promise<unknown>) =>
  pr.then(
    () => undefined,
    (e: unknown) => e as AbaExportError,
  );

describe('SS-UC06-06: ABA file is byte-exact', () => {
  it('SS-UC06-06 a released batch produces the expected ABA file byte for byte; a draft batch is refused', async () => {
    const harbour = await p.addSupplier('Harbour Paper Co', 72);
    const cafe = await p.addSupplier('Café Noël & Sons', 72);
    await p.postBill(harbour, 'HP-77', '1234.56', '2026-11-04');
    await p.postBill(cafe, 'CN Nov 2026', '99.00', '2026-11-05');
    const id = randomUUID();
    const batch = await f.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: f.companyId,
        id,
        paymentDate: '2026-11-06',
        dueBy: '2026-11-06',
        accountId: f.acct['1010'] ?? '',
        createdBy: clerk,
      }),
    );
    expect(batch.batchNo).toBe('PB-000001');

    // A draft batch is never exported.
    expect((await refusal(exportAba(id)))?.code).toBe('NOT_RELEASED');
    // Released, but GL 1010 has no company bank account with ABA details yet.
    await f.inTenant((trx) =>
      releasePaymentBatch(trx, { companyId: f.companyId, batchId: id, releasedBy: releaser }),
    );
    expect((await refusal(exportAba(id)))?.code).toBe('BANK_NOT_CONFIGURED');

    await f.inTenant((trx) =>
      createCompanyBankAccount(trx, payablesKms, f.companyId, {
        glAccountId: f.acct['1010'] ?? '',
        name: 'Operating',
        bsb: '062000',
        accountNumber: '987654321',
        accountName: 'LedgerForce Operating',
        currency: 'AUD',
        apcaUserId: '654321',
        abaUserName: 'LEDGERFORCE OPERATING',
        abaFiMnemonic: 'WBC',
      }),
    );
    const out = await exportAba(id);
    expect(out).toMatchObject({
      batchNo: 'PB-000001',
      fileName: 'PB-000001-20261106.aba',
      paymentCount: 2,
      total: '1333.5600',
    });
    expect(Buffer.from(out.content, 'ascii')).toEqual(
      readFileSync(new URL('../fixtures/aba/released-batch.aba', import.meta.url)),
    );
  });

  it('SS-UC06-06 a batch of another company is not found', async () => {
    const other = randomUUID();
    expect((await refusal(exportAba(other)))?.code).toBe('INVALID_BATCH');
  });
});
