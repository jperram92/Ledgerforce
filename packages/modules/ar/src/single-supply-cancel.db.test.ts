/**
 * Single-supply cancellation and refund (T-0217: T-0204 AC-2 and AC-10 rest; ADR-0089 R7 +
 * addendum A; RQ-0184; golden GP-044a–d; migration 0082), against a real PostgreSQL as lf_app.
 *
 * Every entry is compared line for line (account, debit, credit, party, contract dimension, tax
 * code and amount) with GP-044a/b/c/d. 44b is the existing customer refund (GP-006, ADR-0074
 * maker-checker) allocated to the 44a credit; 44d is the contract refund with an approver who is
 * not its maker. The company is on the accruals basis until 2027-02-28 and on the cash basis from
 * 2027-03-01.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { subledgerEntriesOf } from '@ledgerforce/ledger';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { setTaxSettings } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveCustomerRefund,
  createCustomerRefund,
  customerCredit,
  payCustomerRefund,
} from './refunds.ts';
import {
  createSingleSupplyContract,
  recordSingleSupplyReceipt,
  singleSupplyContract,
} from './single-supply.ts';
import { cancelSingleSupply, refundCancelledSingleSupply } from './single-supply-cancel.ts';
import { finaliseSingleSupply } from './single-supply-final.ts';
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
let approver = '';
let bank = '';
let services = '';
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
    const r = await sql<{ e: number; s: number; c: number; r: number }>`
      SELECT (SELECT count(*)::int FROM app.journal_entry) AS e,
             (SELECT count(*)::int FROM app.single_supply_contract_status) AS s,
             (SELECT count(*)::int FROM app.single_supply_cancellation) AS c,
             (SELECT count(*)::int FROM app.single_supply_refund) AS r`.execute(trx);
    return r.rows[0];
  });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'accepted', message: '' }),
    (e: unknown) => e as { code: string; message: string },
  );

let seq = 0;
async function contractWithReceipts(o: {
  date?: string;
  knownNet?: string;
  receipts?: readonly (readonly [string, string])[];
}) {
  const n = ++seq;
  const c = await f.inTenant((trx) =>
    createSingleSupplyContract(trx, {
      companyId: f.companyId,
      partyId: acme,
      reference: `CAN-${String(n)}`,
      contractDate: o.date ?? '2026-11-01',
      knownNet: o.knownNet ?? '10000.00',
      confirmedBy: owner,
      idempotencyKey: `can-contract-${String(n)}`,
    }),
  );
  for (const [i, [date, gross]] of (o.receipts ?? [['2026-11-10', '3300.00']]).entries()) {
    await f.inTenant((trx) =>
      recordSingleSupplyReceipt(trx, {
        companyId: f.companyId,
        contractId: c.contractId,
        receiptDate: date,
        gross,
        depositTo: { accountId: bank },
        idempotencyKey: `can-${String(n)}-r${String(i)}`,
      }),
    );
  }
  return c;
}

const cancel = (
  contractId: string,
  o: { key: string; date?: string; refund?: string; reason?: string },
) =>
  f.inTenant((trx) =>
    cancelSingleSupply(trx, {
      companyId: f.companyId,
      contractId,
      cancelDate: o.date ?? '2026-12-05',
      refund: (o.refund ?? 'agreed') as 'agreed',
      reason: o.reason ?? 'Customer cancelled the project',
      idempotencyKey: o.key,
      createdBy: owner,
    }),
  );

const contractRefund = (
  contractId: string,
  o: { key: string; date?: string; approvedBy?: string; createdBy?: string },
) =>
  f.inTenant((trx) =>
    refundCancelledSingleSupply(trx, {
      companyId: f.companyId,
      contractId,
      refundDate: o.date ?? '2027-01-20',
      payFrom: { accountId: bank },
      reason: 'Refund agreed after the cancellation',
      createdBy: o.createdBy ?? owner,
      approvedBy: o.approvedBy ?? approver,
      idempotencyKey: o.key,
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

/** GST collected (credit − debit) over the given entries. */
const gstOf = (entries: readonly string[]) =>
  f.inTenant(async (trx) => {
    const r = await sql<{ g: string }>`
      SELECT coalesce(sum(l.credit - l.debit), 0)::text AS g
        FROM app.journal_line l
        JOIN app.account_role_binding rb ON rb.account_id = l.account_id AND rb.role = 'GST_COLLECTED'
       WHERE l.entry_id = ANY(${sql.val(entries)}::uuid[])`.execute(trx);
    return money(r.rows[0]?.g ?? '0');
  });

