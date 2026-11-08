/**
 * Golden postings GP-001 and GP-018a/b produced by the sales-invoice code (T-0040, SS-PLAT-12
 * runner, DL-0246 limitation lifted for these entries). The producer builds an invoice document
 * from the GP scenario, auto-approves it under the threshold and posts it through the posting
 * engine; the stored journal must equal the Approved golden line for line (runGolden).
 *
 * SS-UC01-03 — auto-approve under a $2,000 threshold posts exactly GP-001, numbered INV-…, and
 *   one `ar.invoice.posted` notification to the Billing To contact is written to the
 *   transactional outbox in the posting transaction (the SMTP send is T-0042).
 * SS-UC01-11 — three $3.35 GST-inclusive lines: per_line → GP-018a, per_document → GP-018b.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withTenant, type Database } from '@ledgerforce/db';
import {
  expectedLines,
  goldenModeFrom,
  parseGoldenPostings,
  planGoldenRun,
  repoGoldenGate,
  runGolden,
  type GoldenPosting,
  type GoldenProducer,
  type GoldenWorld,
  type LineView,
} from '@ledgerforce/ledger/golden';
import { storedJournal } from '@ledgerforce/ledger/testing';
import { createGoldenWorld, type GoldenFixture } from '@ledgerforce/ledger/testing/golden-world';
import { ledgerOutbox } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { sql, type Transaction } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVOICE_POSTED_TOPIC, invoiceOutboxNotifier } from './notifier.ts';
import {
  autoApproveSalesInvoice,
  createSalesInvoice,
  getSalesInvoice,
  type SalesInvoiceInput,
} from './sales-invoices.ts';
import {
  addBillingTo,
  makeCustomer,
  setupInvoicing,
  type InvoiceWorld,
} from './testing/invoice-world.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const IDS = ['GP-001', 'GP-018'];
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8')).filter((gp) =>
  IDS.includes(gp.id),
);
const plan = planGoldenRun(postings, goldenModeFrom(process.env), repoGoldenGate(REPO));
const AUTO = { autoApprove: true, threshold: '2000.0000' } as const;
const BILLING_TO = 'accounts@acme.example';

let g: GoldenFixture;
let h: OutboxHarness;
let boss: PgBoss;
let w: InvoiceWorld;
let world: GoldenWorld;
let acme: string;
let gstId: string;
const posted: { gp: string; invoiceId: string; invoiceNo: string; entryId: string }[] = [];

const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
  withTenant(h.app, g.fixture.tenantId, fn);

/** The invoice document each golden scenario describes (postings.md "Scenario"). */
function documentFor(gp: GoldenPosting): Omit<SalesInvoiceInput, 'companyId' | 'partyId'> {
  if (gp.id === 'GP-001') {
    // INV-000123 dated 2026-11-05, terms 14 days; $1,000 services + $250 subscription ex GST.
    return {
      invoiceDate: '2026-11-05',
      dueDate: '2026-11-19',
      amountsAre: 'exclusive',
      lines: [
        {
          productId: w.products.PROFESSIONAL_SERVICES,
          description: 'Professional services',
          amount: '1000.00',
        },
        { productId: w.products.SUBSCRIPTION, description: 'Subscription', amount: '250.00' },
      ],
    };
  }
  // GP-018: three Subscription add-on lines, each $3.35 GST-inclusive; no date → runner default.
  return {
    invoiceDate: '2026-11-05',
    dueDate: '2026-11-05',
    amountsAre: 'inclusive',
    lines: [1, 2, 3].map((n) => ({
      productId: w.products.SUBSCRIPTION,
      description: `Subscription add-on ${String(n)}`,
      amount: '3.35',
    })),
  };
}

/** 18a = per_line (AU default), 18b = per_document (company setting, design §3.4). */
const roundingFor = (gp: GoldenPosting, index: number) =>
  gp.id === 'GP-018' && index === 1 ? 'per_document' : 'per_line';

