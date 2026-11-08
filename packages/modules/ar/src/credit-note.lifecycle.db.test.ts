/**
 * Customer credit-note lifecycle against a real PostgreSQL as lf_app (T-0045, design §3.8 row 4,
 * §6.4, UC-11; RQ-0114; ADR-0044 R5/W6; migration 0040). GP-005 line-for-line equality is proved
 * in credit-note.golden.db.test.ts.
 *
 * SS-UC11-06 — the AR Clerk cannot approve their own credit note above the threshold (module and
 *   database); another user can; below the threshold self-approval is allowed.
 * SS-PLAT-160 — draft → approved → posted through the engine (source ar_credit_note, CN- number
 *   taken at post), replay, idempotent create, refusals (invoice not posted, date before invoice,
 *   creditable amount incl. earlier credits), posted credit notes and lines never change.
 * SS-PLAT-161 — ADR-0044 W6: every invoice line's posting (account, tax-code version, net, tax) is
 *   recorded when the invoice posts; each credit-note line stores the invoice line it adjusts and
 *   takes that line's account and tax-code version — even after the tax code gets a new version;
 *   the database refuses any other; the link is exposed for the BAS report.
 * SS-PLAT-162 — a posted credit note opens a credit open item that can be allocated to the
 *   invoice; the preview equals the posted journal and writes nothing.
 * SS-PLAT-163 — adjustment note: titled "Adjustment note" with the original invoice number and
 *   date; later_bas_period by the company BAS frequency (quarterly default, monthly, annual).
 */
import {
  createLedgerFixture,
  storedJournal,
  type LedgerFixture,
} from '@ledgerforce/ledger/testing';
import { openItems, subledgerReconciliation } from '@ledgerforce/ledger';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreditNoteError,
  allocateCreditNote,
  approveCreditNote,
  createCreditNote,
  creditNoteAdjustmentLines,
  creditNoteDocument,
  getCreditNote,
  invoiceLinePostings,
  postCreditNote,
  previewCreditNote,
  type CreditNoteInput,
} from './credit-notes.ts';
import {
  postGp001Invoice,
  setupCreditNotes,
  type PostedInvoice,
} from './testing/credit-note-world.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';

let f: LedgerFixture;
let w: InvoiceWorld;
const u: Record<string, string> = {};
let acme: string;

const user = (k: string) => u[k] ?? `missing user ${k}`;

const invoice = (invoiceDate = '2026-11-05') =>
  f.inTenant((trx) =>
    postGp001Invoice(trx, w, {
      companyId: f.companyId,
      partyId: acme,
      invoiceDate,
      dueDate: invoiceDate,
    }),
  );

const cnInput = (inv: PostedInvoice, over: Partial<CreditNoteInput> = {}): CreditNoteInput => ({
  companyId: f.companyId,
  invoiceId: inv.invoiceId,
  creditNoteDate: '2026-11-20',
  reason: 'Scope reduced',
  lines: [{ invoiceLineId: inv.lineIds[0] ?? '', amount: '200.00' }],
  ...over,
});

const create = (input: CreditNoteInput, by = user('clerk'), key = randomUUID()) =>
  f.inTenant((trx) => createCreditNote(trx, { input, createdBy: by, idempotencyKey: key }));
const approve = (id: string, by = user('approver')) =>
  f.inTenant((trx) => approveCreditNote(trx, { id, approvedBy: by }));
const postIt = (id: string, by = user('clerk')) =>
  f.inTenant((trx) => postCreditNote(trx, { id, postedBy: by }));
const get = (id: string) => f.inTenant((trx) => getCreditNote(trx, id));
const issue = async (input: CreditNoteInput) => {
  const { id } = await create(input);
  await approve(id);
  return postIt(id);
};