const receiptEntries = (contractId: string) =>
  f.inTenant(async (trx) =>
    (
      await sql<{ entry_id: string }>`
          SELECT entry_id::text FROM app.single_supply_receipt
           WHERE contract_id = ${contractId}::uuid ORDER BY receipt_date, created_at`.execute(trx)
    ).rows.map((r) => r.entry_id),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000021701');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  services = profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
  owner = await f.addUser('owner');
  approver = await f.addUser('owner');
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
  });
  codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
  codeOf['bank:OPERATING'] = '1010';
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-181: cancelling a single supply posts GP-044 and the refund follows its path', () => {
  it('SS-PLAT-181 AC-2 AC-10 refund agreed: GP-044a line for line (whole 1,000.00 decrease, 3,300.00 AR credit, adjustment-note particulars), contract cancelled, replay idempotent, receipts, final invoice and a second cancellation refused; GP-044b through the customer refund approval path allocated to that credit [T-0217]', async () => {
    const c = await contractWithReceipts({});
    const v = await cancel(c.contractId, { key: 'gp044a' });
    expect(v).toMatchObject({
      contractId: c.contractId,
      replayed: false,
      cancelDate: '2026-12-05',
      refund: 'agreed',
      reason: 'Customer cancelled the project',
      customerCredit: '3300.0000',
      adjustmentNote: {
        title: 'Adjustment note',
        reason: 'Customer cancelled the project',
        decreaseNet: '10000.0000',
        decreaseTax: '1000.0000',
        decreaseGross: '11000.0000',
        adjusts: `GST attributed on ${c.reference} on 2026-11-10`,
        withinThreshold: false,
      },
    });
    expect(v.entryId).not.toBeNull();
    await expectGolden(v.entryId ?? '', 'GP-044a', c.contractId);
    const items = await f.inTenant((trx) => subledgerEntriesOf(trx, v.entryId ?? ''));
    expect(items.map((i) => [i.originalAmount, i.openAmount])).toEqual([
      ['-3300.0000', '-3300.0000'],
    ]);
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('0.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');
    const entries = [...(await receiptEntries(c.contractId)), v.entryId ?? ''];
    expect(await gstOf(entries)).toBe('0.0000');
    const view = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(view.status).toBe('cancelled');

    const before = await counts();
    expect(await cancel(c.contractId, { key: 'gp044a' })).toMatchObject({
      replayed: true,
      entryId: v.entryId,
    });
    expect(await refusal(cancel(c.contractId, { key: 'gp044a-second' }))).toMatchObject({
      code: 'CONTRACT_NOT_OPEN',
    });
    expect(
      await refusal(
        f.inTenant((trx) =>
          recordSingleSupplyReceipt(trx, {
            companyId: f.companyId,
            contractId: c.contractId,
            receiptDate: '2026-12-06',
            gross: '100.00',
            depositTo: { accountId: bank },
            idempotencyKey: 'gp044a-late-receipt',
          }),
        ),
      ),
    ).toMatchObject({ code: 'CONTRACT_NOT_OPEN' });
    expect(
      await refusal(
        f.inTenant((trx) =>
          finaliseSingleSupply(trx, {
            companyId: f.companyId,
            contractId: c.contractId,
            invoiceDate: '2026-12-15',
            lines: [{ description: 'Done', productProfileId: services, amount: '10000.00' }],
            idempotencyKey: 'gp044a-final',
          }),
        ),
      ),
    ).toMatchObject({ code: 'CONTRACT_NOT_OPEN' });
    // The money is an AR credit: the contract refund (44d) is not its path.
    expect(await refusal(contractRefund(c.contractId, { key: 'gp044a-44d' }))).toMatchObject({
      code: 'REFUND_VIA_CUSTOMER_REFUND',
    });
    expect(await counts()).toEqual(before);

    // GP-044b: request by one person, approval by another (ADR-0074), paid by the bank.
    const credit = await f.inTenant((trx) => customerCredit(trx, f.companyId, acme));
    expect(credit.available).toBe('3300.0000');
    const refundId = randomUUID();
    await f.inTenant((trx) =>
      createCustomerRefund(trx, {
        companyId: f.companyId,
        id: refundId,
        partyId: acme,
        refundDate: '2026-12-12',
        amount: '3300.00',
        method: 'bank_batch',
        reason: `Refund of ${c.reference} after cancellation`,
        createdBy: owner,
      }),
    );
    expect(
      await refusal(
        f.inTenant((trx) =>
          payCustomerRefund(trx, {
            companyId: f.companyId,
            refundId,
            paidOn: '2026-12-12',
            bankAccountId: bank,
          }),
        ),
      ),
    ).toMatchObject({ code: 'NOT_APPROVED' });
    await f.inTenant((trx) =>
      approveCustomerRefund(trx, { companyId: f.companyId, refundId, approvedBy: approver }),
    );
    const paid = await f.inTenant((trx) =>
      payCustomerRefund(trx, {
        companyId: f.companyId,
        refundId,
        paidOn: '2026-12-12',
        bankAccountId: bank,
        createdBy: owner,
      }),
    );
    await expectGolden(paid.entryId ?? '', 'GP-044b', c.contractId);
    const after = await f.inTenant((trx) => subledgerEntriesOf(trx, v.entryId ?? ''));
    expect(after.map((i) => i.openAmount)).toEqual(['0.0000']);
    const allocated = await f.inTenant(
      async (trx) =>
        (
          await sql<{ to_entry: string; amount: string }>`
            SELECT s.entry_id::text AS to_entry, a.amount::text
              FROM app.allocation a JOIN app.subledger_entry s ON s.id = a.to_entry_id
             WHERE a.from_entry_id = (SELECT id FROM app.subledger_entry WHERE entry_id = ${paid.entryId}::uuid)`.execute(
            trx,
          )
        ).rows,
    );
    expect(allocated).toEqual([{ to_entry: v.entryId, amount: '3300.0000' }]);
  });

  it('SS-PLAT-181 AC-2 AC-10 refund undecided: GP-044c line for line (unbilled 700.00 removed, particulars), money held; GP-044d later with its own adjustment note, approver not the maker; every contract balance ends at zero [T-0217]', async () => {
    const c = await contractWithReceipts({});
    const v = await cancel(c.contractId, { key: 'gp044c', refund: 'undecided' });
    expect(v).toMatchObject({
      refund: 'undecided',
      customerCredit: '0.0000',
      adjustmentNote: {
        decreaseNet: '7000.0000',
        decreaseTax: '700.0000',
        decreaseGross: '7700.0000',
        withinThreshold: false,
      },
    });
    await expectGolden(v.entryId ?? '', 'GP-044c', c.contractId);
    expect(await f.inTenant((trx) => subledgerEntriesOf(trx, v.entryId ?? ''))).toEqual([]);
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('-3000.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');

    const before = await counts();
    expect(
      await refusal(contractRefund(c.contractId, { key: 'gp044d-self', approvedBy: owner })),
    ).toMatchObject({ code: 'SOD_REFUND_SELF_APPROVAL' });
    expect(
      await refusal(contractRefund(c.contractId, { key: 'gp044d-early', date: '2026-12-04' })),
    ).toMatchObject({ code: 'INVALID_SINGLE_SUPPLY' });
    expect(await counts()).toEqual(before);

    const r = await contractRefund(c.contractId, { key: 'gp044d' });
    expect(r).toMatchObject({
      contractId: c.contractId,
      replayed: false,
      refundDate: '2027-01-20',
      gross: '3300.0000',
      net: '3000.0000',
      tax: '300.0000',
      createdBy: owner,
      approvedBy: approver,
      adjustmentNote: {
        title: 'Adjustment note',
        reason: 'Refund agreed after the cancellation',
        decreaseNet: '3000.0000',
        decreaseTax: '300.0000',
        decreaseGross: '3300.0000',
        adjusts: `GST attributed on ${c.reference} on 2026-11-10`,
        withinThreshold: false,
      },
    });
    await expectGolden(r.entryId, 'GP-044d', c.contractId);
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('0.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');
    const entries = [...(await receiptEntries(c.contractId)), v.entryId ?? '', r.entryId];
    expect(await gstOf(entries)).toBe('0.0000');

    const again = await counts();
    expect(await contractRefund(c.contractId, { key: 'gp044d' })).toMatchObject({
      replayed: true,
      entryId: r.entryId,
    });
    expect(await refusal(contractRefund(c.contractId, { key: 'gp044d-second' }))).toMatchObject({
      code: 'ALREADY_REFUNDED',
    });
    expect(await counts()).toEqual(again);
  });

  it('SS-PLAT-181 AC-2 nothing attributed (accruals, no receipt) and a cash-basis contract post no cancellation entry; the cash-basis money is refunded by the GP-044d shape with the GST of the receipts reversed [T-0217]', async () => {
    const none = await contractWithReceipts({ receipts: [] });
    const v0 = await cancel(none.contractId, { key: 'cancel-none' });
    expect(v0).toMatchObject({ entryId: null, adjustmentNote: null, customerCredit: '0.0000' });
    expect(
      (await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, none.contractId))).status,
    ).toBe('cancelled');
    expect(await refusal(contractRefund(none.contractId, { key: 'none-44d' }))).toMatchObject({
      code: 'NOTHING_TO_REFUND',
    });

    const cash = await contractWithReceipts({
      date: '2027-03-02',
      receipts: [['2027-03-05', '3300.00']],
    });
    const v1 = await cancel(cash.contractId, { key: 'cancel-cash', date: '2027-03-10' });
    expect(v1).toMatchObject({ entryId: null, adjustmentNote: null, customerCredit: '0.0000' });
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', cash.contractId)).toBe('-3000.0000');
    const r = await contractRefund(cash.contractId, { key: 'cash-44d', date: '2027-03-20' });
    expect(r).toMatchObject({
      gross: '3300.0000',
      net: '3000.0000',
      tax: '300.0000',
      adjustmentNote: {
        adjusts: `GST on the receipts of ${cash.reference}`,
        decreaseTax: '300.0000',
      },
    });
    await expectGolden(r.entryId, 'GP-044d', cash.contractId);
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', cash.contractId)).toBe('0.0000');
    const entries = [...(await receiptEntries(cash.contractId)), r.entryId];
    expect(await gstOf(entries)).toBe('0.0000');
  });

  it('SS-PLAT-181 AC-10 a small decrease (GST within $75) still carries the particulars, flagged within the threshold [T-0217]', async () => {
    const c = await contractWithReceipts({
      knownNet: '500.00',
      receipts: [['2026-11-10', '110.00']],
    });
    const v = await cancel(c.contractId, { key: 'small-agreed' });
    expect(v.adjustmentNote).toMatchObject({
      decreaseNet: '500.0000',
      decreaseTax: '50.0000',
      decreaseGross: '550.0000',
      withinThreshold: true,
    });
    expect(v.customerCredit).toBe('110.0000');
  });
});