const produce: GoldenProducer = async (gp, index) => {
  const expected = expectedLines(gp, index, world);
  const companyId = g.fixture.companyId;
  const result = await inTenant(async (trx) => {
    await sql`UPDATE app.company SET tax_rounding = ${roundingFor(gp, index)} WHERE id = ${companyId}`.execute(
      trx,
    );
    const { id } = await createSalesInvoice(trx, {
      input: { companyId, partyId: acme, ...documentFor(gp) },
      createdBy: null,
      idempotencyKey: `golden:${gp.id}:${String(index)}:${randomUUID()}`,
    });
    // SS-UC01-03: "when the draft is created" with auto-approve on → approved and posted.
    const r = await autoApproveSalesInvoice(trx, {
      id,
      settings: AUTO,
      outbox: ledgerOutbox(boss),
      notifier: invoiceOutboxNotifier(boss),
    });
    if (r.outcome !== 'posted')
      throw new Error(`${gp.id}: auto-approval left a draft (${r.reason})`);
    const doc = await getSalesInvoice(trx, id);
    return {
      id,
      entryId: r.entryId,
      invoiceNo: doc.invoiceNo ?? '',
      journal: await storedJournal(trx, r.entryId),
    };
  });
  posted.push({
    gp: gp.id,
    invoiceId: result.id,
    invoiceNo: result.invoiceNo,
    entryId: result.entryId,
  });
  const actual: LineView[] = result.journal.lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    accountLabel: l.accountId,
    debit: l.debit,
    credit: l.credit,
    taxCodeId: l.taxCodeId,
    taxLabel: l.taxCodeId === gstId ? 'GST' : l.taxCodeId,
    taxAmount: l.taxAmount,
    partyId: l.partyId,
    partyLabel: l.partyId === null ? null : world.partyLabel(l.partyId),
  }));
  return { expected, actual };
};

beforeAll(async () => {
  g = await createGoldenWorld('01900000-0000-7000-8000-000000004002');
  h = await createOutboxHarness(g.fixture.tdb);
  boss = await h.startRuntime();
  const companyId = g.fixture.companyId;
  const party = g.world.partyId('Acme');
  if (party === undefined) throw new Error('golden world has no Acme');
  acme = party;
  w = await inTenant(async (trx) => {
    const r = await setupInvoicing(trx, companyId);
    await makeCustomer(trx, companyId, acme);
    await addBillingTo(trx, companyId, acme, BILLING_TO);
    return r;
  });
  gstId = await inTenant(async (trx) => {
    const r = await sql<{ id: string }>`
      SELECT id::text FROM app.tax_code WHERE company_id = ${companyId} AND code = 'GST'`.execute(
      trx,
    );
    return r.rows[0]?.id ?? '';
  });
  // The golden's tax code GST is the company's real tax_code row now (T-0034), not a fixed id.
  world = { ...g.world, taxCodeId: (code) => (code === 'GST' ? gstId : undefined) };
});

afterAll(async () => {
  await h?.close();
  await g?.close();
});

describe('T-0040 golden postings produced by the sales-invoice code', () => {
  it('GP-001 and GP-018 are Approved, in phase and run (not PENDING)', () => {
    expect(plan.map((p) => [p.gp.id, p.label, p.run])).toEqual([
      ['GP-001', 'APPROVED', true],
      ['GP-018', 'APPROVED', true],
    ]);
  });

  it('SS-UC01-03: Auto-approve under threshold posts GP-001 and emails', async () => {
    const p = plan.find((x) => x.gp.id === 'GP-001');
    if (!p) throw new Error('GP-001 missing from postings.md');
    const outcome = await runGolden(p, produce);
    expect(outcome.status, outcome.report).toBe('PASS');
    const doc = posted.find((x) => x.gp === 'GP-001');
    if (!doc) throw new Error('GP-001 posted nothing');
    expect(doc.invoiceNo).toMatch(/^INV-\d{6}$/);
    const events = await g.fixture.admin.query<{
      topic: string;
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT topic, aggregate_type, payload FROM app.outbox_event
        WHERE tenant_id = $1 AND aggregate_id = $2`,
      [g.fixture.tenantId, doc.invoiceId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      topic: INVOICE_POSTED_TOPIC,
      aggregate_type: 'sales_invoice',
      payload: {
        invoiceId: doc.invoiceId,
        invoiceNo: doc.invoiceNo,
        entryId: doc.entryId,
        partyId: acme,
        to: [BILLING_TO],
        cc: [],
        total: '1375.0000',
      },
    });
  });

  it('SS-UC01-11: Tax-inclusive rounding follows company setting', async () => {
    const p = plan.find((x) => x.gp.id === 'GP-018');
    if (!p) throw new Error('GP-018 missing from postings.md');
    expect(p.gp.journals.map((j) => j.label)).toHaveLength(2);
    const outcome = await runGolden(p, produce);
    expect(outcome.status, outcome.report).toBe('PASS');
    expect(outcome.report).toMatch(/18a/);
    expect(outcome.report).toMatch(/18b/);
  });
});
