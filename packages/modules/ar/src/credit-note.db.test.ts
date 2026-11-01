/**
 * Customer credit notes (T-0045, design §3.8 row 4, UC-11, GP-005/GP-029, DL-0273), against a real
 * PostgreSQL as lf_app. The posted journal is compared line for line with the Approved GP-005.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allocate, post, subledgerEntriesOf, subledgerReconciliation } from '@ledgerforce/ledger';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import type { SeededProfiles } from '@ledgerforce/products';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveCreditNote, createCreditNote, type CreditNoteError } from './credit-notes.ts';
import { approveInvoice, createDraftInvoice, type DocumentOutbox } from './invoices.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp005 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-005',
);

let f: LedgerFixture;
let profiles: SeededProfiles;
let customers: string[] = [];
const outbox: DocumentOutbox = { publish: async () => {} };
const codeOf: Record<string, string> = {};

async function gp001Invoice(partyId: string, date: string) {
  return f.inTenant(async (trx) => {
    const d = await createDraftInvoice(
      trx,
      {
        companyId: f.companyId,
        partyId,
        issueDate: date,
        lines: [
          {
            productProfileId: profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '',
            description: 'Professional services',
            quantity: '1',
            unitPrice: '1000.00',
          },
          {
            productProfileId: profiles.productProfiles.get('SUBSCRIPTION') ?? '',
            description: 'Subscription',
            quantity: '1',
            unitPrice: '250.00',
          },
        ],
      },
      { outbox },
    );
    return approveInvoice(trx, { companyId: f.companyId, invoiceId: d.invoiceId }, { outbox });
  });
}

const openOf = (partyId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ open: string }>`
        SELECT coalesce(sum(base_open_amount), 0)::text AS open FROM app.subledger_entry
         WHERE party_id = ${partyId}::uuid AND control_role = 'AR_CONTROL'`.execute(trx)
      ).rows[0]?.open,
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004501');
  profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 3,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  await f.inTenant(async (trx) => {
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
    codeOf['product:PROFESSIONAL_SERVICES.revenue'] = '4110';
  });
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC11-01 / SS-UC11-02: credit note on a paid invoice', () => {
  it('SS-UC11-01 a $200 ex GST credit note on paid INV posts exactly GP-005', async () => {
    const acme = customers[0] ?? '';
    const inv = await gp001Invoice(acme, '2026-11-05');
    // Paid in full by bank transfer (GP-002 shape), allocated to the invoice.
    await f.inTenant(async (trx) => {
      const r = await post(trx, {
        companyId: f.companyId,
        idempotencyKey: 'receipt-1',
        entryDate: '2026-11-10',
        sourceType: 'ar_receipt',
        lines: [
          { account: { id: f.acct['1010'] ?? '' }, debit: '1375.00' },
          { account: { role: 'AR_CONTROL' }, credit: '1375.00', partyId: acme },
        ],
      });
      const [from] = await subledgerEntriesOf(trx, r.entryId);
      const [to] = await subledgerEntriesOf(trx, inv.entryId ?? '');
      await allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: 'alloc-1',
        fromEntryId: from?.id ?? '',
        toEntryId: to?.id ?? '',
        amount: '1375.00',
        allocationDate: '2026-11-10',
      });
    });
    const cn = await f.inTenant(async (trx) => {
      const d = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        issueDate: '2026-11-20',
        reasonCode: 'scope_reduction',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      expect(d.status).toBe('draft');
      expect(d.gross).toBe('220.0000');
      return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
    });
    expect(cn.creditNoteNo).toMatch(/^CN-\d{6}$/);
    const rows = await f.inTenant(
      async (trx) =>
        (
          await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = ${cn.entryId} ORDER BY l.line_no`.execute(
            trx,
          )
        ).rows,
    );
    expect(gp005).toBeDefined();
    expect(rows).toHaveLength(gp005?.lines.length ?? -1);
    gp005?.lines.forEach((g, i) => {
      const at = `GP-005 line ${String(i + 1)} (${g.binding})`;
      expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
      expect(rows[i]?.debit, at).toBe(
        `${g.debit}${g.debit.includes('.') ? '00' : '.0000'}`.replace(/^0\.0000$/, '0.0000'),
      );
      expect(rows[i]?.credit, at).toBe(`${g.credit}${g.credit.includes('.') ? '00' : '.0000'}`);
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });
  });

  it('SS-UC11-02 the credit on the paid invoice is held as customer credit; AR subledger = AR control', async () => {
    expect(await openOf(customers[0] ?? '')).toBe('-220.0000');
    const rec = await f.inTenant((trx) => subledgerReconciliation(trx, { companyId: f.companyId }));
    expect(rec.every((r) => r.reconciled)).toBe(true);
  });
});

describe('Credit notes on unpaid invoices and limits (T-0045)', () => {
  it('a credit note on an unpaid invoice is applied to it', async () => {
    const bolt = customers[1] ?? '';
    const inv = await gp001Invoice(bolt, '2026-11-06');
    await f.inTenant(async (trx) => {
      const d = await createCreditNote(trx, {
        companyId: f.companyId,
        invoiceId: inv.invoiceId,
        issueDate: '2026-11-21',
        reasonCode: 'price_concession',
        lines: [{ invoiceLineNo: 1, amount: '200.00' }],
      });
      return approveCreditNote(trx, { companyId: f.companyId, creditNoteId: d.creditNoteId });
    });
    const items = await f.inTenant((trx) => subledgerEntriesOf(trx, inv.entryId ?? ''));
    expect(items[0]?.openAmount).toBe('1155.0000');
    expect(await openOf(bolt)).toBe('1155.0000');
  });

  it('SS-UC11-07 refuses a credit beyond the creditable amount, an unknown line and an unknown reason', async () => {
    const third = customers[2] ?? '';
    const inv = await gp001Invoice(third, '2026-11-07');
    const attempt = (
      lines: { invoiceLineNo: number; amount: string }[],
      reasonCode = 'billing_error',
    ) =>
      f
        .inTenant((trx) =>
          createCreditNote(trx, {
            companyId: f.companyId,
            invoiceId: inv.invoiceId,
            issueDate: '2026-11-22',
            reasonCode,
            lines,
          }),
        )
        .then(
          () => undefined,
          (e: unknown) => e as CreditNoteError,
        );
    expect((await attempt([{ invoiceLineNo: 1, amount: '1400.00' }]))?.code).toBe(
      'CREDIT_EXCEEDS_INVOICE',
    );
    expect((await attempt([{ invoiceLineNo: 9, amount: '10.00' }]))?.code).toBe(
      'INVALID_CREDIT_NOTE',
    );
    expect((await attempt([{ invoiceLineNo: 1, amount: '10.00' }], 'credit_loss'))?.code).toBe(
      'INVALID_CREDIT_NOTE',
    );
  });

  it('a posted credit note cannot be changed', async () => {
    const cn = await f.inTenant((trx) =>
      trx
        .selectFrom('app.credit_note')
        .select('id')
        .where('status', '=', 'posted')
        .executeTakeFirstOrThrow(),
    );
    const err = await f
      .inTenant((trx) =>
        sql`UPDATE app.credit_note SET issue_date = '2026-12-01' WHERE id = ${cn.id}`.execute(trx),
      )
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/posted credit note/);
  });
});
