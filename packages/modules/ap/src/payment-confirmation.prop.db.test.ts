/**
 * Property (T-0057, GP-009, tdd-cycle accounting invariants): for any released batch of 1–4 bills
 * with arbitrary cent amounts across suppliers, the confirmation journal balances (one AP_CONTROL
 * debit per bill, one bank credit of the batch total), every bill ends fully paid, and the AP
 * subledger still equals the AP control account. Amounts are bigint cents formatted as text —
 * never floating point. Default numRuns (100).
 */
import { randomUUID } from 'node:crypto';
import { subledgerReconciliation, subledgerEntriesOf } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPaymentBatch } from './payment-confirmation.ts';
import { createPaymentBatch, releasePaymentBatch } from './payment-batches.ts';
import { seedPayablesCompany, type PayablesFixture } from './testing/payables-fixture.ts';

let f: LedgerFixture;
let p: PayablesFixture;
let suppliers: string[] = [];
let clerk = '';
let releaser = '';
let releaser2 = '';

const text = (cents: bigint) =>
  `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000005702');
  p = await seedPayablesCompany(f);
  clerk = await f.addUser('ap_clerk');
  releaser = await f.addUser('approver');
  releaser2 = await f.addUser('approver');
  suppliers = [];
  for (const name of ['Prop One Pty Ltd', 'Prop Two Pty Ltd', 'Prop Three Pty Ltd']) {
    suppliers.push(await p.addSupplier(name, 72));
  }
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('GP-009 invariants', () => {
  it('SS-UC06-07 any confirmed batch balances, pays every bill and keeps AP subledger = AP control', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            supplier: fc.integer({ min: 0, max: 2 }),
            cents: fc.bigInt({ min: 1n, max: 10n ** 9n }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        async (bills) => {
          run += 1;
          const ids: string[] = [];
          for (const [i, b] of bills.entries()) {
            ids.push(
              await p.postBill(
                suppliers[b.supplier] ?? '',
                `P${String(run)}-${String(i)}`,
                text(b.cents),
                '2026-11-20',
              ),
            );
          }
          const batchId = randomUUID();
          await f.inTenant((trx) =>
            createPaymentBatch(trx, {
              companyId: f.companyId,
              id: batchId,
              paymentDate: '2026-11-20',
              dueBy: '2026-11-20',
              accountId: f.acct['1010'] ?? '',
              createdBy: clerk,
            }),
          );
          // Above the two-releaser threshold a second, distinct releaser completes the release.
          for (const by of [releaser, releaser2]) {
            const r = await f.inTenant((trx) =>
              releasePaymentBatch(trx, { companyId: f.companyId, batchId, releasedBy: by }),
            );
            if (r.status === 'released') break;
          }
          const c = await f.inTenant((trx) =>
            confirmPaymentBatch(trx, {
              companyId: f.companyId,
              batchId,
              confirmedOn: '2026-11-21',
            }),
          );
          const total = bills.reduce((s, b) => s + b.cents, 0n);
          const lines = await f.inTenant(
            async (trx) =>
              (
                await sql<{ code: string; debit: string; credit: string }>`
                  SELECT a.code, l.debit::text, l.credit::text FROM app.journal_line l
                    JOIN app.account a ON a.id = l.account_id
                   WHERE l.entry_id = ${c.entryId} ORDER BY l.line_no`.execute(trx)
              ).rows,
          );
          expect(lines).toHaveLength(bills.length + 1);
          const dr = lines.reduce((s, l) => s.plus(l.debit), new Decimal(0));
          const cr = lines.reduce((s, l) => s.plus(l.credit), new Decimal(0));
          expect(dr.equals(cr)).toBe(true);
          expect(cr.equals(text(total))).toBe(true);
          expect(lines.at(-1)).toMatchObject({ code: '1010', debit: '0.0000' });
          for (const billId of ids) {
            const e = await f.inTenant(
              async (trx) =>
                (
                  await trx
                    .selectFrom('app.supplier_bill')
                    .select('entry_id')
                    .where('id', '=', billId)
                    .executeTakeFirstOrThrow()
                ).entry_id ?? '',
            );
            const [item] = await f.inTenant((trx) => subledgerEntriesOf(trx, e));
            expect(item?.openAmount).toBe('0.0000');
          }
          const rec = await f.inTenant((trx) =>
            subledgerReconciliation(trx, { companyId: f.companyId }),
          );
          expect(rec.find((r) => r.controlRole === 'AP_CONTROL')?.reconciled).toBe(true);
        },
      ),
    );
  }, 600_000);
});
