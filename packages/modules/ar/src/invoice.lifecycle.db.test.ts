/**
 * Sales invoice lifecycle against a real PostgreSQL as lf_app (T-0040, design §3.8 row 1, §4.2,
 * §4.3, UC-01; RQ-0104; migration 0037). The invoice posts only through the posting engine
 * (source type ar_invoice, source_id = invoice id, key ar_invoice:<id>); GP-001/GP-018 line-for-
 * line equality is proved in invoice.golden.db.test.ts.
 *
 * SS-UC01-05 — no Billing To contact blocks approval (module and database), nothing posts.
 * SS-PLAT-120 — draft → approved → posted; number INV-… taken at post; AR open item with the due
 *   date; replay returns the same entry; posted invoices and their lines never change.
 * SS-PLAT-121 — "show me the journal": the preview equals the journal post writes and writes
 *   nothing (no entry, no number taken).
 * SS-PLAT-122 — approval refuses an unresolvable posting profile: TAX_CODE_CONFLICT asks for an
 *   explicit tax code on the line (DL-0260); an explicit code resolves it.
 */
import {
  createLedgerFixture,
  storedJournal,
  type LedgerFixture,
} from '@ledgerforce/ledger/testing';
import { createProduct } from '@ledgerforce/products';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SalesInvoiceError,
  approveSalesInvoice,
  autoApproveSalesInvoice,
  createSalesInvoice,
  getSalesInvoice,
  loadInvoiceSettings,
  postSalesInvoice,
  previewSalesInvoice,
  setInvoiceSettings,
  type SalesInvoiceInput,
} from './sales-invoices.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';

let f: LedgerFixture;
let w: InvoiceWorld;
const u: Record<string, string> = {};
let acme: { partyId: string; contactId: string | null };
let noBillingTo: { partyId: string; contactId: string | null };

const user = (k: string) => u[k] ?? `missing user ${k}`;

const gp001 = (partyId: string, over: Partial<SalesInvoiceInput> = {}): SalesInvoiceInput => ({
  companyId: f.companyId,
  partyId,
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
  ...over,
});

const create = (input: SalesInvoiceInput, by = user('clerk')) =>
  f.inTenant((trx) =>
    createSalesInvoice(trx, { input, createdBy: by, idempotencyKey: randomUUID() }),
  );
const approve = (id: string, by = user('approver')) =>
  f.inTenant((trx) => approveSalesInvoice(trx, { id, approvedBy: by }));
const postIt = (id: string, by = user('clerk')) =>
  f.inTenant((trx) => postSalesInvoice(trx, { id, postedBy: by }));
const get = (id: string) => f.inTenant((trx) => getSalesInvoice(trx, id));

