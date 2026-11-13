/**
 * Month-end close checklist (T-0078, UC-10, DL-0404) against a real PostgreSQL as lf_app. Steps are
 * recorded with user, time and the period status they leave. The order is enforced and status
 * steps go through the period permissions (period.lock / period.close). The bank step's real check
 * (statement lines not covered by a completed reconciliation) is tested with real bank data in
 * packages/modules/bank/src/reconciliation.db.test.ts (SS-UC10-07); here the bank port reports
 * accounts fully reconciled or not as the scenario needs.
 */
import { findPeriod } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSE_STEPS,
  closeChecklist,
  completeCloseStep,
  type CloseDeps,
  type UnreconciledBankAccount,
} from './close-checklist.ts';

let f: LedgerFixture;
let financeAdmin = '';
let arClerk = '';
let october = '';
let unreconciled: UnreconciledBankAccount[] = [];
const deps: CloseDeps = { unreconciledBank: async () => unreconciled };

const step = (s: (typeof CLOSE_STEPS)[number], by = financeAdmin) =>
  f.inTenant((trx) =>
    completeCloseStep(trx, { companyId: f.companyId, periodId: october, step: s, by }, deps),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007801');
  financeAdmin = await f.addUser('finance_admin');
  arClerk = await f.addUser('ar_clerk');
  await f.inTenant(async (trx) => {
    // The ledger fixture already has the fiscal year containing October 2026.
    october = (await findPeriod(trx, f.companyId, '2026-10-15'))?.id ?? '';
  });
  expect(october).not.toBe('');
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC10-01: Checklist steps recorded with user and time', () => {
  it('the checklist lists the seven steps in order, none done', async () => {
    const list = await f.inTenant((trx) =>
      closeChecklist(trx, { companyId: f.companyId, periodId: october }),
    );
    expect(list.map((s) => s.step)).toEqual([
      'ar_lock',
      'ap_lock',
      'bank_recs',
      'accruals',
      'tb_review',
      'soft_close',
      'hard_lock',
    ]);
    expect(list.every((s) => s.completedBy === null && s.completedAt === null)).toBe(true);
  });

  it('a step cannot be completed before the step before it', async () => {
    await expect(step('bank_recs')).rejects.toMatchObject({ code: 'OUT_OF_ORDER' });
  });

  it('a user without period.lock cannot complete the AR lock step (nothing recorded)', async () => {
    await expect(step('ar_lock', arClerk)).rejects.toThrow(/period\.lock|permission/i);
    const list = await f.inTenant((trx) =>
      closeChecklist(trx, { companyId: f.companyId, periodId: october }),
    );
    expect(list[0]?.completedBy).toBeNull();
  });

  it('SS-UC10-01 the Finance Admin completes each step; each stores user, timestamp and resulting period status', async () => {
    const statusAfter: string[] = [];
    for (const s of CLOSE_STEPS) {
      const before = Date.now();
      const done = await step(s);
      expect(done.step).toBe(s);
      expect(done.completedBy).toBe(financeAdmin);
      expect(done.completedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      statusAfter.push(done.periodStatus);
    }
    expect(statusAfter).toEqual([
      'ar_locked',
      'ap_locked',
      'ap_locked',
      'ap_locked',
      'ap_locked',
      'soft_closed',
      'hard_locked',
    ]);
    const list = await f.inTenant((trx) =>
      closeChecklist(trx, { companyId: f.companyId, periodId: october }),
    );
    expect(list.map((s) => [s.step, s.completedBy, s.periodStatus])).toEqual(
      CLOSE_STEPS.map((s, i) => [s, financeAdmin, statusAfter[i]]),
    );
    expect(list.every((s) => s.completedAt instanceof Date)).toBe(true);
  });

  it('a completed step cannot be completed twice', async () => {
    await expect(step('ar_lock')).rejects.toMatchObject({ code: 'ALREADY_DONE' });
  });
});

describe('T-0078: bank and TB review gates', () => {
  it('the bank step is refused while the port reports unreconciled accounts, naming them', async () => {
    let november = '';
    await f.inTenant(async (trx) => {
      november = (await findPeriod(trx, f.companyId, '2026-11-15'))?.id ?? '';
    });
    const nov = (s: (typeof CLOSE_STEPS)[number]) =>
      f.inTenant((trx) =>
        completeCloseStep(
          trx,
          { companyId: f.companyId, periodId: november, step: s, by: financeAdmin },
          deps,
        ),
      );
    await nov('ar_lock');
    await nov('ap_lock');
    unreconciled = [{ bankAccountId: 'b1', name: 'Operating', unreconciledLines: 3 }];
    await expect(nov('bank_recs')).rejects.toMatchObject({
      code: 'BANK_UNRECONCILED',
      accounts: unreconciled,
      message: expect.stringContaining('Operating (3 lines)'),
    });
    unreconciled = [];
    await expect(nov('bank_recs')).resolves.toMatchObject({ step: 'bank_recs' });
  });
});
