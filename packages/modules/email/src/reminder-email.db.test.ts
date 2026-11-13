/**
 * Overdue reminder email (T-0068, UC-04 MVP, DL-0402) against a real PostgreSQL as lf_app and a
 * real SMTP conversation (SmtpSink): the reminder the daily run queues is emailed to the Billing To
 * contact, once per invoice and step.
 */
import {
  approveInvoice,
  createDraftInvoice,
  runOverdueReminders,
  seedReminderSchedule,
  type DocumentEvent,
} from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REMINDER_QUEUED_TOPIC, reminderEmailHandler } from './reminder-email.ts';
import { SmtpSender } from './sender.ts';
import { SmtpSink } from './testing/smtp-sink.ts';

let f: LedgerFixture;
const sink = new SmtpSink();
let sender: SmtpSender;
let acme = '';
let invoiceNo = '';
const published: DocumentEvent[] = [];
const outbox = {
  publish: async (_t: unknown, e: DocumentEvent) => {
    published.push(e);
  },
};

/** Deliver one published event to the handler the way the outbox worker does (as lf_app). */
const deliver = (e: DocumentEvent, id: string) =>
  f.inTenant((trx) =>
    reminderEmailHandler({ sender }).handle(trx, {
      id,
      tenantId: f.tenantId,
      companyId: e.companyId,
      topic: e.topic,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload,
      createdAt: new Date(),
    }),
  );

beforeAll(async () => {
  await sink.start();
  sender = new SmtpSender({ url: sink.url, from: 'Harbour Co <billing@harbour.example>' });
  f = await createLedgerFixture('01900000-0000-7000-8000-000000006802');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Reminder',
    billDate: '2026-11-05',
    withCc: true,
  });
  await f.inTenant(async (trx) => {
    await trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd' })
      .where('id', '=', f.companyId)
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
    invoiceNo =
      (
        await approveInvoice(
          trx,
          { companyId: f.companyId, invoiceId: draft.invoiceId },
          { outbox },
        )
      ).invoiceNo ?? '';
    await seedReminderSchedule(trx, f.companyId);
  });
  published.length = 0;
}, 120_000);

afterAll(async () => {
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC04-01: Reminder 1 at 7 days overdue', () => {
  it('SS-UC04-01 the Billing To contact receives reminder 1 (SMTP sink), with Billing CC copied', async () => {
    await f.inTenant((trx) =>
      runOverdueReminders(trx, { outbox }, { companyId: f.companyId, runDate: '2026-11-26' }),
    );
    const queued = published.filter((e) => e.topic === REMINDER_QUEUED_TOPIC);
    expect(queued).toHaveLength(1);
    const [event] = queued;
    if (!event) throw new Error('no reminder event');
    await deliver(event, '01900000-0000-7000-8000-0000000068e1');

    expect(sink.messages).toHaveLength(1);
    const [m] = sink.messages;
    expect(m?.to).toEqual(['ap@reminder1.example', 'cfo@reminder1.example']);
    expect(m?.raw).toContain(`Subject: Payment reminder: invoice ${invoiceNo} is overdue`);
    expect(m?.raw).toMatch(/To: ap@reminder1\.example/);
    expect(m?.raw).toMatch(/Cc: cfo@reminder1\.example/);
    expect(m?.raw).toContain('$1,375.00');
    expect(m?.raw).toContain('19 Nov 2026');
    const logged = await f.inTenant((trx) =>
      trx
        .selectFrom('app.email_delivery')
        .select(['purpose', 'dedupe_key'])
        .where('company_id', '=', f.companyId)
        .where('purpose', '=', 'reminder')
        .execute(),
    );
    expect(logged).toEqual([
      { purpose: 'reminder', dedupe_key: `reminder:${event.aggregateId}:1` },
    ]);
  });
});

describe('SS-UC04-03: Reminders are idempotent per step', () => {
  it('SS-UC04-03 a same-day re-run queues nothing and a re-delivered event sends no second email', async () => {
    const before = published.length;
    await f.inTenant((trx) =>
      runOverdueReminders(trx, { outbox }, { companyId: f.companyId, runDate: '2026-11-26' }),
    );
    expect(published.length).toBe(before);
    const [event] = published.filter((e) => e.topic === REMINDER_QUEUED_TOPIC);
    if (!event) throw new Error('no reminder event');
    await deliver(event, '01900000-0000-7000-8000-0000000068e2');
    expect(sink.messages).toHaveLength(1);
  });
});