describe('SS-PLAT-183: cancellations and refunds the goldens do not cover are refused with nothing written', () => {
  it('SS-PLAT-183 forfeiture, missing or long reasons, an unknown refund decision, dates before the last receipt, a basis change, a finalised contract, an unknown contract, and a contract refund on an open contract are refused by name [T-0217]', async () => {
    const c = await contractWithReceipts({ receipts: [['2026-11-20', '3300.00']] });
    const before = await counts();
    const cases: [() => Promise<unknown>, string][] = [
      [() => cancel(c.contractId, { key: 'x1', refund: 'forfeited' }), 'FORFEITURE_NOT_SUPPORTED'],
      [() => cancel(c.contractId, { key: 'x2', refund: 'maybe' }), 'INVALID_SINGLE_SUPPLY'],
      [() => cancel(c.contractId, { key: 'x3', reason: '  ' }), 'INVALID_SINGLE_SUPPLY'],
      [() => cancel(c.contractId, { key: 'x4', reason: 'r'.repeat(501) }), 'INVALID_SINGLE_SUPPLY'],
      [() => cancel(c.contractId, { key: 'x5', date: '2026-11-19' }), 'INVALID_SINGLE_SUPPLY'],
      [() => cancel(c.contractId, { key: 'x6', date: '2026-13-01' }), 'INVALID_SINGLE_SUPPLY'],
      [() => cancel(c.contractId, { key: 'x7', date: '2027-03-05' }), 'BASIS_CHANGED'],
      [() => cancel(randomUUID(), { key: 'x8' }), 'UNKNOWN_CONTRACT'],
      [() => cancel('not-a-uuid', { key: 'x9' }), 'UNKNOWN_CONTRACT'],
      [() => contractRefund(c.contractId, { key: 'x10' }), 'CONTRACT_NOT_CANCELLED'],
    ];
    for (const [p, code] of cases) {
      const r = await refusal(p());
      expect(r.code, r.message).toBe(code);
    }
    expect(await counts()).toEqual(before);

    const fin = await contractWithReceipts({});
    await f.inTenant((trx) =>
      finaliseSingleSupply(trx, {
        companyId: f.companyId,
        contractId: fin.contractId,
        invoiceDate: '2026-12-15',
        lines: [{ description: 'Done', productProfileId: services, amount: '10000.00' }],
        idempotencyKey: 'x-final',
      }),
    );
    expect(await refusal(cancel(fin.contractId, { key: 'x11', date: '2026-12-20' }))).toMatchObject(
      { code: 'CONTRACT_NOT_OPEN' },
    );
  });

  it('SS-PLAT-183 lf_app cannot UPDATE or DELETE a cancellation or a contract refund, a second row per contract is refused, and the database refuses a refund approved by its maker [T-0217]', async () => {
    const c = await contractWithReceipts({});
    const v = await cancel(c.contractId, { key: 'imm-cancel', refund: 'undecided' });
    const r = await contractRefund(c.contractId, { key: 'imm-refund' });
    const other = await contractWithReceipts({});
    await cancel(other.contractId, { key: 'imm-cancel-2', refund: 'undecided' });
    for (const stmt of [
      sql`UPDATE app.single_supply_cancellation SET reason = 'x' WHERE contract_id = ${c.contractId}::uuid`,
      sql`DELETE FROM app.single_supply_cancellation WHERE contract_id = ${c.contractId}::uuid`,
      sql`UPDATE app.single_supply_refund SET reason = 'x' WHERE contract_id = ${c.contractId}::uuid`,
      sql`DELETE FROM app.single_supply_refund WHERE contract_id = ${c.contractId}::uuid`,
      sql`INSERT INTO app.single_supply_cancellation
            (company_id, contract_id, cancel_date, refund_decision, reason, decrease_net,
             decrease_tax, idempotency_key)
          VALUES (${f.companyId}::uuid, ${c.contractId}::uuid, '2026-12-05', 'agreed', 'again', 0, 0, 'imm-second')`,
      // Approved by its own maker: refused by the CHECK even when written directly.
      sql`INSERT INTO app.single_supply_refund
            (company_id, contract_id, refund_date, gross, net, tax, account_id, entry_id, reason,
             created_by, approved_by, idempotency_key)
          VALUES (${f.companyId}::uuid, ${other.contractId}::uuid, '2027-01-20', 3300, 3000, 300,
                  ${bank}::uuid, ${r.entryId}::uuid, 'self', ${owner}::uuid, ${owner}::uuid, 'imm-self')`,
    ]) {
      const res = await refusal(f.inTenant((trx) => stmt.execute(trx)));
      expect(res.code, res.message).not.toBe('accepted');
    }
    expect(v.entryId).not.toBeNull();
  });
});
