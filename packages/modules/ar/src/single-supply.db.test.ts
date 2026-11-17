/**
 * Single-supply receipts (T-0203, ADR-0089 R1–R5, R8, R11, R12; RQ-0171; goldens GP-040, GP-020),
 * against a real PostgreSQL as lf_app. Each journal is compared line for line (account, debit,
 * credit, party, tax code and tax amount) with its Approved golden posting. The contract lines on
 * CUSTOMER_PREPAYMENTS and GST_ATTRIBUTED_UNBILLED carry the contract's `supply_contract`
 * dimension value (AC-7). The company is on the accruals basis until 2027-02-28 and on the cash
 * basis from 2027-03-01 (app.tax_settings, ADR-0071), so one company covers both shapes and the
 * basis-change refusal.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { approvedTables, parsePostings, type GoldenJournal } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { basLabels, setTaxSettings } from '@ledgerforce/tax';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordPrepayment } from './prepayments.ts';
import {
  createSingleSupplyContract,
  recordSingleSupplyReceipt,
  singleSupplyContract,
  type SingleSupplyContractView,
} from './single-supply.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const golden = (id: string): GoldenJournal => {
  const t = tables.find((x) => `${x.entryId}${x.label}` === id);
  if (!t) throw new Error(`${id} not Approved`);
  return t;
};

let f: LedgerFixture;
let customers: string[] = [];
let owner = '';
let bank = '';
const codeOf: Record<string, string> = {};
const money = (s: string) => {
  const [i = '0', d = ''] = s.split('.');
  return `${i}.${d.padEnd(4, '0')}`;
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
async function expectGolden(entryId: string, id: string, party: string, contractId: string) {
  const t = golden(id);
  const rows = await linesOf(entryId);
  expect(rows, id).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const r = rows[i];
    const at = `${id} line ${String(i + 1)} (${g.binding})`;
    expect(r?.code, at).toBe(codeOf[g.binding]);
    expect(r?.debit, at).toBe(money(g.debit || '0'));
    expect(r?.credit, at).toBe(money(g.credit || '0'));
    expect(r?.party_id ?? null, at).toBe(g.party ? party : null);
    const onContract = /CUSTOMER_PREPAYMENTS|GST_ATTRIBUTED_UNBILLED/.test(g.binding);
    expect(r?.contract_value ?? null, at).toBe(onContract ? contractId : null);
    if (g.taxAmount && g.binding.startsWith('system:')) {
      expect(r?.tax_code, at).toBe(g.taxCode);
      expect(r?.tax_amount, at).toBe(money(g.taxAmount.replace('−', '-')));
    }
  });
}

const counts = () =>
  f.inTenant(async (trx) => {
    const r = await sql<{ e: number; r: number; c: number; a: number }>`
      SELECT (SELECT count(*)::int FROM app.journal_entry) AS e,
             (SELECT count(*)::int FROM app.single_supply_receipt) AS r,
             (SELECT count(*)::int FROM app.single_supply_contract) AS c,
             (SELECT count(*)::int FROM app.single_supply_attribution) AS a`.execute(trx);
    return r.rows[0];
  });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'accepted', message: '' }),
    (e: unknown) => e as { code: string; message: string },
  );

let seq = 0;
const contract = (o: {
  party?: string;
  knownNet?: string;
  date?: string;
  taxCode?: string;
  key?: string;
}): Promise<SingleSupplyContractView> =>
  f.inTenant((trx) =>
    createSingleSupplyContract(trx, {
      companyId: f.companyId,
      partyId: o.party ?? customers[0] ?? '',
      reference: `JOB-${String(++seq)}`,
      contractDate: o.date ?? '2026-11-01',
      knownNet: o.knownNet ?? '10000.00',
      ...(o.taxCode ? { taxCode: o.taxCode } : {}),
      confirmedBy: owner,
      idempotencyKey: o.key ?? `contract-${String(seq)}`,
    }),
  );

const receive = (contractId: string, date: string, gross: string, key: string, taxCode?: string) =>
  f.inTenant((trx) =>
    recordSingleSupplyReceipt(trx, {
      companyId: f.companyId,
      contractId,
      receiptDate: date,
      gross,
      depositTo: { accountId: bank },
      ...(taxCode ? { taxCode } : {}),
      idempotencyKey: key,
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

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020303');
  const profiles = await seedBillingCompany(f);
  customers = await seedBillableCustomers(f, profiles, {
    count: 3,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
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
  });
  codeOf['tax:GST.collected'] = codeOf['system:GST_COLLECTED'] ?? '?';
  codeOf['bank:OPERATING'] = '1010';
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-143: single-supply receipts post the whole supply GST once (GP-040)', () => {
  it('SS-PLAT-143 AC-3 the first receipt posts GP-040a and the second GP-040b line for line, with the contract on its lines; BAS G1 11,000.00 / 1A 1,000.00 once [T-0203]', async () => {
    const acme = customers[0] ?? '';
    const c = await contract({ party: acme });
    expect(c).toMatchObject({
      knownNet: '10000.0000',
      gstBasis: 'accrual',
      status: 'open',
      attributedTax: null,
      receivedGross: '0.0000',
    });
    const r1 = await receive(c.contractId, '2026-11-10', '3300.00', 'gp040-r1');
    expect(r1).toMatchObject({
      gross: '3300.0000',
      net: '3000.0000',
      tax: '300.0000',
      attributes: true,
      replayed: false,
    });
    await expectGolden(r1.entryId, 'GP-040a', acme, c.contractId);
    const r2 = await receive(c.contractId, '2026-11-25', '3300.00', 'gp040-r2');
    expect(r2).toMatchObject({ net: '3000.0000', tax: '300.0000', attributes: false });
    await expectGolden(r2.entryId, 'GP-040b', acme, c.contractId);

    const view = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(view).toMatchObject({
      attributedTax: '1000.0000',
      attributionDate: '2026-11-10',
      receivedGross: '6600.0000',
      receivedNet: '6000.0000',
      receivedTax: '600.0000',
      unbilledTax: '400.0000',
      status: 'open',
    });
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('-6000.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('400.0000');
    const nov = await f.inTenant((trx) =>
      basLabels(trx, {
        companyId: f.companyId,
        basis: 'accrual',
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    );
    expect({ G1: nov.G1, '1A': nov['1A'] }).toEqual({ G1: '11000.0000', '1A': '1000.0000' });
  });

  it('SS-PLAT-143 AC-8 the receipt that completes the contract takes the remaining unbilled GST, so per-receipt rounding leaves no residue [T-0203]', async () => {
    const c = await contract({ party: customers[1] ?? '', knownNet: '9999.99' });
    const parts: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const r = await receive(c.contractId, '2026-11-12', '1000.00', `ac8-${String(i)}`);
      parts.push(r.tax);
    }
    expect(parts.every((t) => t === '90.9100')).toBe(true);
    const last = await receive(c.contractId, '2026-11-20', '999.99', 'ac8-last');
    expect(last.tax).toBe('90.9000');
    const view = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(view).toMatchObject({
      attributedTax: '1000.0000',
      receivedGross: '10999.9900',
      receivedNet: '9999.9900',
      receivedTax: '1000.0000',
      unbilledTax: '0.0000',
    });
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('0.0000');
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', c.contractId)).toBe('-9999.9900');
  });

  it('SS-PLAT-143 AC-7 two contracts of one customer keep separate per-contract balances [T-0203]', async () => {
    const party = customers[2] ?? '';
    const a = await contract({ party, knownNet: '10000.00' });
    const b = await contract({ party, knownNet: '2000.00' });
    await receive(a.contractId, '2026-11-14', '3300.00', 'ac7-a');
    await receive(b.contractId, '2026-11-14', '1100.00', 'ac7-b');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', a.contractId)).toBe('700.0000');
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', a.contractId)).toBe('-3000.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', b.contractId)).toBe('100.0000');
    expect(await contractBalance('CUSTOMER_PREPAYMENTS', b.contractId)).toBe('-1000.0000');
    for (const x of [a, b]) {
      const v = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, x.contractId));
      expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', x.contractId)).toBe(v.unbilledTax);
    }
  });

  it('SS-PLAT-143 AC-3 on the cash basis in force a receipt posts GP-020 (GST on the amount received), with no attribution [T-0203]', async () => {
    const acme = customers[0] ?? '';
    const c = await contract({ party: acme, date: '2027-03-02' });
    expect(c.gstBasis).toBe('cash');
    const r = await receive(c.contractId, '2027-03-10', '3300.00', 'cash-1');
    expect(r).toMatchObject({ net: '3000.0000', tax: '300.0000', attributes: false });
    await expectGolden(r.entryId, 'GP-020', acme, c.contractId);
    const v = await f.inTenant((trx) => singleSupplyContract(trx, f.companyId, c.contractId));
    expect(v).toMatchObject({ attributedTax: null, unbilledTax: '0.0000' });
  });
});

describe('SS-PLAT-143: refusals write nothing', () => {
  it('SS-PLAT-143 AC-3 refuses a contract with no known total, a non-taxable code, or an unknown basis [T-0203]', async () => {
    const before = await counts();
    expect((await refusal(contract({ knownNet: '0' }))).code).toBe('NO_CONTRACT_TOTAL');
    expect((await refusal(contract({ knownNet: '' }))).code).toBe('NO_CONTRACT_TOTAL');
    expect((await refusal(contract({ taxCode: 'GST-FREE' }))).code).toBe('INVALID_SINGLE_SUPPLY');
    expect((await refusal(contract({ date: '2026-06-15' }))).code).toBe('INVALID_SINGLE_SUPPLY');
    expect(await counts()).toEqual(before);
  });

  it('SS-PLAT-143 AC-3 refuses a second tax code, receipts above the total, a different basis and a contract that is not open [T-0203]', async () => {
    const c = await contract({ party: customers[1] ?? '', knownNet: '1000.00' });
    await receive(c.contractId, '2026-11-15', '500.00', 'ref-ok');
    const before = await counts();
    const second = await refusal(
      receive(c.contractId, '2026-11-16', '100.00', 'ref-code', 'GST-FREE'),
    );
    expect(second.code).toBe('SECOND_TAX_CODE');
    const above = await refusal(receive(c.contractId, '2026-11-16', '600.01', 'ref-above'));
    expect(above.code).toBe('ABOVE_CONTRACT_TOTAL');
    const basis = await refusal(receive(c.contractId, '2027-03-05', '100.00', 'ref-basis'));
    expect(basis.code).toBe('BASIS_CHANGED');
    expect((await refusal(receive(c.contractId, '2026-11-16', '0', 'ref-zero'))).code).toBe(
      'INVALID_SINGLE_SUPPLY',
    );
    expect(await counts()).toEqual(before);

    await f.inTenant((trx) =>
      trx
        .insertInto('app.single_supply_contract_status')
        .values({
          company_id: f.companyId,
          contract_id: c.contractId,
          status: 'cancelled',
          status_date: '2026-11-17',
        })
        .execute(),
    );
    const closed = await counts();
    const notOpen = await refusal(receive(c.contractId, '2026-11-18', '100.00', 'ref-closed'));
    expect(notOpen.code).toBe('CONTRACT_NOT_OPEN');
    expect(await counts()).toEqual(closed);
    const unknown = await refusal(
      receive('01900000-0000-7000-8000-0000000000ff', '2026-11-18', '1.00', 'ref-unknown'),
    );
    expect(unknown.code).toBe('UNKNOWN_CONTRACT');
  });

  it('SS-PLAT-143 AC-6 recordPrepayment still refuses a single supply and points to the contract path, writing nothing [T-0203]', async () => {
    const before = await counts();
    for (const supplyType of ['single', 'single_supply']) {
      const e = await refusal(
        f.inTenant((trx) =>
          recordPrepayment(trx, {
            companyId: f.companyId,
            partyId: customers[0] ?? '',
            receiptDate: '2026-11-10',
            gross: '3300.00',
            supplyType,
            depositTo: { accountId: bank },
            idempotencyKey: `pre-${supplyType}`,
          }),
        ),
      );
      expect(e.code, supplyType).toBe('INVALID_PREPAYMENT');
      expect(e.message, supplyType).toMatch(/recordSingleSupplyReceipt|single-supply contract/);
    }
    expect(await counts()).toEqual(before);
  });
});

describe('SS-PLAT-144: idempotency and concurrency', () => {
  it('SS-PLAT-144 AC-4 the same key posts once and returns the same view; a contract key creates once [T-0203]', async () => {
    const c = await contract({ party: customers[0] ?? '', key: 'idem-contract' });
    const again = await contract({ party: customers[0] ?? '', key: 'idem-contract' });
    expect(again.contractId).toBe(c.contractId);
    expect(again.replayed).toBe(true);
    const r1 = await receive(c.contractId, '2026-11-20', '1100.00', 'idem-r');
    const before = await counts();
    const r2 = await receive(c.contractId, '2026-11-20', '1100.00', 'idem-r');
    expect(r2).toEqual({ ...r1, replayed: true });
    expect(await counts()).toEqual(before);
  });

  it('SS-PLAT-144 AC-4 two receipts in parallel on one contract: exactly one attributes and the GST is attributed once [T-0203]', async () => {
    const c = await contract({ party: customers[1] ?? '', knownNet: '10000.00' });
    const [a, b] = await Promise.all([
      receive(c.contractId, '2026-11-21', '3300.00', 'par-a'),
      receive(c.contractId, '2026-11-21', '3300.00', 'par-b'),
    ]);
    expect([a.attributes, b.attributes].filter(Boolean)).toHaveLength(1);
    const gst = await f.inTenant(async (trx) => {
      const r = await sql<{ g: string }>`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS g FROM app.journal_line l
          JOIN app.account_role_binding rb ON rb.account_id = l.account_id AND rb.role = 'GST_COLLECTED'
         WHERE l.entry_id = ANY(${sql.val([a.entryId, b.entryId])}::uuid[])`.execute(trx);
      return money(r.rows[0]?.g ?? '0');
    });
    expect(gst).toBe('1000.0000');
    expect(await contractBalance('GST_ATTRIBUTED_UNBILLED', c.contractId)).toBe('400.0000');
  });
});
