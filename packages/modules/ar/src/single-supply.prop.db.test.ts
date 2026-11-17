/**
 * SS-PLAT-144 / T-0203 AC-5 — single-supply contract invariants (ADR-0089 R11) over random known
 * totals and receipt sequences on the accruals basis, against a real PostgreSQL as lf_app.
 * Default numRuns (100), never lowered. Amounts are generated as integer cents and handled as
 * Decimal, compared as NUMERIC text; nothing uses floating point. The expected GST is derived here
 * independently: 10 % of the known total in cents, half-up (the total invoice rule).
 */
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { setTaxSettings } from '@ledgerforce/tax';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSingleSupplyContract, recordSingleSupplyReceipt } from './single-supply.ts';
import { seedBillableCustomers, seedBillingCompany } from './testing/batch-fixture.ts';

let f: LedgerFixture;
let party = '';
let owner = '';
let run = 0;

const cents = (c: bigint) => new Decimal(c.toString());
/** Whole cents → NUMERIC(19,4) text, and → a 2-decimal amount string. */
const num = (c: Decimal) => Money.of(c.div(100), 'XXX').toNumericString();
const dec = (c: Decimal) => c.div(100).toString();
/** NUMERIC text → whole cents. */
const toCents = (s: string | undefined) => new Decimal(s ?? '0').times(100);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000020304');
  const profiles = await seedBillingCompany(f);
  [party = ''] = await seedBillableCustomers(f, profiles, {
    count: 1,
    prefix: 'Prop',
    billDate: '2026-11-01',
  });
  owner = await f.addUser('owner');
  await f.inTenant((trx) =>
    setTaxSettings(trx, {
      companyId: f.companyId,
      effectiveFrom: '2026-07-01',
      gstBasis: 'accrual',
      basFrequency: 'monthly',
    }),
  );
}, 180_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

/** Split `total` cents into receipts by positive weights; each receipt ≥ 1 cent. */
function split(total: Decimal, weights: number[]): Decimal[] {
  const ws = [...weights];
  while (ws.length > 1 && total.lt(ws.length)) ws.pop();
  const sum = ws.reduce((s, w) => s.plus(w), new Decimal(0));
  const out: Decimal[] = [];
  let given = new Decimal(0);
  let acc = new Decimal(0);
  for (const [i, w] of ws.entries()) {
    acc = acc.plus(w);
    // Cumulative floor, keeping at least one cent for every receipt still to come.
    let upTo = total.times(acc).div(sum).floor();
    const cap = total.minus(ws.length - i - 1);
    if (upTo.gt(cap)) upTo = cap;
    if (upTo.lte(given)) upTo = given.plus(1);
    out.push(upTo.minus(given));
    given = upTo;
  }
  return out;
}

describe('SS-PLAT-144: single-supply contract invariants (ADR-0089 R11)', () => {
  it('SS-PLAT-144 AC-5 every entry balances, GST reported = GST on the known total, unbilled = attributed − received GST, liability = net received, per contract [T-0203]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 6 }),
        fc.boolean(),
        async (netGen, weights, completeGen) => {
          run += 1;
          let complete = completeGen;
          const netCents = cents(netGen);
          const wholeTax = netCents.plus(5).divToInt(10); // 10 % half-up, in cents
          const total = netCents.plus(wholeTax);
          let receipts = split(total, weights);
          if (!complete && receipts.length > 1) receipts = receipts.slice(0, -1);
          if (receipts.length === 1 && receipts[0]?.eq(total)) complete = true;
          const k = await f.inTenant((trx) =>
            createSingleSupplyContract(trx, {
              companyId: f.companyId,
              partyId: party,
              reference: `PROP-${String(run)}`,
              contractDate: '2026-11-01',
              knownNet: dec(netCents),
              confirmedBy: owner,
              idempotencyKey: `prop-contract-${String(run)}`,
            }),
          );
          const entries: string[] = [];
          let gstReceived = new Decimal(0);
          let netReceived = new Decimal(0);
          for (const [i, r] of receipts.entries()) {
            const v = await f.inTenant((trx) =>
              recordSingleSupplyReceipt(trx, {
                companyId: f.companyId,
                contractId: k.contractId,
                receiptDate: '2026-11-15',
                gross: dec(r),
                depositTo: { accountId: f.acct['1010'] ?? '' },
                idempotencyKey: `prop-${String(run)}-${String(i)}`,
              }),
            );
            expect(v.attributes).toBe(i === 0);
            entries.push(v.entryId);
            gstReceived = gstReceived.plus(toCents(v.tax));
            netReceived = netReceived.plus(toCents(v.net));
          }
          const r = await f.inTenant(
            async (trx) =>
              (
                await sql<{
                  unbalanced: number;
                  gst: string;
                  coded_tax: string;
                  unbilled: string;
                  liability: string;
                }>`
                  WITH l AS (
                    SELECT l.*, rb.role,
                           (${k.dimensionValueId}::uuid = ANY(s.value_ids)) AS on_contract
                      FROM app.journal_line l
                      JOIN app.dimension_set s ON s.id = l.dimension_set_id
                      LEFT JOIN app.account_role_binding rb ON rb.account_id = l.account_id
                     WHERE l.entry_id = ANY(${sql.val(entries)}::uuid[]))
                  SELECT
                    (SELECT count(*)::int FROM (SELECT entry_id FROM l GROUP BY entry_id
                       HAVING sum(debit) <> sum(credit)) u) AS unbalanced,
                    (SELECT coalesce(sum(credit - debit), 0) FROM l WHERE role = 'GST_COLLECTED')::text AS gst,
                    (SELECT coalesce(sum(tax_amount), 0) FROM l WHERE tax_code_id IS NOT NULL)::text AS coded_tax,
                    (SELECT coalesce(sum(debit - credit), 0) FROM l
                      WHERE role = 'GST_ATTRIBUTED_UNBILLED' AND on_contract)::text AS unbilled,
                    (SELECT coalesce(sum(credit - debit), 0) FROM l
                      WHERE role = 'CUSTOMER_PREPAYMENTS' AND on_contract)::text AS liability`.execute(
                  trx,
                )
              ).rows[0],
          );
          expect(r?.unbalanced).toBe(0);
          const n4 = (s: string | undefined) => num(toCents(s));
          expect(n4(r?.gst)).toBe(num(wholeTax));
          expect(n4(r?.coded_tax)).toBe(num(wholeTax));
          expect(n4(r?.unbilled)).toBe(num(wholeTax.minus(gstReceived)));
          expect(n4(r?.liability)).toBe(num(netReceived));
          if (complete) {
            expect(n4(r?.unbilled)).toBe('0.0000');
            expect(n4(r?.liability)).toBe(num(netCents));
          }
        },
      ),
    );
  }, 600_000);
});
