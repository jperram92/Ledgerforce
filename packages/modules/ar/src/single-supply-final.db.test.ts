/**
 * Single-supply final tax invoice (T-0204 slice 1: AC-1 accruals, AC-6 guard, AC-8, AC-10 on
 * 45c; ADR-0089 R6 + addendum A; RQ-0178; golden GP-045), against a real PostgreSQL as lf_app.
 *
 * Every final invoice is compared line for line (account, debit, credit, party, tax code and
 * amount) with GP-045a/b/c. The invoice is a register invoice (app.sales_invoice) numbered from
 * the invoice series; its AR debit item equals the tax invoice and the cash received is an AR
 * credit item allocated to it in the same entry. The company is on the accruals basis until
 * 2027-02-28 and on the cash basis from 2027-03-01.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { setTaxSettings } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSingleSupplyContract,
  recordSingleSupplyReceipt,
  singleSupplyContract,
} from './single-supply.ts';
import { finaliseSingleSupply, type FinalInvoiceLineInput } from './single-supply-final.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const golden = (id: string): GoldenJournal => {
  const t = tables.find((x) => `${x.entryId}${x.label}` === id);
  if (!t) throw new Error(`${id} not Approved`);
  return t;
};

let f: LedgerFixture;
let acme = '';
let owner = '';
let bank = '';
let services = '';
let subscriptions = '';
const codeOf: Record<string, string> = {};
const money = (s: string) => {
  const neg = s.startsWith('-') || s.startsWith('−');
  const [i = '0', d = ''] = s.replace(/^[-−]/, '').replace(/,/g, '').split('.');
  return `${neg ? '-' : ''}${i}.${d.padEnd(4, '0')}`;
};

interface StoredLine {
  code: string;
  debit: string;
  credit: string;
  party_id: string | null;
  tax_code: string | null;
  tax_amount: string | null;
  contract_value: string | null;
}

const linesOf = (entryId: string) =>
  f.inTenant(
    async (trx) =>
      (
        await sql<StoredLine>`
          SELECT a.code, l.debit::text, l.credit::text, l.party_id::text, tc.code AS tax_code,
                 l.tax_amount::text,
                 (SELECT v.code FROM app.dimension_value v JOIN app.dimension d ON d.id = v.dimension_id
                   WHERE d.code = 'supply_contract' AND v.id = ANY(s.value_ids)) AS contract_value
            FROM app.journal_line l
            JOIN app.account a ON a.id = l.account_id
            JOIN app.dimension_set s ON s.id = l.dimension_set_id
            LEFT JOIN app.tax_code tc ON tc.id = l.tax_code_id
           WHERE l.entry_id = ${entryId}::uuid ORDER BY l.line_no`.execute(trx)
      ).rows,
  );

/** The entry equals the golden table line for line; contract lines carry the contract. */
async function expectGolden(entryId: string, id: string, contractId: string) {
  const t = golden(id);
  const rows = await linesOf(entryId);
  expect(rows, id).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const r = rows[i];
    const at = `${id} line ${String(i + 1)} (${g.binding})`;
    expect(r?.code, at).toBe(codeOf[g.binding]);
    expect(r?.debit, at).toBe(money(g.debit || '0'));
    expect(r?.credit, at).toBe(money(g.credit || '0'));
    expect(r?.party_id ?? null, at).toBe(g.party ? acme : null);
    const onContract = /CUSTOMER_PREPAYMENTS|GST_ATTRIBUTED_UNBILLED/.test(g.binding);
    expect(r?.contract_value ?? null, at).toBe(onContract ? contractId : null);
    if (g.taxAmount && !g.binding.startsWith('tax:')) {
      expect(r?.tax_code, at).toBe(g.taxCode);
      // The engine stores the tax amount unsigned; its side is the line's debit or credit.
      expect(r?.tax_amount, at).toBe(money(g.taxAmount.replace(/^[-−]/, '')));
    } else if (!g.binding.startsWith('tax:')) {
      expect(r?.tax_code ?? null, at).toBeNull();
    }
  });
}

const counts = () =>
  f.inTenant(async (trx) => {
    const r = await sql<{ e: number; i: number; s: number; fz: number }>`
      SELECT (SELECT count(*)::int FROM app.journal_entry) AS e,
             (SELECT count(*)::int FROM app.sales_invoice) AS i,
             (SELECT count(*)::int FROM app.single_supply_contract_status) AS s,
             (SELECT count(*)::int FROM app.single_supply_finalisation) AS fz`.execute(trx);
    return r.rows[0];
  });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'accepted', message: '' }),
    (e: unknown) => e as { code: string; message: string },
  );

