/**
 * Sales invoice lifecycle — draft → approve → post (T-0040, design §3.8 row 1, §4.2, UC-01,
 * DL-0268), against a real PostgreSQL as lf_app. The posted journal is compared line for line with
 * the Approved golden postings GP-001 and GP-023a/b (accounts by binding, amounts, party).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { entrySeriesFor, SOURCE_TYPES } from '@ledgerforce/ledger';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { auServicesSmb } from '@ledgerforce/gl';
import { seedPostingProfiles, setPartyProfiles, type SeededProfiles } from '@ledgerforce/products';
import { seedTaxCodes } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveInvoice,
  createDraftInvoice,
  InvoiceError,
  setArSettings,
  type DocumentEvent,
  type DocumentOutbox,
} from './invoices.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const golden = (id: string): GoldenJournal => {
  const t = tables.find((x) => `${x.entryId}${x.label}` === id);
  if (!t) throw new Error(`${id} not Approved`);
  return t;
};

let f: LedgerFixture;
let profiles: SeededProfiles;
const parties: Record<string, string> = {};
let billingEmail = '';
const events: DocumentEvent[] = [];
const outbox: DocumentOutbox = {
  publish: async (_trx, e) => {
    events.push(e);
  },
};
/** Golden binding → account code on the AU services template (role bindings via the chart). */
const codeOf: Record<string, string> = {};

