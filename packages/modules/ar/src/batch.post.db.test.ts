/**
 * Batch billing run — approve and post (T-0044, UC-02, DL-0272), against a real PostgreSQL as
 * lf_app. One job posts every previewed invoice, each in its own transaction; a failure lands in
 * the exception list without touching the others and consumes no invoice number; a re-run after a
 * crash continues without duplicates.
 */
import { sql } from 'kysely';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBatch, batchSummary, previewBatch, runBatch, type BatchError } from './batch.ts';
import type { DocumentEvent, DocumentOutbox } from './invoices.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let profiles: SeededProfiles;
let october: string[] = [];
let november: string[] = [];
const events: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_t, e) => {
    events.push(e);
  },
};
let approver = '';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004401');
  profiles = await seedBillingCompany(f);
  october = await seedBillableCustomers(f, profiles, {
    count: 40,
    prefix: 'Oct',
    billDate: '2026-10-01',
  });
  november = await seedBillableCustomers(f, profiles, {
    count: 40,
    prefix: 'Nov',
    billDate: '2026-11-01',
  });
  approver = await f.addUser('approver');
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const preview = (from: string, to: string, key: string) =>
  f.inTenant((trx) =>
    previewBatch(trx, {
      companyId: f.companyId,
      periodFrom: from,
      periodTo: to,
      idempotencyKey: key,
    }),
  );
const run = (batchId: string, limit?: number) =>
  runBatch(
    f.db,
    f.tenantId,
    { companyId: f.companyId, batchId, ...(limit ? { limit } : {}) },
    { outbox },
  );

/** Invoice numbers "INV-000123" → 123. */
const numberOf = (no: string | null) => Number.parseInt((no ?? '').replace(/^INV-/, ''), 10);

describe('SS-UC02-02 / SS-UC02-05: Approved batch posts all invoices in one job; a crashed run resumes', () => {
  it('SS-UC02-05 a run killed after 20 invoices, then re-run, leaves 40 invoices and no duplicates', async () => {
    const p = await preview('2026-10-01', '2026-10-31', 'oct-2026');
    expect(p.items).toHaveLength(40);
    const notApproved = await run(p.batchId).catch((e: unknown) => e);
    expect((notApproved as BatchError).code).toBe('BATCH_STATE');
    await f.inTenant((trx) =>
      approveBatch(trx, { companyId: f.companyId, batchId: p.batchId, approvedBy: approver }),
    );
    const first = await run(p.batchId, 20);
    expect(first).toMatchObject({ posted: 20, failed: 0, remaining: 20 });
    const second = await run(p.batchId);
    expect(second).toMatchObject({ posted: 20, failed: 0, remaining: 0, status: 'posted' });
    const third = await run(p.batchId);
    expect(third).toMatchObject({ posted: 0, remaining: 0 });
    const invoices = await f.inTenant((trx) =>
      sql<{ party_id: string; n: number }>`
        SELECT party_id::text, count(*)::int AS n FROM app.sales_invoice
         WHERE party_id = ANY(${sql.val(october)}::uuid[]) GROUP BY party_id`.execute(trx),
    );
    expect(invoices.rows).toHaveLength(40);
    expect(invoices.rows.every((r) => r.n === 1)).toBe(true);
  });

  it('SS-UC02-02 every journal follows the posting rule and the batch summary lists 40 entries', async () => {
    const batch = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_batch')
        .select('id')
        .where('idempotency_key', '=', 'oct-2026')
        .executeTakeFirstOrThrow(),
    );
    const s = await f.inTenant((trx) => batchSummary(trx, f.companyId, batch.id));
    expect(s.rows).toHaveLength(40);
    expect(s.rows.every((r) => r.status === 'posted' && r.invoiceNo && r.entryNo)).toBe(true);
    expect(s.totals).toEqual({ posted: 40, failed: 0, gross: '17600.0000' });
    // Rule (GP-001 shape): Dr AR = invoice gross; Cr revenue per account and Cr GST collected.
    const bad = await f.inTenant((trx) =>
      sql<{ id: string }>`
        SELECT i.id::text FROM app.sales_invoice i
          JOIN app.journal_line l ON l.entry_id = i.entry_id
          JOIN app.account a ON a.id = l.account_id
         WHERE i.party_id = ANY(${sql.val(october)}::uuid[])
         GROUP BY i.id, i.gross_total
        HAVING sum(l.debit) FILTER (WHERE a.code = '1200') <> i.gross_total
            OR sum(l.credit) FILTER (WHERE a.code IN ('4110', '4120', '2310')) <> i.gross_total`.execute(
        trx,
      ),
    );
    expect(bad.rows).toEqual([]);
    const lines = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_line')
        .select('status')
        .where('party_id', 'in', october)
        .execute(),
    );
    expect(lines.every((l) => l.status === 'invoiced')).toBe(true);
    expect(events.filter((e) => e.topic === 'ar.invoice.posted')).toHaveLength(40);
  });
});

describe('SS-UC02-03 / SS-UC02-06: one failure does not roll back the others; numbers stay gapless', () => {
  it('SS-UC02-03 with one party made inactive after the preview, 39 post and 1 is in the exception list with its reason', async () => {
    const p = await preview('2026-11-01', '2026-11-30', 'nov-2026');
    const inactive = november[12] ?? '';
    await f.inTenant((trx) =>
      trx.updateTable('app.party').set({ status: 'archived' }).where('id', '=', inactive).execute(),
    );
    await f.inTenant((trx) =>
      approveBatch(trx, { companyId: f.companyId, batchId: p.batchId, approvedBy: approver }),
    );
    const r = await run(p.batchId);
    expect(r).toMatchObject({ posted: 39, failed: 1, remaining: 0, status: 'posted' });
    const s = await f.inTenant((trx) => batchSummary(trx, f.companyId, p.batchId));
    const failed = s.rows.filter((x) => x.status === 'failed');
    expect(failed).toEqual([
      expect.objectContaining({ partyId: inactive, invoiceNo: null, failureCode: 'INVALID_PARTY' }),
    ]);
    expect(s.totals.posted).toBe(39);
    const posted = await f.inTenant((trx) =>
      trx.selectFrom('app.sales_invoice').select('id').where('party_id', 'in', november).execute(),
    );
    expect(posted).toHaveLength(39);
  });

  it('SS-UC02-06 the 39 posted invoices have consecutive numbers continuing the series; the failure consumed none', async () => {
    const all = await f.inTenant((trx) =>
      trx
        .selectFrom('app.sales_invoice')
        .select('invoice_no')
        .where('status', '=', 'posted')
        .execute(),
    );
    const numbers = all.map((r) => numberOf(r.invoice_no)).sort((a, b) => a - b);
    expect(numbers).toHaveLength(79);
    expect(numbers).toEqual(Array.from({ length: 79 }, (_, i) => i + 1));
  });

  it('approval needs a previewed batch; a posted batch cannot be approved again', async () => {
    const batch = await f.inTenant((trx) =>
      trx
        .selectFrom('app.billing_batch')
        .select('id')
        .where('idempotency_key', '=', 'nov-2026')
        .executeTakeFirstOrThrow(),
    );
    const err = await f
      .inTenant((trx) =>
        approveBatch(trx, { companyId: f.companyId, batchId: batch.id, approvedBy: approver }),
      )
      .catch((e: unknown) => e);
    expect((err as BatchError).code).toBe('BATCH_STATE');
  });
});