let seq = 0;
async function contractWithReceipts(o: {
  knownNet?: string;
  date?: string;
  receipts?: readonly (readonly [string, string])[];
}) {
  const n = ++seq;
  const c = await f.inTenant((trx) =>
    createSingleSupplyContract(trx, {
      companyId: f.companyId,
      partyId: acme,
      reference: `FIN-${String(n)}`,
      contractDate: o.date ?? '2026-11-01',
      knownNet: o.knownNet ?? '10000.00',
      confirmedBy: owner,
      idempotencyKey: `fin-contract-${String(n)}`,
    }),
  );
  const receipts = o.receipts ?? [
    ['2026-11-10', '3300.00'],
    ['2026-11-25', '3300.00'],
  ];
  for (const [i, [date, gross]] of receipts.entries()) {
    await f.inTenant((trx) =>
      recordSingleSupplyReceipt(trx, {
        companyId: f.companyId,
        contractId: c.contractId,
        receiptDate: date,
        gross,
        depositTo: { accountId: bank },
        idempotencyKey: `fin-${String(n)}-r${String(i)}`,
      }),
    );
  }
  return c;
}

const line = (amount: string, profile = services, description = 'Project completed') =>
  ({ description, productProfileId: profile, amount }) satisfies FinalInvoiceLineInput;

const finalise = (
  contractId: string,
  o: {
    key: string;
    date?: string;
    lines?: FinalInvoiceLineInput[];
    priceChange?: { variationDate: string; reason: string };
  },
) =>
  f.inTenant((trx) =>
    finaliseSingleSupply(trx, {
      companyId: f.companyId,
      contractId,
      invoiceDate: o.date ?? '2026-12-15',
      lines: o.lines ?? [line('10000.00')],
      ...(o.priceChange ? { priceChange: o.priceChange } : {}),
      idempotencyKey: o.key,
      createdBy: owner,
    }),
  );