const entries = async () =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1`,
      [f.tenantId],
    )
  ).rows[0]?.n ?? -1;

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (e instanceof CreditNoteError) return { code: e.code, message: e.message };
  throw new Error(`expected a CreditNoteError, got ${String(e)}`);
}

/** A database refusal (lf_app), as message text. */
const dbRefusal = (q: ReturnType<typeof sql>) =>
  f
    .inTenant((trx) => q.execute(trx))
    .then(
      () => 'accepted',
      (e: unknown) => String((e as Error).message),
    );

const setBasFrequency = (freq: string) =>
  f.inTenant((trx) =>
    sql`UPDATE app.company SET bas_frequency = ${freq} WHERE id = ${f.companyId}`.execute(trx),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004501');
  u.clerk = await f.addUser('ar_clerk');
  u.approver = await f.addUser('approver');
  w = await f.inTenant(async (trx) => {
    const r = await setupInvoicing(trx, f.companyId);
    await setupCreditNotes(trx, f.companyId);
    return r;
  });
  acme = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Acme Pty Ltd' })))
    .partyId;
});

afterAll(async () => {
  await f.close();
});

describe('SS-UC11-06: Clerk cannot approve own credit note above threshold', () => {
  it('SS-UC11-06: the AR Clerk who created a 1,100.00 credit note cannot approve it; another user can', async () => {
    const inv = await invoice();
    const { id } = await create(
      cnInput(inv, { lines: [{ invoiceLineId: inv.lineIds[0] ?? '', amount: '1000.00' }] }),
      user('clerk'),
    );
    const r = await refusal(approve(id, user('clerk')));
    expect(r.code).toBe('SOD_CREDIT_NOTE_SELF_APPROVAL');
    expect(await get(id)).toMatchObject({ status: 'draft', approvedBy: null });
    const ok = await approve(id, user('approver'));
    expect(ok).toMatchObject({ status: 'approved', total: '1100.0000' });
  });

  it('SS-UC11-06: the database refuses the self-approval too (last line of defence)', async () => {
    const inv = await invoice();
    const { id } = await create(
      cnInput(inv, { lines: [{ invoiceLineId: inv.lineIds[0] ?? '', amount: '1000.00' }] }),
    );
    await f.inTenant((trx) =>
      sql`UPDATE app.credit_note_line SET net_amount = 1000, tax_amount = 100
           WHERE credit_note_id = ${id}`.execute(trx),
    );
    const msg = await dbRefusal(
      sql`UPDATE app.credit_note SET status = 'approved', approved_by = ${user('clerk')},
            approved_at = now(), net_total = 1000, tax_total = 100, total = 1100 WHERE id = ${id}`,
    );
    expect(msg).toMatch(/SOD_CREDIT_NOTE_SELF_APPROVAL/);
  });

  it('SS-UC11-06: at or below the threshold the creator may approve (220.00)', async () => {
    const inv = await invoice();
    const { id } = await create(cnInput(inv));
    expect(await approve(id, user('clerk'))).toMatchObject({
      status: 'approved',
      total: '220.0000',
    });
  });
});

describe('SS-PLAT-160: credit-note lifecycle', () => {
  it('SS-PLAT-160: draft → approved → posted through the engine; CN- number at post; replay', async () => {
    const inv = await invoice();
    const before = await entries();
    const { id, replayed } = await create(cnInput(inv));
    expect(replayed).toBe(false);
    expect(await get(id)).toMatchObject({ status: 'draft', creditNoteNo: null, partyId: acme });
    await approve(id);
    expect(await entries()).toBe(before);
    const r = await postIt(id);
    expect(r).toMatchObject({ status: 'posted', replayed: false, laterBasPeriod: false });
    expect(r.creditNoteNo).toMatch(/^CN-\d{6}$/);
    expect(await entries()).toBe(before + 1);
    const e = await f.admin.query<{ source_type: string; source_id: string; approved_by: string }>(
      `SELECT source_type, source_id, approved_by::text FROM app.journal_entry WHERE id = $1`,
      [r.entryId],
    );
    expect(e.rows[0]).toEqual({
      source_type: 'ar_credit_note',
      source_id: id,
      approved_by: user('approver'),
    });
    const again = await postIt(id);
    expect(again).toMatchObject({
      entryId: r.entryId,
      replayed: true,
      creditNoteNo: r.creditNoteNo,
    });
    expect(await entries()).toBe(before + 1);
  });

  it('SS-PLAT-160: create is idempotent per key', async () => {
    const inv = await invoice();
    const key = randomUUID();
    const a = await create(cnInput(inv), user('clerk'), key);
    const b = await create(cnInput(inv), user('clerk'), key);
    expect(b).toEqual({ id: a.id, replayed: true });
  });

  it('SS-PLAT-160: refuses a draft invoice, a date before the invoice, a foreign invoice line', async () => {
    const draft = await f.inTenant(async (trx) => {
      const { createSalesInvoice } = await import('./sales-invoices.ts');
      return createSalesInvoice(trx, {
        input: {
          companyId: f.companyId,
          partyId: acme,
          invoiceDate: '2026-11-05',
          dueDate: '2026-11-05',
          lines: [{ productId: w.products.SUBSCRIPTION, amount: '10.00' }],
        },
        createdBy: null,
        idempotencyKey: randomUUID(),
      });
    });
    const inv = await invoice();
    expect((await refusal(create(cnInput(inv, { invoiceId: draft.id })))).code).toBe(
      'INVOICE_NOT_POSTED',
    );
    expect((await refusal(create(cnInput(inv, { creditNoteDate: '2026-11-04' })))).code).toBe(
      'INVALID_CREDIT_NOTE',
    );
    const other = await invoice();
    expect(
      (
        await refusal(
          create(
            cnInput(inv, { lines: [{ invoiceLineId: other.lineIds[0] ?? '', amount: '1.00' }] }),
          ),
        )
      ).code,
    ).toBe('LINE_NOT_ON_INVOICE');
  });

  it('SS-PLAT-160: the creditable amount counts approved and posted credits (CREDIT_EXCEEDS_INVOICE)', async () => {
    const inv = await invoice();
    const { id } = await create(cnInput(inv)); // a draft of 200.00 reserves nothing
    await issue(
      cnInput(inv, { lines: [{ invoiceLineId: inv.lineIds[0] ?? '', amount: '900.00' }] }),
    );
    // Only 100.00 is left on line 1: the draft cannot be approved, a new 100.01 cannot be created.
    expect((await refusal(approve(id))).code).toBe('CREDIT_EXCEEDS_INVOICE');
    expect(
      (
        await refusal(
          create(
            cnInput(inv, { lines: [{ invoiceLineId: inv.lineIds[0] ?? '', amount: '100.01' }] }),
          ),
        )
      ).code,
    ).toBe('CREDIT_EXCEEDS_INVOICE');
    const rest = await issue(
      cnInput(inv, {
        lines: [
          { invoiceLineId: inv.lineIds[0] ?? '', amount: '100.00' },
          { invoiceLineId: inv.lineIds[1] ?? '', amount: '250.00' },
        ],
      }),
    );
    expect(rest.status).toBe('posted');
  });

  it('SS-PLAT-160: posted credit notes and their lines never change; no DELETE', async () => {
    const inv = await invoice();
    const { id } = await issue(cnInput(inv));
    expect(await dbRefusal(sql`UPDATE app.credit_note SET memo = 'x' WHERE id = ${id}`)).toMatch(
      /posted/,
    );
    expect(
      await dbRefusal(sql`UPDATE app.credit_note_line SET amount = 1 WHERE credit_note_id = ${id}`),
    ).toMatch(/only a draft/);
    expect(await dbRefusal(sql`DELETE FROM app.credit_note WHERE id = ${id}`)).toMatch(
      /denied|never deleted/,
    );
  });
});

describe('SS-PLAT-161: credit-note lines inherit the invoice line (ADR-0044 W6)', () => {
  it('SS-PLAT-161: the invoice post records each line posting; credit lines link to and copy it', async () => {
    const inv = await invoice();
    const postings = await f.inTenant((trx) => invoiceLinePostings(trx, inv.invoiceId));
    expect(postings.map((p) => [p.invoiceLineId, p.netAmount, p.taxAmount])).toEqual([
      [inv.lineIds[0], '1000.0000', '100.0000'],
      [inv.lineIds[1], '250.0000', '25.0000'],
    ]);
    const journal = await f.inTenant((trx) => storedJournal(trx, inv.entryId));
    for (const p of postings) {
      expect(
        journal.lines.some((l) => l.accountId === p.accountId && l.taxCodeId === p.taxCodeId),
      ).toBe(true);
    }
    expect(
      await dbRefusal(
        sql`UPDATE app.sales_invoice_line_posting SET net_amount = 1 WHERE invoice_id = ${inv.invoiceId}`,
      ),
    ).toMatch(/cannot change|permission denied/);

    const { id } = await create(cnInput(inv));
    const cn = await get(id);
    expect(cn.lines).toEqual([
      expect.objectContaining({
        invoiceLineId: inv.lineIds[0],
        accountId: postings[0]?.accountId,
        taxCodeId: postings[0]?.taxCodeId,
        amount: '200.0000',
      }),
    ]);
    // The database refuses a credit line whose tax code is not the invoice line's.
    const other = await f.inTenant(async (trx) => {
      const r = await sql<{ id: string }>`
        SELECT id::text FROM app.tax_code WHERE company_id = ${f.companyId} AND code = 'FRE'`.execute(
        trx,
      );
      return r.rows[0]?.id ?? '';
    });
    expect(
      await dbRefusal(
        sql`UPDATE app.credit_note_line SET tax_code_id = ${other} WHERE credit_note_id = ${id}`,
      ),
    ).toMatch(/W6/);
  });

  it('SS-PLAT-161: a new GST version after the invoice does not change the credit (never re-resolved)', async () => {
    const inv = await invoice('2026-11-05');
    const postings = await f.inTenant((trx) => invoiceLinePostings(trx, inv.invoiceId));
    // GST 10 % until 2026-11-30, 15 % from 2026-12-01 (test-only rate change).
    await f.inTenant(async (trx) => {
      await sql`UPDATE app.tax_code SET valid_to = '2026-11-30'
                 WHERE company_id = ${f.companyId} AND code = 'GST' AND valid_to IS NULL`.execute(
        trx,
      );
      await sql`INSERT INTO app.tax_code (company_id, code, name, kind, rate, collected_role, paid_role, valid_from)
                SELECT company_id, code, name, kind, 0.15, collected_role, paid_role, '2026-12-01'
                  FROM app.tax_code WHERE company_id = ${f.companyId} AND code = 'GST' AND valid_to = '2026-11-30'`.execute(
        trx,
      );
    });
    try {
      const r = await issue(cnInput(inv, { creditNoteDate: '2026-12-10' }));
      const cn = await get(r.id);
      expect(cn).toMatchObject({ taxTotal: '20.0000', total: '220.0000' });
      expect(cn.lines[0]?.taxCodeId).toBe(postings[0]?.taxCodeId);
    } finally {
      // Restore one open-ended 10 % version for the other tests (the 15 % row stays, ending first).
      await f.inTenant(async (trx) => {
        await sql`UPDATE app.tax_code SET valid_to = '2026-12-01'
                   WHERE company_id = ${f.companyId} AND code = 'GST' AND valid_from = '2026-12-01'`.execute(
          trx,
        );
      });
    }
  });

  it('SS-PLAT-161: creditNoteAdjustmentLines exposes credit line → invoice line for the BAS report', async () => {
    const inv = await invoice();
    const r = await issue(cnInput(inv));
    const rows = await f.inTenant((trx) =>
      creditNoteAdjustmentLines(trx, {
        companyId: f.companyId,
        from: '2026-11-20',
        to: '2026-11-20',
      }),
    );
    expect(rows.filter((x) => x.creditNoteId === r.id)).toEqual([
      expect.objectContaining({
        creditNoteId: r.id,
        creditNoteNo: r.creditNoteNo,
        creditNoteDate: '2026-11-20',
        entryId: r.entryId,
        invoiceId: inv.invoiceId,
        invoiceNo: inv.invoiceNo,
        invoiceDate: '2026-11-05',
        invoiceEntryId: inv.entryId,
        invoiceLineId: inv.lineIds[0],
        netAmount: '200.0000',
        taxAmount: '20.0000',
        laterBasPeriod: false,
      }),
    ]);
  });
});

describe('SS-PLAT-162: credit open item, allocation and preview', () => {
  it('SS-PLAT-162: a posted credit note opens −220.00 and is allocated to the unpaid invoice', async () => {
    const inv = await invoice();
    const r = await issue(cnInput(inv));
    const a = await f.inTenant((trx) =>
      allocateCreditNote(trx, {
        id: r.id,
        amount: '220.00',
        allocationDate: '2026-11-20',
        idempotencyKey: randomUUID(),
        createdBy: user('clerk'),
      }),
    );
    expect(a.amount).toBe('220.0000');
    const items = await f.inTenant((trx) =>
      openItems(trx, { companyId: f.companyId, partyId: acme }),
    );
    expect(items.find((i) => i.entryId === inv.entryId)?.openAmount).toBe('1155.0000');
    expect(items.find((i) => i.entryId === r.entryId)).toMatchObject({
      originalAmount: '-220.0000',
      openAmount: '0.0000',
    });
    const rec = await f.inTenant((trx) => subledgerReconciliation(trx, { companyId: f.companyId }));
    expect(rec.find((x) => x.controlRole === 'AR_CONTROL')?.reconciled).toBe(true);
  });

  it('SS-PLAT-162: allocating a draft credit note is refused', async () => {
    const inv = await invoice();
    const { id } = await create(cnInput(inv));
    expect(
      (
        await refusal(
          f.inTenant((trx) =>
            allocateCreditNote(trx, {
              id,
              amount: '1.00',
              allocationDate: '2026-11-20',
              idempotencyKey: randomUUID(),
            }),
          ),
        )
      ).code,
    ).toBe('WRONG_STATUS');
  });

  it('SS-PLAT-162: the preview equals the posted journal and writes nothing', async () => {
    const inv = await invoice();
    const { id } = await create(cnInput(inv));
    await approve(id);
    const before = await entries();
    const p = await f.inTenant((trx) => previewCreditNote(trx, id));
    expect(await entries()).toBe(before);
    const r = await postIt(id);
    const stored = await f.inTenant((trx) => storedJournal(trx, r.entryId));
    expect(
      stored.lines.map((l) => [
        l.accountId,
        l.debit,
        l.credit,
        l.taxCodeId,
        l.taxAmount,
        l.partyId,
      ]),
    ).toEqual(
      p.lines.map((l) => [l.accountId, l.debit, l.credit, l.taxCodeId, l.taxAmount, l.partyId]),
    );
  });
});

describe('SS-PLAT-163: adjustment note and later BAS period', () => {
  it('SS-PLAT-163: same quarter → not a later period; next quarter → later period; always an adjustment note', async () => {
    const inv = await invoice('2026-11-05');
    const same = await issue(cnInput(inv, { creditNoteDate: '2026-12-31' }));
    expect(same.laterBasPeriod).toBe(false);
    const later = await issue(cnInput(inv, { creditNoteDate: '2027-01-10' }));
    expect(later.laterBasPeriod).toBe(true);
    const doc = await f.inTenant((trx) => creditNoteDocument(trx, later.id));
    expect(doc).toMatchObject({
      title: 'Adjustment note',
      creditNoteNo: later.creditNoteNo,
      creditNoteDate: '2027-01-10',
      originalInvoiceNo: inv.invoiceNo,
      originalInvoiceDate: '2026-11-05',
      reason: 'Scope reduced',
      laterBasPeriod: true,
      gstDifference: '20.0000',
      total: '220.0000',
    });
    expect((await f.inTenant((trx) => creditNoteDocument(trx, same.id))).title).toBe(
      'Adjustment note',
    );
  });

  it('SS-PLAT-163: monthly and annual BAS frequency', async () => {
    try {
      await setBasFrequency('monthly');
      const inv = await invoice('2026-11-05');
      expect((await issue(cnInput(inv, { creditNoteDate: '2026-12-01' }))).laterBasPeriod).toBe(
        true,
      );
      await setBasFrequency('annual');
      expect((await issue(cnInput(inv, { creditNoteDate: '2027-06-30' }))).laterBasPeriod).toBe(
        false,
      );
    } finally {
      await setBasFrequency('quarterly');
    }
  });

  it('SS-PLAT-163: app.bas_period_start (used by the posting guard) mirrors basPeriodOf', async () => {
    const r = await f.admin.query<{ q: string; m: string; a: string }>(
      `SELECT app.bas_period_start('2026-11-20', 'quarterly')::text AS q,
              app.bas_period_start('2026-11-20', 'monthly')::text AS m,
              app.bas_period_start('2026-06-30', 'annual')::text AS a`,
    );
    expect(r.rows[0]).toEqual({ q: '2026-10-01', m: '2026-11-01', a: '2025-07-01' });
  });
});