const entries = async () =>
  (
    await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1`,
      [f.tenantId],
    )
  ).rows[0]?.n ?? -1;
const nextInvoiceNo = async () =>
  (
    await f.admin.query<{ v: string }>(
      `SELECT next_value::text AS v FROM app.number_series
        WHERE tenant_id = $1 AND company_id = $2 AND code = 'ar_invoice'`,
      [f.tenantId, f.companyId],
    )
  ).rows[0]?.v;

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (e instanceof SalesInvoiceError) return { code: e.code, message: e.message };
  throw new Error(`expected a SalesInvoiceError, got ${String(e)}`);
}

/** A database refusal (lf_app), as message text. */
const dbRefusal = (q: ReturnType<typeof sql>) =>
  f
    .inTenant((trx) => q.execute(trx))
    .then(
      () => 'accepted',
      (e: unknown) => String((e as Error).message),
    );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004001');
  u.clerk = await f.addUser('ar_clerk');
  u.approver = await f.addUser('approver');
  u.admin = await f.addUser('finance_admin');
  w = await f.inTenant((trx) => setupInvoicing(trx, f.companyId));
  acme = await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Acme Pty Ltd' }));
  noBillingTo = await f.inTenant((trx) =>
    newCustomer(trx, f.companyId, { name: 'No Contact Pty Ltd', billingTo: false }),
  );
});

afterAll(async () => {
  await f.close();
});

describe('SS-UC01-05: No Billing To contact blocks approval', () => {
  it('SS-UC01-05: approval of a draft for an Account without a Billing To contact is rejected with NO_BILLING_TO and nothing posts', async () => {
    const before = await entries();
    const { id } = await create(gp001(noBillingTo.partyId));
    const r = await refusal(approve(id));
    expect(r.code).toBe('NO_BILLING_TO');
    expect(r.message).toMatch(/Billing To/);
    expect(await get(id)).toMatchObject({ status: 'draft', approvedBy: null, invoiceNo: null });
    expect((await refusal(postIt(id))).code).toBe('WRONG_STATUS');
    expect(await entries()).toBe(before);
  });

  it('SS-UC01-05: the database refuses the approval too (last line of defence)', async () => {
    const { id } = await create(gp001(noBillingTo.partyId));
    const msg = await dbRefusal(
      sql`UPDATE app.sales_invoice SET status = 'approved', approval_kind = 'user',
            approved_by = ${user('approver')}, approved_at = now(),
            net_total = 1250, tax_total = 125, total = 1375 WHERE id = ${id}`,
    );
    expect(msg).toMatch(/NO_BILLING_TO/);
  });

  it('SS-UC01-05: auto-approval leaves the draft with reason NO_BILLING_TO (UC-01 A1)', async () => {
    const before = await entries();
    const { id } = await create(gp001(noBillingTo.partyId));
    const r = await f.inTenant((trx) =>
      autoApproveSalesInvoice(trx, {
        id,
        settings: { autoApprove: true, threshold: '2000.0000' },
      }),
    );
    expect(r).toEqual({ outcome: 'draft', reason: 'NO_BILLING_TO' });
    expect(await entries()).toBe(before);
  });
});

describe('SS-PLAT-120: Sales invoice goes draft → approved → posted through the engine', () => {
  it('SS-PLAT-120 numbers at post, posts through the engine with the approver, opens the AR item and replays', async () => {
    const { id } = await create(gp001(acme.partyId));
    expect(await get(id)).toMatchObject({
      status: 'draft',
      createdBy: user('clerk'),
      invoiceNo: null,
    });
    expect((await refusal(postIt(id))).code).toBe('WRONG_STATUS');

    const a = await approve(id);
    expect(a).toMatchObject({
      status: 'approved',
      netTotal: '1250.0000',
      taxTotal: '125.0000',
      total: '1375.0000',
    });
    expect(await get(id)).toMatchObject({
      status: 'approved',
      approvedBy: user('approver'),
      invoiceNo: null,
    });
    expect((await refusal(approve(id))).code).toBe('WRONG_STATUS');

    const before = await entries();
    const p = await postIt(id);
    expect(p).toMatchObject({ status: 'posted', replayed: false });
    expect(p.invoiceNo).toMatch(/^INV-\d{6}$/);
    expect(await entries()).toBe(before + 1);
    const doc = await get(id);
    expect(doc).toMatchObject({
      status: 'posted',
      invoiceNo: p.invoiceNo,
      journalEntryId: p.entryId,
    });

    const entry = await f.inTenant((trx) =>
      sql<Record<string, string | null>>`
        SELECT source_type, source_id, approved_by::text, created_by::text, idempotency_key
          FROM app.journal_entry WHERE id = ${p.entryId}`.execute(trx),
    );
    expect(entry.rows[0]).toEqual({
      source_type: 'ar_invoice',
      source_id: id,
      approved_by: user('approver'),
      created_by: user('clerk'),
      idempotency_key: `ar_invoice:${id}`,
    });
    const item = await f.inTenant((trx) =>
      sql<Record<string, string | null>>`
        SELECT original_amount::text, open_amount::text, party_id::text,
               to_char(due_date, 'YYYY-MM-DD') AS due_date
          FROM app.subledger_entry WHERE entry_id = ${p.entryId}`.execute(trx),
    );
    expect(item.rows).toEqual([
      {
        original_amount: '1375.0000',
        open_amount: '1375.0000',
        party_id: acme.partyId,
        due_date: '2026-11-19',
      },
    ]);

    const again = await postIt(id);
    expect(again).toMatchObject({ replayed: true, entryId: p.entryId, invoiceNo: p.invoiceNo });
    expect(await entries()).toBe(before + 1);
  });

  it('SS-PLAT-120 invoice numbers are consecutive and taken only at post', async () => {
    const one = await create(gp001(acme.partyId));
    const two = await create(gp001(acme.partyId));
    await approve(one.id);
    await approve(two.id);
    // A counter, not money: BigInt keeps it exact.
    const n0 = BigInt((await nextInvoiceNo()) ?? '0');
    const p2 = await postIt(two.id);
    const p1 = await postIt(one.id);
    expect(await nextInvoiceNo()).toBe(String(n0 + 2n));
    const seq = (no: string) => no.slice('INV-'.length);
    expect([seq(p2.invoiceNo), seq(p1.invoiceNo)]).toEqual([
      String(n0).padStart(6, '0'),
      String(n0 + 1n).padStart(6, '0'),
    ]);
  });

  it('SS-PLAT-120 a posted invoice and its lines never change; drafts edit only while draft', async () => {
    const { id } = await create(gp001(acme.partyId));
    expect(
      await dbRefusal(sql`UPDATE app.sales_invoice SET memo = 'draft note' WHERE id = ${id}`),
    ).toBe('accepted');
    await approve(id);
    expect(
      await dbRefusal(sql`UPDATE app.sales_invoice SET memo = 'late' WHERE id = ${id}`),
    ).toMatch(/only a draft/);
    expect(
      await dbRefusal(sql`UPDATE app.sales_invoice_line SET amount = 1 WHERE invoice_id = ${id}`),
    ).toMatch(/only a draft/);
    await postIt(id);
    for (const q of [
      sql`UPDATE app.sales_invoice SET memo = 'changed' WHERE id = ${id}`,
      sql`UPDATE app.sales_invoice SET status = 'draft' WHERE id = ${id}`,
      sql`UPDATE app.sales_invoice_line SET description = 'x' WHERE invoice_id = ${id}`,
      sql`INSERT INTO app.sales_invoice_line (company_id, invoice_id, line_no, product_id, amount)
          VALUES (${f.companyId}, ${id}, 9, ${w.products.SUBSCRIPTION}, 5)`,
    ]) {
      expect(await dbRefusal(q)).toMatch(/posted|only a draft/);
    }
    expect(await dbRefusal(sql`DELETE FROM app.sales_invoice WHERE id = ${id}`)).toMatch(
      /permission denied/,
    );
    expect(
      await dbRefusal(sql`DELETE FROM app.sales_invoice_line WHERE invoice_id = ${id}`),
    ).toMatch(/permission denied/);
  });

  it('SS-PLAT-120 the database refuses a posted invoice that does not name the engine entry for it', async () => {
    const { id } = await create(gp001(acme.partyId));
    await approve(id);
    const other = await create(gp001(acme.partyId));
    await approve(other.id);
    const p = await postIt(other.id);
    const msg = await dbRefusal(
      sql`UPDATE app.sales_invoice SET status = 'posted', invoice_no = 'INV-999999', posted_at = now(),
            journal_entry_id = ${p.entryId} WHERE id = ${id}`,
    );
    expect(msg).toMatch(/not the engine's posting/);
  });

  it('SS-PLAT-120 create is idempotent per key', async () => {
    const key = randomUUID();
    const a = await f.inTenant((trx) =>
      createSalesInvoice(trx, {
        input: gp001(acme.partyId),
        createdBy: user('clerk'),
        idempotencyKey: key,
      }),
    );
    const b = await f.inTenant((trx) =>
      createSalesInvoice(trx, {
        input: gp001(acme.partyId),
        createdBy: user('clerk'),
        idempotencyKey: key,
      }),
    );
    expect(b).toEqual({ id: a.id, replayed: true });
  });

  it('SS-PLAT-120 auto-approve: off or above the threshold or on credit hold stays draft; under it posts', async () => {
    const before = await entries();
    const run = (id: string, s: { autoApprove: boolean; threshold: string }, hold?: string) =>
      f.inTenant((trx) =>
        autoApproveSalesInvoice(trx, {
          id,
          settings: s,
          ...(hold === undefined ? {} : { creditHold: async () => hold }),
        }),
      );
    const d = await create(gp001(acme.partyId));
    expect(await run(d.id, { autoApprove: false, threshold: '2000.0000' })).toEqual({
      outcome: 'draft',
      reason: 'AUTO_APPROVE_OFF',
    });
    expect(await run(d.id, { autoApprove: true, threshold: '1000.0000' })).toEqual({
      outcome: 'draft',
      reason: 'ABOVE_THRESHOLD',
    });
    expect(
      await run(d.id, { autoApprove: true, threshold: '2000.0000' }, 'overdue 30 days'),
    ).toEqual({
      outcome: 'draft',
      reason: 'CREDIT_HOLD',
    });
    expect(await entries()).toBe(before);
    expect(await get(d.id)).toMatchObject({ status: 'draft' });
    const r = await run(d.id, { autoApprove: true, threshold: '1375.0000' });
    expect(r).toMatchObject({ outcome: 'posted' });
    expect(await get(d.id)).toMatchObject({
      status: 'posted',
      approvalKind: 'auto',
      approvedBy: null,
    });
    expect(await entries()).toBe(before + 1);
  });

  it('SS-PLAT-120 auto-approve settings are a per-company history; the latest row wins; default off', async () => {
    expect(await f.inTenant((trx) => loadInvoiceSettings(trx, f.companyId))).toEqual({
      autoApprove: false,
      threshold: '0.0000',
    });
    for (const [on, t] of [
      [true, '2000'],
      [true, '1500.5'],
    ] as const) {
      await f.inTenant((trx) =>
        setInvoiceSettings(trx, {
          companyId: f.companyId,
          autoApprove: on,
          threshold: t,
          setBy: user('admin'),
          reason: 'pilot',
        }),
      );
    }
    expect(await f.inTenant((trx) => loadInvoiceSettings(trx, f.companyId))).toEqual({
      autoApprove: true,
      threshold: '1500.5000',
    });
    expect(await dbRefusal(sql`UPDATE app.ar_invoice_settings SET auto_approve = false`)).not.toBe(
      'accepted',
    );
  });

  it('SS-PLAT-120 refuses an invoice in another currency than the base (FX is out of scope)', async () => {
    const r = await refusal(create(gp001(acme.partyId, { currency: 'USD' })));
    expect(r.code).toBe('INVALID_INVOICE');
  });
});

describe('SS-PLAT-121: Invoice journal preview writes nothing', () => {
  it('SS-PLAT-121 the preview of a draft equals the journal post writes; no entry or number is taken', async () => {
    const { id } = await create(gp001(acme.partyId));
    const before = { entries: await entries(), next: await nextInvoiceNo() };
    const pv = await f.inTenant((trx) => previewSalesInvoice(trx, id));
    expect(pv.total).toBe('1375.0000');
    expect({ entries: await entries(), next: await nextInvoiceNo() }).toEqual(before);
    expect(await get(id)).toMatchObject({ status: 'draft' });
    await approve(id);
    const p = await postIt(id);
    const stored = await f.inTenant((trx) => storedJournal(trx, p.entryId));
    expect(
      stored.lines.map((l) => [
        l.lineNo,
        l.accountId,
        l.debit,
        l.credit,
        l.taxCodeId,
        l.taxAmount,
        l.partyId,
      ]),
    ).toEqual(
      pv.lines.map((l) => [
        l.lineNo,
        l.accountId,
        l.debit,
        l.credit,
        l.taxCodeId,
        l.taxAmount,
        l.partyId,
      ]),
    );
  });
});

describe('SS-PLAT-122: Approval refuses an unresolvable posting profile', () => {
  it('SS-PLAT-122 TAX_CODE_CONFLICT asks for an explicit tax code on the line; nothing posts', async () => {
    const fre = await f.inTenant((trx) =>
      createProduct(trx, {
        companyId: f.companyId,
        name: 'Export training',
        productPostingProfileCode: 'PROFESSIONAL_SERVICES',
        defaultTaxCode: 'FRE',
      }),
    );
    const before = await entries();
    const { id } = await create(
      gp001(acme.partyId, { lines: [{ productId: fre.id, amount: '500.00' }] }),
    );
    const r = await refusal(approve(id));
    expect(r.code).toBe('TAX_CODE_CONFLICT');
    expect(r.message).toMatch(/line 1/);
    expect(r.message).toMatch(/GST/);
    expect(r.message).toMatch(/FRE/);
    expect(r.message).toMatch(/explicit tax code/);
    expect(await get(id)).toMatchObject({ status: 'draft' });
    expect(await entries()).toBe(before);

    const fixed = await create(
      gp001(acme.partyId, { lines: [{ productId: fre.id, amount: '500.00', taxCode: 'FRE' }] }),
    );
    expect(await approve(fixed.id)).toMatchObject({ total: '500.0000', taxTotal: '0.0000' });
  });

  it('SS-PLAT-122 a customer without a party posting profile is refused NO_PARTY_PROFILE', async () => {
    const bare = await f.inTenant(async (trx) => {
      const c = await newCustomer(trx, f.companyId, { name: 'Bare Pty Ltd' });
      await sql`UPDATE app.party SET customer_posting_profile_id = NULL WHERE id = ${c.partyId}`.execute(
        trx,
      );
      return c;
    });
    const { id } = await create(gp001(bare.partyId));
    expect((await refusal(approve(id))).code).toBe('NO_PARTY_PROFILE');
  });
});
