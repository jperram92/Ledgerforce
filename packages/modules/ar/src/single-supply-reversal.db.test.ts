/**
 * Single-supply receipt reversal (T-0231: T-0204 AC-3 and AC-9; ADR-0089 R8, R11; RQ-0192;
 * goldens GP-019 (reversal = mirror), GP-040a/b, GP-020; migration 0084), against a real
 * PostgreSQL as lf_app.
 *
 * A reversal is the engine's mirror of the receipt entry (GP-019): every line of the golden with
 * debit and credit swapped, same account, party, contract dimension, tax code and amount. Receipts
 * are reversed last in, first out; once the attributing receipt is reversed the next receipt
 * attributes the whole GST again. The reversal records its BAS treatment (same period or error
 * correction) from the BAS frequency in force on the receipt date.
 *
 * Tax settings: accruals monthly from 2026-07-01, cash monthly from 2027-03-01, accruals
 * quarterly from 2027-04-01, accruals annual from 2027-10-01.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateFiscalYear } from '@ledgerforce/ledger';
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
import { cancelSingleSupply } from './single-supply-cancel.ts';
import { finaliseSingleSupply } from './single-supply-final.ts';
import { reverseSingleSupplyReceipt } from './single-supply-reversal.ts';
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

/**
 * The entry equals the golden table line for line — mirrored (debit ↔ credit, GP-019) when
 * `mirror` is set. Contract lines carry the contract's dimension value.
 */
async function expectGolden(entryId: string, id: string, contractId: string, mirror = false) {
  const t = golden(id);
  const rows = await linesOf(entryId);
  const at0 = `${id}${mirror ? ' mirrored' : ''}`;
  expect(rows, at0).toHaveLength(t.lines.length);
  t.lines.forEach((g, i) => {
    const r = rows[i];
    const at = `${at0} line ${String(i + 1)} (${g.binding})`;
    const [debit, credit] = mirror ? [g.credit, g.debit] : [g.debit, g.credit];
    expect(r?.code, at).toBe(codeOf[g.binding]);
    expect(r?.debit, at).toBe(money(debit || '0'));
    expect(r?.credit, at).toBe(money(credit || '0'));
    expect(r?.party_id ?? null, at).toBe(g.party ? acme : null);
    const onContract = /CUSTOMER_PREPAYMENTS|GST_ATTRIBUTED_UNBILLED/.test(g.binding);
    expect(r?.contract_value ?? null, at).toBe(onContract ? contractId : null);
    if (g.taxAmount && !g.binding.startsWith('tax:')) {
      expect(r?.tax_code, at).toBe(g.taxCode);
      expect(r?.tax_amount, at).toBe(money(g.taxAmount.replace(/^[-−]/, '')));
    } else if (!g.binding.startsWith('tax:')) {
      expect(r?.tax_code ?? null, at).toBeNull();
    }
  });
}

/** Every stored balance of the company (account_balance over all periods), non-zero only. */
const balances = () =>
  f.inTenant(
    async (trx) =>
      (
        await sql<{ k: string; b: string }>`
          SELECT account_id::text || ':' || dimension_set_id::text AS k,
                 sum(debit_total - credit_total)::text AS b
            FROM app.account_balance WHERE company_id = ${f.companyId}::uuid
           GROUP BY account_id, dimension_set_id
          HAVING sum(debit_total - credit_total) <> 0
           ORDER BY 1`.execute(trx)
      ).rows,
  );

const counts = () =>
  f.inTenant(async (trx) => {
    const r = await sql<{ e: number; v: number; n: number; s: number }>`
      SELECT (SELECT count(*)::int FROM app.journal_entry) AS e,
             (SELECT count(*)::int FROM app.single_supply_receipt_reversal) AS v,
             (SELECT count(*)::int FROM app.single_supply_attribution_renewal) AS n,
             (SELECT count(*)::int FROM app.single_supply_contract_status) AS s`.execute(trx);
    return r.rows[0];
  });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => ({ code: 'accepted', message: '' }),
    (e: unknown) => e as { code: string; message: string },
  );

let seq = 0;
async function contract(date = '2026-11-01', knownNet = '10000.00') {
  const n = ++seq;
  return f.inTenant((trx) =>
    createSingleSupplyContract(trx, {
      companyId: f.companyId,
      partyId: acme,
      reference: `REV-${String(n)}`,
      contractDate: date,
      knownNet,
      confirmedBy: owner,
      idempotencyKey: `rev-contract-${String(n)}`,
    }),
  );
}

