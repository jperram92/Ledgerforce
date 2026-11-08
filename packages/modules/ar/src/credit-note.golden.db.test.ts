/**
 * Golden posting GP-005 produced by the credit-note code (T-0045, SS-PLAT-12 runner; GP-001
 * pattern of invoice.golden.db.test.ts). The producer follows the GP-005 scenario: INV-000123
 * (GP-001 lines, 2026-11-05) is posted by the sales-invoice code and paid in full by the GP-002
 * receipt (2026-11-15, allocated); then CN-… credits $200.00 ex GST of the Professional services
 * line on 2026-11-20 — created by the AR Clerk, approved by the Approver, posted through the
 * posting engine. The stored journal must equal the Approved golden line for line (runGolden).
 *
 * SS-UC11-01 — the journal equals GP-005.
 * SS-UC11-02 — the credit on the paid invoice is held as customer credit: Acme's AR open items
 *   net to −220.00 (the credit note's open item), it cannot be allocated to the paid invoice, and
 *   AR subledger = AR control.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import {
  AllocationError,
  allocate,
  openItems,
  post,
  subledgerEntriesOf,
  subledgerReconciliation,
} from '@ledgerforce/ledger';
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
import { goldenCommand, GOLDEN_DEFAULT_DATE } from '@ledgerforce/ledger/testing/golden';
import { createGoldenWorld, type GoldenFixture } from '@ledgerforce/ledger/testing/golden-world';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocateCreditNote,
  approveCreditNote,
  createCreditNote,
  creditNoteDocument,
  getCreditNote,
  postCreditNote,
} from './credit-notes.ts';
import {
  postGp001Invoice,
  setupCreditNotes,
  type PostedInvoice,
} from './testing/credit-note-world.ts';
import {
  addBillingTo,
  makeCustomer,
  setupInvoicing,
  type InvoiceWorld,
} from './testing/invoice-world.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const all = parseGoldenPostings(readFileSync(POSTINGS, 'utf8'));
const postings = all.filter((gp) => gp.id === 'GP-005');
const plan = planGoldenRun(postings, goldenModeFrom(process.env), repoGoldenGate(REPO));

let g: GoldenFixture;
let w: InvoiceWorld;
let world: GoldenWorld;
let acme: string;
let gstId: string;
let clerk: string;
let approver: string;
let produced: { invoice: PostedInvoice; creditNoteId: string; entryId: string } | undefined;

const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) => g.fixture.inTenant(fn);

const gp = (id: string): GoldenPosting => {
  const x = all.find((p) => p.id === id);
  if (!x) throw new Error(`${id} missing from postings.md`);
  return x;
};

const produce: GoldenProducer = async (golden, index) => {
  const expected = expectedLines(golden, index, world);
  const companyId = g.fixture.companyId;
  // INV-000123 posted by the invoice code, then paid by GP-002 and allocated (2026-11-15).
  const invoice = await inTenant((trx) =>
    postGp001Invoice(trx, w, { companyId, partyId: acme, invoiceDate: '2026-11-05' }),
  );
  const receipt = gp('GP-002');
  expect(receipt.status).toBe('Approved');
  await inTenant(async (trx) => {
    const r = await post(
      trx,
      goldenCommand(receipt, 0, world, {
        idempotencyKey: `t0045:GP-002:${randomUUID()}`,
        defaultDate: GOLDEN_DEFAULT_DATE,
      }),
    );
    const [rct] = await subledgerEntriesOf(trx, r.entryId);
    const [inv] = await subledgerEntriesOf(trx, invoice.entryId);
    if (!rct || !inv) throw new Error('receipt and invoice need open items');
    await allocate(trx, {
      companyId,
      idempotencyKey: randomUUID(),
      fromEntryId: rct.id,
      toEntryId: inv.id,
      amount: '1375.00',
      allocationDate: '2026-11-15',
    });
  });
  // CN: $200.00 ex GST of line 1 (Professional services), scope reduced.
  const { id } = await inTenant((trx) =>
    createCreditNote(trx, {
      input: {
        companyId,
        invoiceId: invoice.invoiceId,
        creditNoteDate: '2026-11-20',
        reason: 'Scope reduced',
        lines: [{ invoiceLineId: invoice.lineIds[0] ?? '', amount: '200.00' }],
      },
      createdBy: clerk,
      idempotencyKey: `golden:GP-005:${randomUUID()}`,
    }),
  );
  await inTenant((trx) => approveCreditNote(trx, { id, approvedBy: approver }));
  const r = await inTenant((trx) => postCreditNote(trx, { id, postedBy: clerk }));
  produced = { invoice, creditNoteId: id, entryId: r.entryId };
  const journal = await inTenant((trx) => storedJournal(trx, r.entryId));
  const actual: LineView[] = journal.lines.map((l) => ({
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
  g = await createGoldenWorld('01900000-0000-7000-8000-000000004502');
  const companyId = g.fixture.companyId;
  const party = g.world.partyId('Acme');
  if (party === undefined) throw new Error('golden world has no Acme');
  acme = party;
  clerk = await g.fixture.addUser('ar_clerk');
  approver = await g.fixture.addUser('approver');
  w = await inTenant(async (trx) => {
    const r = await setupInvoicing(trx, companyId);
    await setupCreditNotes(trx, companyId);
    await makeCustomer(trx, companyId, acme);
    await addBillingTo(trx, companyId, acme);
    return r;
  });
  gstId = await inTenant(async (trx) => {
    const r = await sql<{ id: string }>`
      SELECT id::text FROM app.tax_code WHERE company_id = ${companyId} AND code = 'GST'`.execute(
      trx,
    );
    return r.rows[0]?.id ?? '';
  });
  // The golden's tax code GST is the company's real tax_code row (T-0034), not a fixed id.
  world = { ...g.world, taxCodeId: (code) => (code === 'GST' ? gstId : undefined) };
});

afterAll(async () => {
  await g?.close();
});

describe('T-0045 golden posting GP-005 produced by the credit-note code', () => {
  it('GP-005 is Approved, in phase and runs (not PENDING)', () => {
    expect(plan.map((p) => [p.gp.id, p.label, p.run])).toEqual([['GP-005', 'APPROVED', true]]);
  });

  it('SS-UC11-01: Partial credit note posts GP-005', async () => {
    const p = plan.find((x) => x.gp.id === 'GP-005');
    if (!p) throw new Error('GP-005 missing from postings.md');
    const outcome = await runGolden(p, produce);
    expect(outcome.status, outcome.report).toBe('PASS');
    if (!produced) throw new Error('GP-005 produced nothing');
    const cn = await inTenant((trx) => getCreditNote(trx, produced?.creditNoteId ?? ''));
    expect(cn).toMatchObject({
      status: 'posted',
      netTotal: '200.0000',
      taxTotal: '20.0000',
      total: '220.0000',
      laterBasPeriod: false,
      createdBy: clerk,
      approvedBy: approver,
    });
    expect(cn.creditNoteNo).toMatch(/^CN-\d{6}$/);
    // GP-005: "always issued as an adjustment note referencing the original invoice number and date".
    const doc = await inTenant((trx) => creditNoteDocument(trx, produced?.creditNoteId ?? ''));
    expect(doc).toMatchObject({
      title: 'Adjustment note',
      originalInvoiceNo: produced.invoice.invoiceNo,
      originalInvoiceDate: '2026-11-05',
      gstDifference: '20.0000',
    });
  });

  it('SS-UC11-02: Credit on a paid invoice is held as customer credit', async () => {
    if (!produced) throw new Error('SS-UC11-01 must run first');
    const companyId = g.fixture.companyId;
    const items = await inTenant((trx) => openItems(trx, { companyId, partyId: acme }));
    const credit = items.find((i) => i.entryId === produced?.entryId);
    expect(credit).toMatchObject({
      controlRole: 'AR_CONTROL',
      originalAmount: '-220.0000',
      openAmount: '-220.0000',
    });
    const balance = items.reduce(
      (s, i) => (i.controlRole === 'AR_CONTROL' ? [...s, i.openAmount] : s),
      [] as string[],
    );
    expect(balance.filter((a) => a !== '0.0000')).toEqual(['-220.0000']);
    // Not allocatable to INV-000123 (already open 0.00).
    const refused = await inTenant((trx) =>
      allocateCreditNote(trx, {
        id: produced?.creditNoteId ?? '',
        amount: '220.00',
        allocationDate: '2026-11-20',
        idempotencyKey: randomUUID(),
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AllocationError);
    expect(refused).toMatchObject({ code: 'OVER_ALLOCATION' });
    const rec = await inTenant((trx) => subledgerReconciliation(trx, { companyId }));
    expect(rec.find((r) => r.controlRole === 'AR_CONTROL')).toMatchObject({
      reconciled: true,
      difference: '0.0000',
    });
  });
});