async function customer(name: string, withBillingTo: boolean): Promise<string> {
  return f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'customer' })
      .execute();
    await setPartyProfiles(trx, f.companyId, p.id, {
      customerProfileId: profiles.partyProfiles.get('DOMESTIC_CUSTOMER') ?? '',
    });
    if (withBillingTo) {
      const email = `accounts@${name.toLowerCase()}.example`;
      const c = await trx
        .insertInto('app.party_contact')
        .values({ company_id: f.companyId, party_id: p.id, name: `${name} Accounts`, email })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('app.party_contact_role')
        .values({ company_id: f.companyId, party_id: p.id, contact_id: c.id, role: 'billing_to' })
        .execute();
      if (name === 'Acme') billingEmail = email;
    }
    return p.id;
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004001');
  profiles = await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `J${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'ar_invoice_document', prefix: 'INV-' })
      .execute();
    await seedTaxCodes(trx, f.companyId);
    const roles = await trx
      .selectFrom('app.account_system_role as r')
      .innerJoin('app.account as a', 'a.id', 'r.account_id')
      .select(['r.role', 'a.code'])
      .where('r.company_id', '=', f.companyId)
      .execute();
    for (const r of roles) codeOf[`system:${r.role}`] = r.code;
    codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
    codeOf['product:PROFESSIONAL_SERVICES.revenue'] = '4110';
    codeOf['product:SUBSCRIPTION.revenue'] = '4120';
    return seedPostingProfiles(trx, f.companyId, auServicesSmb, new Map(Object.entries(f.acct)));
  });
  parties['Acme'] = await customer('Acme', true);
  parties['Nobill'] = await customer('Nobill', false);
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

const productProfile = (code: string) => profiles.productProfiles.get(code) ?? '';

/** The stored journal of an entry as golden-comparable rows. */
async function journalOf(entryId: string) {
  return f.inTenant(
    async (trx) =>
      (
        await sql<{ code: string; debit: string; credit: string; party_id: string | null }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id::text
          FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
         WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(trx)
      ).rows,
  );
}
const money = (s: string) => {
  const [i = '0', d = ''] = s.split('.');
  return `${i}.${(d + '0000').slice(0, 4)}`;
};
function expectGolden(rows: Awaited<ReturnType<typeof journalOf>>, t: GoldenJournal) {
  expect(rows, `${t.entryId}${t.label}`).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const at = `${t.entryId}${t.label} line ${String(i + 1)} (${g.binding})`;
    expect(rows[i]?.code, at).toBe(codeOf[g.binding]);
    expect(rows[i]?.debit, at).toBe(money(g.debit));
    expect(rows[i]?.credit, at).toBe(money(g.credit));
    expect(rows[i]?.party_id ?? null, at).toBe(g.party ? (parties[g.party] ?? '?') : null);
  });
}

const gp001Lines = () => [
  {
    productProfileId: productProfile('PROFESSIONAL_SERVICES'),
    description: 'Professional services',
    quantity: '1',
    unitPrice: '1000.00',
  },
  {
    productProfileId: productProfile('SUBSCRIPTION'),
    description: 'Subscription',
    quantity: '1',
    unitPrice: '250.00',
  },
];

describe('SS-UC01-03: Auto-approve under threshold posts GP-001 and emails', () => {
  it('SS-UC01-03 a draft under the auto-approve threshold posts exactly GP-001, numbered INV-…, and notifies the Billing To contact', async () => {
    await f.inTenant((trx) =>
      setArSettings(trx, f.companyId, { autoApprove: true, autoApproveThreshold: '2000.00' }),
    );
    events.length = 0;
    const inv = await f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Acme'] ?? '',
          issueDate: '2026-11-05',
          dueDate: '2026-11-19',
          lines: gp001Lines(),
        },
        { outbox },
      ),
    );
    expect(inv.status).toBe('posted');
    expect(inv.invoiceNo).toMatch(/^INV-\d{6}$/);
    expect(inv.gross).toBe('1375.0000');
    expectGolden(await journalOf(inv.entryId ?? ''), golden('GP-001'));
    // Revenue lines carry their tax code and tax (BAS, T-0035).
    const taxed = await f.inTenant((trx) =>
      sql<{ tax_amount: string }>`
        SELECT l.tax_amount::text FROM app.journal_line l
         WHERE l.entry_id = ${inv.entryId} AND l.tax_code_id IS NOT NULL ORDER BY l.line_no`.execute(
        trx,
      ),
    );
    expect(taxed.rows.map((r) => r.tax_amount)).toEqual(['100.0000', '25.0000']);
    expect(events).toEqual([
      expect.objectContaining({
        topic: 'ar.invoice.posted',
        aggregateId: inv.invoiceId,
        payload: expect.objectContaining({ invoiceNo: inv.invoiceNo, recipients: [billingEmail] }),
      }),
    ]);
  });

  it('SS-UC01-03 over the threshold the draft waits for approval; approval posts it', async () => {
    const inv = await f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Acme'] ?? '',
          issueDate: '2026-11-06',
          lines: gp001Lines()
            .slice(0, 1)
            .map((l) => ({ ...l, quantity: '3' })),
        },
        { outbox },
      ),
    );
    expect(inv.status).toBe('draft');
    expect(inv.entryId).toBeNull();
    const posted = await f.inTenant((trx) =>
      approveInvoice(trx, { companyId: f.companyId, invoiceId: inv.invoiceId }, { outbox }),
    );
    expect(posted.status).toBe('posted');
    expect(posted.gross).toBe('3300.0000');
  });
});

describe('SS-UC01-05: No Billing To contact blocks approval', () => {
  it('SS-UC01-05 approval without a Billing To contact is refused with NO_BILLING_TO and nothing posts', async () => {
    await f.inTenant((trx) => setArSettings(trx, f.companyId, { autoApprove: false }));
    const inv = await f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Nobill'] ?? '',
          issueDate: '2026-11-07',
          lines: gp001Lines(),
        },
        { outbox },
      ),
    );
    const before = await f.countEntries();
    const err = await f
      .inTenant((trx) =>
        approveInvoice(trx, { companyId: f.companyId, invoiceId: inv.invoiceId }, { outbox }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceError);
    expect((err as InvoiceError).code).toBe('NO_BILLING_TO');
    expect(await f.countEntries()).toBe(before);
    const row = await f.inTenant((trx) =>
      trx
        .selectFrom('app.sales_invoice')
        .select(['status', 'invoice_no'])
        .where('id', '=', inv.invoiceId)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ status: 'draft', invoice_no: null });
  });
});

describe('SS-UC01-11: Tax-inclusive rounding follows company setting', () => {
  const inclusive = (issueDate: string) =>
    f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Acme'] ?? '',
          issueDate,
          pricing: 'inclusive',
          lines: [1, 2, 3].map((n) => ({
            productProfileId: productProfile('SUBSCRIPTION'),
            description: `Seat ${String(n)}`,
            quantity: '1',
            unitPrice: '3.35',
          })),
        },
        { outbox },
      ).then((inv) =>
        approveInvoice(trx, { companyId: f.companyId, invoiceId: inv.invoiceId }, { outbox }),
      ),
    );

  it('SS-UC01-11 total_invoice (AU default) posts GP-023a', async () => {
    const inv = await inclusive('2026-11-08');
    expect(inv.tax).toBe('0.9100');
    expectGolden(await journalOf(inv.entryId ?? ''), golden('GP-023a'));
  });

  it('SS-UC01-11 per_line_2dp posts GP-023b', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.company')
        .set({ tax_rounding: 'per_line_2dp' })
        .where('id', '=', f.companyId)
        .execute(),
    );
    const inv = await inclusive('2026-11-09');
    expect(inv.tax).toBe('0.9000');
    expectGolden(await journalOf(inv.entryId ?? ''), golden('GP-023b'));
  });
});

describe('Invoice rules (T-0040)', () => {
  it('a posting-profile gap is a draft warning and blocks approval with PROFILE_GAP', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.account')
        .set({ status: 'archived' })
        .where('id', '=', f.acct['4140'] ?? '')
        .execute(),
    );
    const inv = await f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Acme'] ?? '',
          issueDate: '2026-11-10',
          lines: [
            {
              productProfileId: productProfile('HARDWARE'),
              description: 'Laptop',
              quantity: '1',
              unitPrice: '2000.00',
            },
          ],
        },
        { outbox },
      ),
    );
    expect(inv.status).toBe('draft');
    expect(inv.warnings).toEqual([expect.objectContaining({ code: 'PROFILE_GAP', line: 1 })]);
    const err = await f
      .inTenant((trx) =>
        approveInvoice(trx, { companyId: f.companyId, invoiceId: inv.invoiceId }, { outbox }),
      )
      .catch((e: unknown) => e);
    expect((err as InvoiceError).code).toBe('PROFILE_GAP');
  });

  it('a credit limit the invoice would exceed puts approval on hold (CREDIT_HOLD)', async () => {
    await f.inTenant((trx) =>
      trx
        .updateTable('app.party')
        .set({ credit_limit: '5000.0000' })
        .where('id', '=', parties['Acme'] ?? '')
        .execute(),
    );
    // Acme already owes 1,375 + 3,300 + 10.05 × 2 from the invoices above.
    const inv = await f.inTenant((trx) =>
      createDraftInvoice(
        trx,
        {
          companyId: f.companyId,
          partyId: parties['Acme'] ?? '',
          issueDate: '2026-11-11',
          lines: gp001Lines(),
        },
        { outbox },
      ),
    );
    const err = await f
      .inTenant((trx) =>
        approveInvoice(trx, { companyId: f.companyId, invoiceId: inv.invoiceId }, { outbox }),
      )
      .catch((e: unknown) => e);
    expect((err as InvoiceError).code).toBe('CREDIT_HOLD');
  });

  it('a posted invoice cannot be changed', async () => {
    const posted = await f.inTenant((trx) =>
      trx
        .selectFrom('app.sales_invoice')
        .select('id')
        .where('status', '=', 'posted')
        .executeTakeFirstOrThrow(),
    );
    const err = await f
      .inTenant((trx) =>
        sql`UPDATE app.sales_invoice SET issue_date = '2026-12-01' WHERE id = ${posted.id}`.execute(
          trx,
        ),
      )
      .catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/posted invoice/);
    const lineErr = await f
      .inTenant((trx) =>
        sql`UPDATE app.sales_invoice_line SET unit_price = 1 WHERE invoice_id = ${posted.id}`.execute(
          trx,
        ),
      )
      .catch((e: unknown) => e as Error);
    expect((lineErr as Error).message).toMatch(/posted invoice/);
  });
});