const receive = (contractId: string, date: string, gross: string, key: string) =>
  f.inTenant((trx) =>
    recordSingleSupplyReceipt(trx, {
      companyId: f.companyId,
      contractId,
      receiptDate: date,
      gross,
      depositTo: { accountId: bank },
      idempotencyKey: key,
    }),
  );

const reverse = (receiptId: string, o: { key: string; date: string; reason?: string }) =>
  f.inTenant((trx) =>
    reverseSingleSupplyReceipt(trx, {
      companyId: f.companyId,
      receiptId,
      reversalDate: o.date,
      reason: o.reason ?? 'Receipt posted in error (payment dishonoured)',
      idempotencyKey: o.key,
      createdBy: owner,
    }),
  );

const view = (contractId: string) =>
  f.inTenant((trx) => singleSupplyContract(trx, f.companyId, contractId));

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000023101');
  const profiles = await seedBillingCompany(f);
  [acme = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Acme',
    billDate: '2026-11-01',
  });
  services = profiles.productProfiles.get('PROFESSIONAL_SERVICES') ?? '';
  owner = await f.addUser('owner');
  bank = f.acct['1010'] ?? '';
  await f.inTenant(async (trx) => {
    for (const startYear of [2027, 2028]) {
      await generateFiscalYear(trx, { companyId: f.companyId, convention: 'AU', startYear });
    }
    for (const [effectiveFrom, gstBasis, basFrequency] of [
      ['2026-07-01', 'accrual', 'monthly'],
      ['2027-03-01', 'cash', 'monthly'],
      ['2027-04-01', 'accrual', 'quarterly'],
      ['2027-10-01', 'accrual', 'annual'],
    ] as const) {
      await setTaxSettings(trx, { companyId: f.companyId, effectiveFrom, gstBasis, basFrequency });
    }
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

describe('SS-PLAT-202: reversing a single-supply receipt mirrors it and restores every balance', () => {
  it('SS-PLAT-202 AC-3 a GP-040a receipt reversed before finalisation: the GP-040a mirror line for line, every stored balance restored, nothing attributed; replay idempotent; the next receipt attributes the whole GST again (GP-040a) [T-0231]', async () => {
    const before = await balances();
    const c = await contract();
    const r = await receive(c.contractId, '2026-11-10', '3300.00', 'rev-a-r1');
    expect(r.attributes).toBe(true);
    const v = await reverse(r.receiptId, { key: 'rev-a', date: '2026-11-20' });
    expect(v).toMatchObject({
      receiptId: r.receiptId,
      contractId: c.contractId,
      reversedEntryId: r.entryId,
      replayed: false,
      reversalDate: '2026-11-20',
      receiptDate: '2026-11-10',
      unattributes: true,
      basTreatment: 'same_period',
      basPeriodStart: '2026-11-01',
      basPeriodEnd: '2026-11-30',
    });
    await expectGolden(v.entryId, 'GP-040a', c.contractId, true);
    expect(await balances()).toEqual(before);
    expect(await view(c.contractId)).toMatchObject({
      status: 'open',
      attributedTax: null,
      attributionDate: null,
      receivedGross: '0.0000',
      receivedNet: '0.0000',
      receivedTax: '0.0000',
      unbilledTax: '0.0000',
    });
    const reversedStatus = await f.inTenant(
      async (trx) =>
        (
          await sql<{
            status: string;
          }>`SELECT status FROM app.journal_entry WHERE id = ${r.entryId}::uuid`.execute(trx)
        ).rows[0]?.status,
    );
    expect(reversedStatus).toBe('reversed');

    const n = await counts();
    expect(await reverse(r.receiptId, { key: 'rev-a', date: '2026-11-20' })).toMatchObject({
      replayed: true,
      reversalId: v.reversalId,
      entryId: v.entryId,
    });
    expect(await counts()).toEqual(n);

    // The next receipt is the contract's first again: it attributes the whole GST (GP-040a).
    const again = await receive(c.contractId, '2026-11-25', '3300.00', 'rev-a-r2');
    expect(again.attributes).toBe(true);
    await expectGolden(again.entryId, 'GP-040a', c.contractId);
    expect(await view(c.contractId)).toMatchObject({
      attributedTax: '1000.0000',
      attributionDate: '2026-11-25',
      receivedGross: '3300.0000',
      unbilledTax: '700.0000',
    });
    // A later receipt clears the renewed attribution (GP-040b).
    const b = await receive(c.contractId, '2026-11-26', '3300.00', 'rev-a-r3');
    expect(b.attributes).toBe(false);
    await expectGolden(b.entryId, 'GP-040b', c.contractId);
  });

  it('SS-PLAT-202 AC-3 receipts are reversed last in, first out: the GP-040b receipt first (its mirror), then the GP-040a receipt; the contract returns to no receipt and every balance is restored [T-0231]', async () => {
    const before = await balances();
    const c = await contract();
    const a = await receive(c.contractId, '2026-11-10', '3300.00', 'rev-l-r1');
    const b = await receive(c.contractId, '2026-11-25', '3300.00', 'rev-l-r2');
    const n = await counts();
    expect(
      await refusal(reverse(a.receiptId, { key: 'rev-l-a0', date: '2026-11-28' })),
    ).toMatchObject({ code: 'NOT_LATEST_RECEIPT' });
    expect(await counts()).toEqual(n);
    const vb = await reverse(b.receiptId, { key: 'rev-l-b', date: '2026-11-28' });
    expect(vb.unattributes).toBe(false);
    await expectGolden(vb.entryId, 'GP-040b', c.contractId, true);
    expect(await view(c.contractId)).toMatchObject({
      attributedTax: '1000.0000',
      receivedGross: '3300.0000',
      unbilledTax: '700.0000',
    });
    const va = await reverse(a.receiptId, { key: 'rev-l-a', date: '2026-11-29' });
    expect(va.unattributes).toBe(true);
    await expectGolden(va.entryId, 'GP-040a', c.contractId, true);
    expect(await balances()).toEqual(before);
    expect(await view(c.contractId)).toMatchObject({
      attributedTax: null,
      receivedGross: '0.0000',
      unbilledTax: '0.0000',
    });
  });

  it('SS-PLAT-202 AC-3 a cash-basis GP-020 receipt reversed: the GP-020 mirror line for line, balances restored [T-0231]', async () => {
    const before = await balances();
    const c = await contract('2027-03-01');
    expect(c.gstBasis).toBe('cash');
    const r = await receive(c.contractId, '2027-03-10', '3300.00', 'rev-c-r1');
    await expectGolden(r.entryId, 'GP-020', c.contractId);
    const v = await reverse(r.receiptId, { key: 'rev-c', date: '2027-03-12' });
    expect(v).toMatchObject({ unattributes: false, basTreatment: 'same_period' });
    await expectGolden(v.entryId, 'GP-020', c.contractId, true);
    expect(await balances()).toEqual(before);
    expect(await view(c.contractId)).toMatchObject({ receivedGross: '0.0000' });
  });
});

describe('SS-PLAT-203: receipt reversals no golden covers are refused with nothing written', () => {
  it('SS-PLAT-203 AC-3 after finalisation (credit note instead), after cancellation, already reversed, an early date, a missing or long reason, a basis change and an unknown receipt are refused by name [T-0231]', async () => {
    // Finalised: the receipts are allocated to the final invoice (GP-045).
    const fin = await contract();
    const fr = await receive(fin.contractId, '2026-11-10', '3300.00', 'ref-f-r1');
    await f.inTenant((trx) =>
      finaliseSingleSupply(trx, {
        companyId: f.companyId,
        contractId: fin.contractId,
        invoiceDate: '2026-12-15',
        lines: [{ description: 'Project', productProfileId: services, amount: '10000.00' }],
        idempotencyKey: 'ref-f-final',
      }),
    );
    // Cancelled: the cancellation already adjusted the GST (GP-044).
    const can = await contract();
    const cr = await receive(can.contractId, '2026-11-10', '3300.00', 'ref-c-r1');
    await f.inTenant((trx) =>
      cancelSingleSupply(trx, {
        companyId: f.companyId,
        contractId: can.contractId,
        cancelDate: '2026-12-05',
        refund: 'agreed',
        reason: 'Customer cancelled',
        idempotencyKey: 'ref-c-cancel',
        createdBy: owner,
      }),
    );
    const open = await contract();
    const or = await receive(open.contractId, '2026-11-10', '3300.00', 'ref-o-r1');
    const twice = await contract();
    const tr = await receive(twice.contractId, '2026-11-10', '3300.00', 'ref-t-r1');
    await reverse(tr.receiptId, { key: 'ref-t-1', date: '2026-11-11' });
    // A receipt in February (accruals) reversed in March (cash basis in force).
    const basis = await contract('2027-02-01');
    const br = await receive(basis.contractId, '2027-02-10', '3300.00', 'ref-b-r1');

    const n = await counts();
    const cases: [() => Promise<unknown>, string][] = [
      [
        () => reverse(fr.receiptId, { key: 'ref-1', date: '2026-12-20' }),
        'REVERSAL_AFTER_FINALISATION',
      ],
      [
        () => reverse(cr.receiptId, { key: 'ref-2', date: '2026-12-20' }),
        'REVERSAL_AFTER_CANCELLATION',
      ],
      [() => reverse(tr.receiptId, { key: 'ref-3', date: '2026-11-12' }), 'ALREADY_REVERSED'],
      [() => reverse(or.receiptId, { key: 'ref-4', date: '2026-11-09' }), 'INVALID_SINGLE_SUPPLY'],
      [() => reverse(or.receiptId, { key: 'ref-5', date: '2026-11-31' }), 'INVALID_SINGLE_SUPPLY'],
      [
        () => reverse(or.receiptId, { key: 'ref-6', date: '2026-11-20', reason: ' ' }),
        'INVALID_SINGLE_SUPPLY',
      ],
      [
        () => reverse(or.receiptId, { key: 'ref-7', date: '2026-11-20', reason: 'x'.repeat(501) }),
        'INVALID_SINGLE_SUPPLY',
      ],
      [() => reverse(br.receiptId, { key: 'ref-8', date: '2027-03-05' }), 'BASIS_CHANGED'],
      [
        () => reverse('01900000-0000-7000-8000-00000000dead', { key: 'ref-9', date: '2026-11-20' }),
        'UNKNOWN_RECEIPT',
      ],
      [() => reverse('not-a-uuid', { key: 'ref-10', date: '2026-11-20' }), 'UNKNOWN_RECEIPT'],
    ];
    for (const [p, code] of cases) {
      const res = await refusal(p());
      expect(res.code, res.message).toBe(code);
    }
    expect(await counts()).toEqual(n);
    expect((await view(fin.contractId)).status).toBe('finalised');
    expect((await view(can.contractId)).status).toBe('cancelled');
  });

  it('SS-PLAT-203 lf_app cannot UPDATE or DELETE a reversal or a renewal, a second reversal of a receipt and a second renewal after one reversal are refused, and the stored treatment must match its period [T-0231]', async () => {
    const c = await contract();
    const r1 = await receive(c.contractId, '2026-11-10', '3300.00', 'imm-r1');
    const v = await reverse(r1.receiptId, { key: 'imm-v1', date: '2026-11-11' });
    const r2 = await receive(c.contractId, '2026-11-12', '3300.00', 'imm-r2');
    expect(r2.attributes).toBe(true);
    // 42501: lf_app holds no UPDATE/DELETE grant; 23505: one reversal per receipt, one renewal
    // per reversal.
    const expected = ['42501', '42501', '42501', '42501', '23505', '23505'];
    for (const [i, stmt] of [
      sql`UPDATE app.single_supply_receipt_reversal SET reason = 'x' WHERE id = ${v.reversalId}::uuid`,
      sql`DELETE FROM app.single_supply_receipt_reversal WHERE id = ${v.reversalId}::uuid`,
      sql`UPDATE app.single_supply_attribution_renewal SET attributed_tax = 0 WHERE after_reversal_id = ${v.reversalId}::uuid`,
      sql`DELETE FROM app.single_supply_attribution_renewal WHERE after_reversal_id = ${v.reversalId}::uuid`,
      sql`INSERT INTO app.single_supply_receipt_reversal
            (company_id, contract_id, receipt_id, reversal_date, reason, reversed_entry_id, entry_id,
             unattributes, bas_treatment, bas_period_start, bas_period_end, idempotency_key)
          VALUES (${f.companyId}::uuid, ${c.contractId}::uuid, ${r1.receiptId}::uuid, '2026-11-11',
                  'again', ${r1.entryId}::uuid, ${v.entryId}::uuid, true, 'same_period',
                  '2026-11-01', '2026-11-30', 'imm-second')`,
      sql`INSERT INTO app.single_supply_attribution_renewal
            (company_id, contract_id, after_reversal_id, attribution_date, attributed_tax, entry_id)
          VALUES (${f.companyId}::uuid, ${c.contractId}::uuid, ${v.reversalId}::uuid, '2026-11-12',
                  1000, ${r2.entryId}::uuid)`,
    ].entries()) {
      const res = await refusal(f.inTenant((trx) => stmt.execute(trx)));
      expect(res.code, res.message).toBe(expected[i]);
    }
    // A treatment that contradicts its own period is refused by the CHECK.
    const r3 = await receive(c.contractId, '2026-11-13', '100.00', 'imm-r3');
    const res = await refusal(
      f.inTenant((trx) =>
        sql`INSERT INTO app.single_supply_receipt_reversal
              (company_id, contract_id, receipt_id, reversal_date, reason, reversed_entry_id, entry_id,
               unattributes, bas_treatment, bas_period_start, bas_period_end, idempotency_key)
            VALUES (${f.companyId}::uuid, ${c.contractId}::uuid, ${r3.receiptId}::uuid, '2026-12-02',
                    'wrong label', ${r3.entryId}::uuid, ${v.entryId}::uuid, false, 'same_period',
                    '2026-11-01', '2026-11-30', 'imm-label')`.execute(trx),
      ),
    );
    expect(res.code, res.message).toBe('23514');
  });
});

describe('SS-PLAT-204: a receipt reversal records its BAS treatment for BAS preparation', () => {
  it('SS-PLAT-204 AC-9 monthly, quarterly and annual: same_period within the receipt period, error_correction after it, the period set by the frequency in force on the receipt date [T-0231]', async () => {
    const cases: [string, string, string, string, string, string][] = [
      // contract date, receipt date, reversal date, treatment, period start, period end
      ['2026-11-01', '2026-11-10', '2026-11-30', 'same_period', '2026-11-01', '2026-11-30'],
      ['2026-11-01', '2026-11-10', '2026-12-01', 'error_correction', '2026-11-01', '2026-11-30'],
      ['2027-04-01', '2027-05-10', '2027-06-30', 'same_period', '2027-04-01', '2027-06-30'],
      ['2027-04-01', '2027-05-10', '2027-07-01', 'error_correction', '2027-04-01', '2027-06-30'],
      ['2027-10-01', '2027-10-10', '2028-06-30', 'same_period', '2027-07-01', '2028-06-30'],
      ['2027-10-01', '2027-10-10', '2028-07-01', 'error_correction', '2027-07-01', '2028-06-30'],
    ];
    for (const [i, [cd, rd, vd, treatment, start, end]] of cases.entries()) {
      const c = await contract(cd);
      const r = await receive(c.contractId, rd, '3300.00', `bas-${String(i)}-r`);
      const v = await reverse(r.receiptId, { key: `bas-${String(i)}`, date: vd });
      const at = `${rd} reversed ${vd}`;
      expect(v.basTreatment, at).toBe(treatment);
      expect(v.basPeriodStart, at).toBe(start);
      expect(v.basPeriodEnd, at).toBe(end);
      // The reversal is dated on its own date (never back-dated, GP-019 period rule).
      const date = await f.inTenant(
        async (trx) =>
          (
            await sql<{ d: string; s: string; o: string | null }>`
              SELECT to_char(entry_date, 'YYYY-MM-DD') AS d, source_type AS s,
                     reversal_of_id::text AS o
                FROM app.journal_entry WHERE id = ${v.entryId}::uuid`.execute(trx)
          ).rows[0],
      );
      expect(date, at).toEqual({ d: vd, s: 'ledger_reversal', o: r.entryId });
      const stored = await f.inTenant(
        async (trx) =>
          (
            await sql<{ t: string }>`
              SELECT bas_treatment AS t FROM app.single_supply_receipt_reversal
               WHERE id = ${v.reversalId}::uuid`.execute(trx)
          ).rows[0]?.t,
      );
      expect(stored, at).toBe(treatment);
    }
  });
});
