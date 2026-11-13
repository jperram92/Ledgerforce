/**
 * Per-party overdue-reminder pause (T-0129, UC-04 "AR Clerk can pause reminders per party
 * (audited)", SS-UC04-07, RQ-0144) against a real PostgreSQL as lf_app.
 * - A paused party gets no reminder from the daily run; a resumed party gets them again.
 * - The pause history is insert-only and records who, when and why.
 * - Replaying the same Idempotency-Key returns the same row; reusing a key for a different
 *   request is refused.
 * Permission (ar.dunning.run) and the audit.audit_log row are enforced by the API route and tested
 * in apps/api/src/ar/reminder-pause.db.test.ts.
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveInvoice, createDraftInvoice, type DocumentEvent } from './invoices.ts';
import { reminderPauseHistory, ReminderPauseError, setReminderPause } from './reminder-pause.ts';
import { runOverdueReminders, seedReminderSchedule } from './reminders.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let clerk = '';
let paused = '';
let other = '';
const outbox = { publish: async (_t: unknown, _e: DocumentEvent) => {} };
const run = (runDate: string) =>
  f.inTenant((trx) => runOverdueReminders(trx, { outbox }, { companyId: f.companyId, runDate }));
const pause = (p: { paused: boolean; reason: string; key: string; partyId?: string }) =>
  f.inTenant((trx) =>
    setReminderPause(trx, {
      companyId: f.companyId,
      partyId: p.partyId ?? paused,
      paused: p.paused,
      reason: p.reason,
      by: clerk,
      idempotencyKey: p.key,
    }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000012901');
  clerk = await f.addUser('ar_clerk');
  const profiles = await seedBillingCompany(f);
  [paused = '', other = ''] = await seedBillableCustomers(f, profiles, {
    count: 2,
    prefix: 'Pause',
    billDate: '2026-11-05',
  });
  await f.inTenant(async (trx) => {
    for (const partyId of [paused, other]) {
      const draft = await createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId,
          issueDate: '2026-11-05',
          dueDate: '2026-11-19',
          lines: [
            {
              productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
              description: 'Professional services',
              quantity: '1',
              unitPrice: '500.00',
            },
          ],
        },
        { outbox },
      );
      await approveInvoice(trx, { companyId: f.companyId, invoiceId: draft.invoiceId }, { outbox });
    }
    await seedReminderSchedule(trx, f.companyId);
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC04-07: per-party reminder pause', () => {
  it('a reason is required', async () => {
    await expect(pause({ paused: true, reason: '  ', key: 'k-blank' })).rejects.toMatchObject({
      code: 'REASON_REQUIRED',
    });
  });

  it('only a party of the company can be paused', async () => {
    await expect(
      pause({
        paused: true,
        reason: 'Disputed',
        key: 'k-unknown',
        partyId: '01900000-0000-7000-8000-0000000129ff',
      }),
    ).rejects.toBeInstanceOf(ReminderPauseError);
  });

  it('pausing records who, when and why; a replay of the same key returns the same row', async () => {
    const before = Date.now();
    const first = await pause({ paused: true, reason: 'Disputed invoice', key: 'k-pause-1' });
    expect(first.replayed).toBe(false);
    expect(first.pause).toMatchObject({
      partyId: paused,
      paused: true,
      reason: 'Disputed invoice',
      setBy: clerk,
    });
    expect(first.pause.setAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const again = await pause({ paused: true, reason: 'Disputed invoice', key: 'k-pause-1' });
    expect(again).toEqual({ pause: first.pause, replayed: true });
  });

  it('a key reused for a different request is refused', async () => {
    await expect(pause({ paused: false, reason: 'Other', key: 'k-pause-1' })).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
  });

  it('pausing an already paused party is refused (no silent duplicate)', async () => {
    await expect(pause({ paused: true, reason: 'Again', key: 'k-pause-2' })).rejects.toMatchObject({
      code: 'NO_CHANGE',
    });
  });

  it('the daily run skips the paused party and reminds the other', async () => {
    const { queued } = await run('2026-11-26');
    expect(queued.map((q) => q.partyId)).toEqual([other]);
  });

  it('after resuming, the party gets its reminder on the next run; history keeps both rows', async () => {
    const resumed = await pause({ paused: false, reason: 'Dispute settled', key: 'k-resume-1' });
    expect(resumed.pause.paused).toBe(false);
    const { queued } = await run('2026-11-27');
    expect(queued.map((q) => [q.partyId, q.step, q.daysOverdue])).toEqual([[paused, 1, 8]]);
    const history = await f.inTenant((trx) =>
      reminderPauseHistory(trx, { companyId: f.companyId, partyId: paused }),
    );
    expect(history.map((h) => [h.paused, h.reason])).toEqual([
      [true, 'Disputed invoice'],
      [false, 'Dispute settled'],
    ]);
  });

  it('the history is insert-only for lf_app (no UPDATE, no DELETE)', async () => {
    await expect(
      f.inTenant((trx) =>
        trx.updateTable('app.ar_reminder_pause').set({ reason: 'edited' }).execute(),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      f.inTenant((trx) => trx.deleteFrom('app.ar_reminder_pause').execute()),
    ).rejects.toThrow(/permission denied/);
  });
});
