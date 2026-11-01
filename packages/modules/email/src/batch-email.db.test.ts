/**
 * SS-UC02-04 — a posted batch emails each invoice's PDF to its Billing To and CC contacts
 * (T-0044 + T-0042, UC-02 step 5). Real PostgreSQL, real batch job, real Chromium PDFs, real SMTP
 * to an in-process sink.
 */
import { randomUUID } from 'node:crypto';
import { approveBatch, previewBatch, runBatch, type DocumentEvent } from '@ledgerforce/ar';
import { seedBillableCustomers, seedBillingCompany } from '@ledgerforce/ar/testing';
import { PdfRenderer } from '@ledgerforce/documents';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceEmailHandler } from './invoice-email.ts';
import { SmtpSender } from './sender.ts';
import { SmtpSink } from './testing/smtp-sink.ts';

let f: LedgerFixture;
const sink = new SmtpSink();
const renderer = new PdfRenderer();
const events: DocumentEvent[] = [];
let customers: string[] = [];

beforeAll(async () => {
  await sink.start();
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004402');
  await f.inTenant((trx) =>
    trx
      .updateTable('app.company')
      .set({ legal_name: 'Harbour Co Pty Ltd', abn: '51824753556' })
      .where('id', '=', f.companyId)
      .execute(),
  );
  const profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 40,
    prefix: 'Mail',
    billDate: '2026-11-01',
    withCc: true,
  });
}, 180_000);

afterAll(async () => {
  await renderer.close();
  await sink.stop();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC02-04: PDFs emailed to Billing To and CC', () => {
  it('SS-UC02-04 a batch of 40 with one inactive party sends 39 emails, each To its Billing To, Cc its CC, PDF attached', async () => {
    const approver = await f.addUser('approver');
    const p = await f.inTenant((trx) =>
      previewBatch(trx, {
        companyId: f.companyId,
        periodFrom: '2026-11-01',
        periodTo: '2026-11-30',
        idempotencyKey: 'mail-nov',
      }),
    );
    await f.inTenant((trx) =>
      trx
        .updateTable('app.party')
        .set({ status: 'archived' })
        .where('id', '=', customers[4] ?? '')
        .execute(),
    );
    await f.inTenant((trx) =>
      approveBatch(trx, { companyId: f.companyId, batchId: p.batchId, approvedBy: approver }),
    );
    const r = await runBatch(
      f.db,
      f.tenantId,
      { companyId: f.companyId, batchId: p.batchId },
      {
        outbox: {
          publish: async (_t, e) => {
            events.push(e);
          },
        },
      },
    );
    expect(r).toMatchObject({ posted: 39, failed: 1 });
    const handler = invoiceEmailHandler({
      sender: new SmtpSender({ url: sink.url, from: 'billing@harbour.example' }),
      renderer,
    });
    for (const e of events.filter((x) => x.topic === 'ar.invoice.posted')) {
      await f.inTenant((trx) =>
        handler.handle(trx, {
          id: randomUUID(),
          tenantId: f.tenantId,
          companyId: e.companyId,
          topic: e.topic,
          aggregateType: e.aggregateType,
          aggregateId: e.aggregateId,
          payload: e.payload,
          createdAt: new Date(),
        }),
      );
    }
    expect(sink.messages).toHaveLength(39);
    for (const m of sink.messages) {
      const to = /^To: (ap@mail(\d+)\.example)$/m.exec(m.raw);
      expect(to, m.raw.slice(0, 400)).not.toBeNull();
      expect(m.raw).toMatch(new RegExp(`^Cc: cfo@mail${to?.[2] ?? 'x'}\\.example$`, 'm'));
      expect(m.raw).toMatch(/Content-Type: application\/pdf; name=INV-\d{6}\.pdf/);
      expect([...m.to].sort()).toEqual(
        [`ap@mail${to?.[2] ?? ''}.example`, `cfo@mail${to?.[2] ?? ''}.example`].sort(),
      );
    }
    expect(sink.messages.some((m) => m.raw.includes('ap@mail5.example'))).toBe(false);
  }, 240_000);
});