/** Balance (debit − credit) of a role's account carrying one contract's dimension value. */
const contractBalance = (role: string, contractId: string) =>
  f.inTenant(async (trx) => {
    const r = await sql<{ b: string }>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b
        FROM app.journal_line l
        JOIN app.account_role_binding rb ON rb.account_id = l.account_id AND rb.role = ${role}
        JOIN app.dimension_set s ON s.id = l.dimension_set_id
        JOIN app.single_supply_contract c ON c.dimension_value_id = ANY(s.value_ids)
       WHERE c.id = ${contractId}::uuid`.execute(trx);
    return money(r.rows[0]?.b ?? '0');
  });

/** GST collected (credit − debit) by every entry of one contract: receipts and the invoice. */
const contractGst = (contractId: string) =>
  f.inTenant(async (trx) => {
    const r = await sql<{ g: string }>`
      SELECT coalesce(sum(l.credit - l.debit), 0)::text AS g
        FROM app.journal_line l
        JOIN app.account_role_binding rb ON rb.account_id = l.account_id AND rb.role = 'GST_COLLECTED'
       WHERE l.entry_id IN (
         SELECT entry_id FROM app.single_supply_receipt WHERE contract_id = ${contractId}::uuid
         UNION SELECT entry_id FROM app.single_supply_contract_status WHERE contract_id = ${contractId}::uuid)`.execute(
      trx,
    );
    return money(r.rows[0]?.g ?? '0');
  });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020401');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  services = profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
  subscriptions = profiles.productProfiles.get('SUBSCRIPTION') ?? '';
  owner = await f.addUser('owner');
  bank = f.acct['1010'] ?? '';
  await f.inTenant(async (trx) => {
    await setTaxSettings(trx, {
      companyId: f.companyId,
      effectiveFrom: '2026-07-01',
      gstBasis: 'accrual',
      basFrequency: 'monthly',
    });
    await setTaxSettings(trx, {
      companyId: f.companyId,
      effectiveFrom: '2027-03-01',
      gstBasis: 'cash',
      basFrequency: 'monthly',
    });
    const roles = await sql<{ role: string; code: string }>`
      SELECT b.role, a.code FROM app.account_role_binding b JOIN app.account a ON a.id = b.account_id
       WHERE b.company_id = ${f.companyId}::uuid`.execute(trx);
    for (const r of roles.rows) codeOf[`system:${r.role}`] = r.code;
    const rev = await sql<{ code: string }>`
      SELECT a.code FROM app.product_posting_profile p JOIN app.account a ON a.id = p.revenue_account_id
       WHERE p.id = ${services}::uuid`.execute(trx);
    codeOf['product:PROFESSIONAL_SERVICES.revenue'] = rev.rows[0]?.code ?? '?';
  });
  codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
  codeOf['bank:OPERATING'] = '1010';
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-157: the final tax invoice of a single supply posts GP-045 (whole invoice on AR, receipts allocated)', () => {
  it('SS-PLAT-157 AC-1 price unchanged posts GP-045a line for line: register invoice 11,000.00 with the fixed GST, AR credit 6,600.00 allocated, unbilled and prepayments cleared, contract finalised, replay idempotent, second finalisation and later receipts refused [T-0204]', async () => {
    const c = await contractWithReceipts({});
    const inv = await finalise(c.contractId, { key: 'gp045a' });
    expect(inv).toMatchObject({
      contractId: c.contractId,
      replayed: false,
      issueDate: '2026-12-15',
      netTotal: '10000.0000',
      taxTotal: '1000.0000',
      grossTotal: '11000.0000',
      receivedGross: '6600.0000',
      amountDue: '4400.0000',
      priceChange: null,
    });
    expect(inv.invoiceNo).toMatch(/^INV-/);
    expect(inv.lines).toEqual([
      {
        lineNo: 1,
        description: 'Project completed',
        net: '10000.0000',
        tax: '1000.0000',
        gross: '11000.0000',
      },
    ]);
    await expectGolden(inv.entryId, 'GP-045a', c.contractId);

    const stored = await f.inTenant(
      async (trx) =>
        (
          await sql<{
            status: string;
            invoice_no: string;
            entry_id: string;
            gross_total: string;
            tax_total: string;
            party_id: string;
          }>`SELECT status, invoice_no, entry_id::text, gross_total::text, tax_total::text, party_id::text
               FROM app.sales_invoice WHERE id = ${inv.invoiceId}::uuid`.execute(trx)
        ).rows[0],
    );
    expect(stored).toEqual({
      status: 'posted',
      invoice_no: inv.invoiceNo,
      entry_id: inv.entryId,
      gross_total: '11000.0000',
      tax_total: '1000.0000',
      party_id: acme,
    });
    const items = await f.inTenant((trx) => subledgerEntriesOf(trx, inv.entryId));
    expect(items.map((i) => [i.originalAmount, i.openAmount])).toEqual([
      ['11000.0000', '4400.0000'],
      ['-6600.0000', '0.0000'],
    ]);

    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('0.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');
    expect(await contractGst(c.contractId)).toBe('1000.0000');
    const view = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(view.status).toBe('finalised');

    const before = await counts();
    const again = await finalise(c.contractId, { key: 'gp045a' });
    expect(again).toMatchObject({
      replayed: true,
      invoiceId: inv.invoiceId,
      invoiceNo: inv.invoiceNo,
      entryId: inv.entryId,
    });
    expect(await refusal(finalise(c.contractId, { key: 'gp045a-second' }))).toMatchObject({
      code: 'CONTRACT_NOT_OPEN',
    });
    expect(
      await refusal(
        f.inTenant((trx) =>
          recordSingleSupplyReceipt(trx, {
            companyId: f.companyId,
            contractId: c.contractId,
            receiptDate: '2026-12-20',
            gross: '100.00',
            depositTo: { accountId: bank },
            idempotencyKey: 'gp045a-late-receipt',
          }),
        ),
      ),
    ).toMatchObject({ code: 'CONTRACT_NOT_OPEN' });
    expect(await counts()).toEqual(before);
  });

  it('SS-PLAT-157 AC-1 a price increase agreed on the invoice date posts GP-045b: the 500.00 change coded with its own 50.00 GST, invoice 11,550.00, due 4,950.00, GST for the contract 1,050.00 [T-0204]', async () => {
    const c = await contractWithReceipts({});
    const inv = await finalise(c.contractId, {
      key: 'gp045b',
      lines: [line('10500.00')],
      priceChange: { variationDate: '2026-12-15', reason: 'Additional scope agreed at handover' },
    });
    expect(inv).toMatchObject({
      netTotal: '10500.0000',
      taxTotal: '1050.0000',
      grossTotal: '11550.0000',
      amountDue: '4950.0000',
      priceChange: {
        net: '500.0000',
        tax: '50.0000',
        variationDate: '2026-12-15',
        reason: 'Additional scope agreed at handover',
        adjustmentNote: null,
      },
    });
    await expectGolden(inv.entryId, 'GP-045b', c.contractId);
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');
    expect(await contractGst(c.contractId)).toBe('1050.0000');
  });

  it('SS-PLAT-157 AC-1 AC-10 a price reduction agreed on the invoice date posts GP-045c and the document carries adjustment-note particulars although 50.00 GST is within the $75 threshold [T-0204]', async () => {
    const c = await contractWithReceipts({});
    const inv = await finalise(c.contractId, {
      key: 'gp045c',
      lines: [line('9500.00')],
      priceChange: { variationDate: '2026-12-15', reason: 'Price concession for late completion' },
    });
    expect(inv).toMatchObject({
      netTotal: '9500.0000',
      taxTotal: '950.0000',
      grossTotal: '10450.0000',
      amountDue: '3850.0000',
    });
    expect(inv.priceChange).toEqual({
      net: '-500.0000',
      tax: '-50.0000',
      variationDate: '2026-12-15',
      reason: 'Price concession for late completion',
      adjustmentNote: {
        title: 'Adjustment note',
        reason: 'Price concession for late completion',
        decreaseNet: '500.0000',
        decreaseTax: '50.0000',
        decreaseGross: '550.0000',
        adjusts: `GST attributed on ${c.reference} on 2026-11-10`,
        withinThreshold: true,
      },
    });
    await expectGolden(inv.entryId, 'GP-045c', c.contractId);
    expect(await contractGst(c.contractId)).toBe('950.0000');
    const particulars = await f.inTenant(
      async (trx) =>
        (
          await sql<{
            price_change_net: string;
            price_change_tax: string;
            variation_reason: string;
          }>`
            SELECT price_change_net::text, price_change_tax::text, variation_reason
              FROM app.single_supply_finalisation WHERE contract_id = ${c.contractId}::uuid`.execute(
            trx,
          )
        ).rows[0],
    );
    expect(particulars).toEqual({
      price_change_net: '-500.0000',
      price_change_tax: '-50.0000',
      variation_reason: 'Price concession for late completion',
    });
  });

  it('SS-PLAT-157 AC-1 several lines: one uncoded revenue line per account, the change coded on the largest line, the fixed GST spread over the printed lines by the GP-023a residual rule [T-0204]', async () => {
    const c = await contractWithReceipts({
      knownNet: '100.00',
      receipts: [['2026-11-10', '11.00']],
    });
    const same = await finalise(c.contractId, {
      key: 'multi-line',
      lines: [
        line('33.33', services, 'Design'),
        line('33.33', subscriptions, 'Hosting'),
        line('33.34', services, 'Build'),
      ],
    });
    // 10.00 GST: 3.333 / 3.333 / 3.334 → 3.33 each, residual 0.01 to the largest line (33.34).
    expect(same.lines.map((l) => [l.net, l.tax, l.gross])).toEqual([
      ['33.3300', '3.3300', '36.6600'],
      ['33.3300', '3.3300', '36.6600'],
      ['33.3400', '3.3400', '36.6800'],
    ]);
    const rows = await linesOf(same.entryId);
    const revenue = rows.filter((r) => r.code.startsWith('4'));
    expect(revenue.map((r) => [r.credit, r.tax_code])).toEqual([
      ['66.6700', null],
      ['33.3300', null],
    ]);

    const d = await contractWithReceipts({ knownNet: '10000.00' });
    const changed = await finalise(d.contractId, {
      key: 'multi-line-change',
      lines: [line('4000.00', services, 'Design'), line('6600.00', subscriptions, 'Hosting')],
      priceChange: { variationDate: '2026-12-15', reason: 'Hosting extended' },
    });
    const changedRevenue = (await linesOf(changed.entryId)).filter((r) => r.code.startsWith('4'));
    expect(changedRevenue.map((r) => [r.credit, r.tax_code, r.tax_amount])).toEqual([
      ['4000.0000', null, null],
      ['6000.0000', null, null],
      ['600.0000', 'GST', '60.0000'],
    ]);
    expect(changed).toMatchObject({ taxTotal: '1060.0000', grossTotal: '11660.0000' });
  });
});

describe('SS-PLAT-157: the finalisation record (migration 0078) is immutable and one per contract', () => {
  it('SS-PLAT-157 AC-1 lf_app cannot UPDATE or DELETE a finalisation, and a second row for the contract is refused by the key [T-0204]', async () => {
    const c = await contractWithReceipts({});
    const inv = await finalise(c.contractId, { key: 'immutable-final' });
    for (const stmt of [
      sql`UPDATE app.single_supply_finalisation SET variation_reason = 'x' WHERE contract_id = ${c.contractId}::uuid`,
      sql`DELETE FROM app.single_supply_finalisation WHERE contract_id = ${c.contractId}::uuid`,
      sql`INSERT INTO app.single_supply_finalisation
            (company_id, contract_id, invoice_id, entry_id, invoice_date, final_net,
             price_change_net, price_change_tax, idempotency_key)
          VALUES (${f.companyId}::uuid, ${c.contractId}::uuid, ${inv.invoiceId}::uuid,
                  ${inv.entryId}::uuid, '2026-12-15', 10000, 0, 0, 'second-row')`,
    ]) {
      const r = await refusal(f.inTenant((trx) => stmt.execute(trx)));
      expect(r.code, r.message).not.toBe('accepted');
    }
  });
});

describe('SS-PLAT-158: final invoices the goldens do not cover are refused with nothing written', () => {
  it('SS-PLAT-158 AC-6 AC-8 a changed price without a variation agreed on the invoice date, a final price below the cash received, and a change larger than its line are refused by name [T-0204]', async () => {
    const c = await contractWithReceipts({});
    const before = await counts();
    const cases: [string, () => Promise<unknown>][] = [
      [
        'VARIATION_NOT_ON_INVOICE_DATE',
        () => finalise(c.contractId, { key: 'no-variation', lines: [line('10500.00')] }),
      ],
      [
        'VARIATION_NOT_ON_INVOICE_DATE',
        () =>
          finalise(c.contractId, {
            key: 'earlier-variation',
            lines: [line('10500.00')],
            priceChange: { variationDate: '2026-12-01', reason: 'Agreed earlier' },
          }),
      ],
      [
        'INVALID_SINGLE_SUPPLY',
        () =>
          finalise(c.contractId, {
            key: 'change-without-change',
            priceChange: { variationDate: '2026-12-15', reason: 'Nothing changed' },
          }),
      ],
      [
        'BELOW_CASH_RECEIVED',
        () =>
          finalise(c.contractId, {
            key: 'below-cash',
            lines: [line('5000.00')],
            priceChange: { variationDate: '2026-12-15', reason: 'Scope cut' },
          }),
      ],
      [
        'CHANGE_EXCEEDS_LINE',
        () =>
          finalise(c.contractId, {
            key: 'change-exceeds-line',
            lines: [line('10000.00', services), line('10000.00', subscriptions)],
            priceChange: { variationDate: '2026-12-15', reason: 'Big extension' },
          }),
      ],
      ['INVALID_SINGLE_SUPPLY', () => finalise(c.contractId, { key: 'no-lines', lines: [] })],
      [
        'INVALID_SINGLE_SUPPLY',
        () => finalise(c.contractId, { key: 'bad-amount', lines: [line('10000.001')] }),
      ],
      [
        'INVALID_SINGLE_SUPPLY',
        () => finalise(c.contractId, { key: 'before-receipt', date: '2026-11-20' }),
      ],
      [
        'UNKNOWN_CONTRACT',
        () => finalise('00000000-0000-7000-8000-000000000000', { key: 'unknown' }),
      ],
    ];
    for (const [code, run] of cases) {
      const r = await refusal(run());
      expect(r.code, r.message).toBe(code);
    }
    expect(await counts()).toEqual(before);
    const view = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(view.status).toBe('open');
  });

  it('SS-PLAT-158 a contract with nothing attributed, a cash-basis contract and an invoice dated after a basis change are refused by name until their goldens are built (T-0217) [T-0204]', async () => {
    const none = await contractWithReceipts({ receipts: [] });
    const cash = await contractWithReceipts({
      date: '2027-03-01',
      receipts: [['2027-03-05', '3300.00']],
    });
    const changed = await contractWithReceipts({});
    const before = await counts();
    expect(await refusal(finalise(none.contractId, { key: 'nothing-attributed' }))).toMatchObject({
      code: 'NOTHING_ATTRIBUTED',
    });
    expect(
      await refusal(finalise(cash.contractId, { key: 'cash-final', date: '2027-03-20' })),
    ).toMatchObject({ code: 'CASH_BASIS_NOT_BUILT' });
    expect(
      await refusal(finalise(changed.contractId, { key: 'basis-changed', date: '2027-03-20' })),
    ).toMatchObject({ code: 'BASIS_CHANGED' });
    expect(await counts()).toEqual(before);
  });
});
