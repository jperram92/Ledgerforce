/**
 * Overdue reminders (T-0068, UC-04 MVP, DL-0402) against a real PostgreSQL as lf_app: the daily run
 * queues reminder 1 at 7 days overdue, once per invoice and step, and publishes the Salesforce
 * write-back that sets Account.LF_Credit_Status__c = "Overdue". Email delivery of the queued
 * reminder is tested in @ledgerforce/email (reminder-email.db.test.ts).
 */
import {
  mapToRecords,
  parseWriteBackPayload,
  planBatches,
} from '@ledgerforce/connector-salesforce';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveInvoice, createDraftInvoice, type DocumentEvent } from './invoices.ts';
import {
  INVOICE_OVERDUE,
  REMINDER_QUEUED,
  runOverdueReminders,
  seedReminderSchedule,
} from './reminders.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let acme = '';
let invoiceId = '';
let invoiceNo = '';
const published: DocumentEvent[] = [];
const outbox = {
  publish: async (_t: unknown, e: DocumentEvent) => {
    published.push(e);
  },
};
const run = (runDate: string) =>
  f.inTenant((trx) => runOverdueReminders(trx, { outbox }, { companyId: f.companyId, runDate }));

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000006801');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Overdue',
    billDate: '2026-11-05',
  });
  await f.inTenant(async (trx) => {
    await trx
      .updateTable('app.party')
      .set({ salesforce_account_id: '001000000000068AAA' })
      .where('id', '=', acme)
      .execute();
    const draft = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId: acme,
        issueDate: '2026-11-05',
        dueDate: '2026-11-19',
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1250.00',
          },
        ],
      },
      { outbox },
    );
    const posted = await approveInvoice(
      trx,
      { companyId: f.companyId, invoiceId: draft.invoiceId },
      { outbox },
    );
    invoiceId = draft.invoiceId;
    invoiceNo = posted.invoiceNo ?? '';
    expect(await seedReminderSchedule(trx, f.companyId)).toBe(1);
    expect(await seedReminderSchedule(trx, f.companyId)).toBe(0);
  });
  published.length = 0;
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0068: the daily reminder run', () => {
  it('queues nothing at 6 days overdue', async () => {
    expect(await run('2026-11-25')).toEqual({ queued: [] });
    expect(published).toEqual([]);
  });

  it('SS-UC04-01 queues reminder 1 for the invoice at 7 days overdue and publishes it', async () => {
    expect(await run('2026-11-26')).toEqual({
      queued: [{ invoiceId, invoiceNo, partyId: acme, step: 1, daysOverdue: 7 }],
    });
    const queued = published.filter((e) => e.topic === REMINDER_QUEUED);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      companyId: f.companyId,
      aggregateType: 'sales_invoice',
      aggregateId: invoiceId,
      payload: {
        invoiceId,
        invoiceNo,
        partyId: acme,
        step: 1,
        runDate: '2026-11-26',
        dueDate: '2026-11-19',
        amountDue: '1375.0000',
      },
    });
  });

  it('SS-UC04-02 the write-back payload sets Account.LF_Credit_Status__c = "Overdue"', () => {
    const overdue = published.filter((e) => e.topic === INVOICE_OVERDUE);
    expect(overdue).toHaveLength(1);
    const requests = planBatches(mapToRecords(parseWriteBackPayload(overdue[0]?.payload)));
    const account = requests.find((r) => r.records.some((x) => x.sobject === 'Account'));
    expect(account?.records).toEqual([{ sobject: 'Account', key: '001000000000068AAA' }]);
    // The exact body Salesforce receives: credit status label and exact decimal money.
    expect(account?.text).toContain('"LF_Credit_Status__c":"Overdue"');
    expect(account?.text).toContain('"LF_Overdue_Amount__c":1375.00');
    expect(account?.text).toContain('"LF_Balance_Due__c":1375.00');
  });

  it('SS-UC04-03 running again the same day (and the next day) queues no second reminder', async () => {
    const before = published.length;
    expect(await run('2026-11-26')).toEqual({ queued: [] });
    expect(await run('2026-11-27')).toEqual({ queued: [] });
    expect(published.length).toBe(before);
    const rows = await f.inTenant((trx) =>
      trx
        .selectFrom('app.ar_reminder')
        .select(['invoice_id', 'step'])
        .where('company_id', '=', f.companyId)
        .execute(),
    );
    expect(rows).toEqual([{ invoice_id: invoiceId, step: 1 }]);
  });

  it('the reminder log is insert-only per invoice and step (database refuses a duplicate)', async () => {
    await expect(
      f.inTenant((trx) =>
        trx
          .insertInto('app.ar_reminder')
          .values({
            company_id: f.companyId,
            invoice_id: invoiceId,
            step: 1,
            run_date: '2026-11-28',
            days_overdue: 9,
            amount_due: '1375.0000',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
