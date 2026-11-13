/**
 * Stripe payout → GP-027 (T-0075, design §3.8 row 3, RQ-0107, DL-0403) against a real PostgreSQL as
 * lf_app. The payout's balance transactions use Stripe's documented object shape (fee_details with a
 * `tax` entry for GST on the fee; Stripe SDK types, OpenAPI v2596). They are not a live recording;
 * T-0130 adds the recorded contract fixture and the API fetch.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedBillingCompany } from '@ledgerforce/ar/testing';
import { approvedTables, parsePostings } from '@ledgerforce/ledger/golden';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  processStripePayout,
  StripePayoutError,
  type StripeBalanceTransaction,
  type StripePayoutFacts,
} from './payout.ts';
import { setStripeSettings } from './webhook.ts';

const FILE = resolve(import.meta.dirname, '../../../../Docs/accounting/postings.md');
const gp027 = approvedTables(parsePostings(readFileSync(FILE, 'utf8'))).find(
  (t) => t.entryId === 'GP-027',
);

let f: LedgerFixture;
let stripeParty = '';
let gstPaidCode = '';
const CODE_OF: Record<string, () => string> = {
  'bank:OPERATING': () => '1010',
  'setting:stripe.fee_account': () => '6120',
  'tax:GST.paid': () => gstPaidCode,
  'setting:stripe.clearing_account': () => '1210',
};
const money = (s: string) =>
  s === '' ? '0.0000' : `${s.replace(/,/g, '')}${s.includes('.') ? '00' : '.0000'}`;

/** GP-003's 1,375.00 charge paid out on 2026-11-17: fee 21.53 + GST 2.15 = 23.68, net 1,351.32. */
const charge: StripeBalanceTransaction = {
  id: 'txn_1T0075Charge0001',
  type: 'charge',
  amount: 137500,
  fee: 2368,
  net: 135132,
  currency: 'aud',
  fee_details: [
    {
      amount: 2153,
      currency: 'aud',
      description: 'Stripe processing fees',
      type: 'stripe_fee',
      application: null,
    },
    { amount: 215, currency: 'aud', description: 'GST', type: 'tax', application: null },
  ],
};
const payoutTxn: StripeBalanceTransaction = {
  id: 'txn_1T0075Payout001',
  type: 'payout',
  amount: -135132,
  fee: 0,
  net: -135132,
  currency: 'aud',
  fee_details: [],
};
const payout: StripePayoutFacts = {
  id: 'po_1T0075Payout0001',
  amountCents: 135132,
  currency: 'aud',
  arrivalDate: '2026-11-17',
};

async function journal(entryId: string) {
  return f.inTenant(
    async (trx) =>
      (
        await sql<{
          code: string;
          debit: string;
          credit: string;
          party_id: string | null;
          source_type: string;
        }>`
        SELECT a.code, l.debit::text, l.credit::text, l.party_id::text, e.source_type
          FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
          JOIN app.journal_entry e ON e.id = l.entry_id
         WHERE l.entry_id = ${entryId} ORDER BY l.line_no`.execute(trx)
      ).rows,
  );
}

const process = (p: StripePayoutFacts, txns: readonly StripeBalanceTransaction[]) =>
  f.inTenant((trx) =>
    processStripePayout(trx, { companyId: f.companyId, payout: p, balanceTransactions: txns }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000007501');
  await seedBillingCompany(f);
  await f.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({
        company_id: f.companyId,
        legal_name: 'Stripe Payments Australia Pty Ltd',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: f.companyId, party_id: p.id, role: 'supplier' })
      .execute();
    stripeParty = p.id;
    await setStripeSettings(trx, f.companyId, {
      clearingAccountId: f.acct['1210'] ?? '',
      feeAccountId: f.acct['6120'] ?? '',
      payoutAccountId: f.acct['1010'] ?? '',
      stripePartyId: stripeParty,
    });
    gstPaidCode =
      (
        await sql<{ code: string }>`
        SELECT a.code FROM app.account_system_role r JOIN app.account a ON a.id = r.account_id
         WHERE r.company_id = ${f.companyId} AND r.role = 'GST_PAID'`.execute(trx)
      ).rows[0]?.code ?? '';
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC03-03: Stripe payout posts GP-004 net settlement', () => {
  it('SS-UC03-03 the payout of the GP-003 charge (fee 23.68, GST 2.15) posts exactly GP-027 and nets Stripe clearing to 0.00', async () => {
    expect(gp027?.sourceType).toBe('payments.stripe.payout');
    const out = await process(payout, [charge, payoutTxn]);
    expect(out.replayed).toBe(false);
    const rows = await journal(out.entryId);
    expect(rows).toHaveLength(gp027?.lines.length ?? -1);
    gp027?.lines.forEach((g, i) => {
      const at = `GP-027 line ${String(i + 1)}`;
      expect(rows[i]?.code, at).toBe(CODE_OF[g.binding]?.());
      expect(rows[i]?.debit, at).toBe(money(g.debit));
      expect(rows[i]?.credit, at).toBe(money(g.credit));
      expect(rows[i]?.party_id ?? null, at).toBe(g.party ? stripeParty : null);
    });
    expect(rows.every((r) => r.source_type === 'payments_stripe_payout')).toBe(true);
    // Stripe clearing: the payout credits exactly the charges' gross that GP-003 debited.
    expect(rows.find((r) => r.code === '1210')?.credit).toBe('1375.0000');

    const record = await f.inTenant((trx) =>
      trx
        .selectFrom('app.stripe_payout')
        .select([
          'stripe_payout_id',
          'amount',
          'gross',
          'fee',
          'fee_gst',
          'gst_evidence',
          'entry_id',
        ])
        .where('company_id', '=', f.companyId)
        .executeTakeFirstOrThrow(),
    );
    expect(record).toEqual({
      stripe_payout_id: payout.id,
      amount: '1351.3200',
      gross: '1375.0000',
      fee: '21.5300',
      fee_gst: '2.1500',
      gst_evidence: 'pending_tax_invoice',
      entry_id: out.entryId,
    });
  });

  it('processing the same payout again posts nothing and returns the first entry', async () => {
    const first = await f.inTenant((trx) =>
      trx.selectFrom('app.stripe_payout').select('entry_id').executeTakeFirstOrThrow(),
    );
    const again = await process(payout, [charge, payoutTxn]);
    expect(again).toEqual({ entryId: first.entry_id, replayed: true });
    const n = await f.inTenant((trx) =>
      trx
        .selectFrom('app.stripe_payout')
        .select(sql<number>`count(*)::int`.as('n'))
        .executeTakeFirstOrThrow(),
    );
    expect(n.n).toBe(1);
  });
});

describe('T-0075: payouts that do not reconcile are refused, nothing posted', () => {
  it('the payout amount must equal the net of its balance transactions', async () => {
    await expect(
      process({ ...payout, id: 'po_1T0075Mismatch01', amountCents: 135000 }, [charge, payoutTxn]),
    ).rejects.toMatchObject({ name: 'StripePayoutError', code: 'UNBALANCED' });
  });

  it('withheld tax has no approved golden posting yet: refused', async () => {
    const withheld = {
      ...charge,
      id: 'txn_1T0075Withheld1',
      fee: 2400,
      net: 135100,
      fee_details: [
        ...charge.fee_details,
        {
          amount: 32,
          currency: 'aud',
          description: 'Withholding',
          type: 'withheld_tax',
          application: null,
        },
      ],
    };
    await expect(
      process({ ...payout, id: 'po_1T0075Withheld1', amountCents: 135100 }, [
        withheld,
        { ...payoutTxn, amount: -135100, net: -135100 },
      ]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FEE' });
  });

  it('only AUD payouts post here (multi-currency payouts are not in GP-027)', async () => {
    await expect(
      process({ ...payout, id: 'po_1T0075Usd000001', currency: 'usd' }, [
        { ...charge, currency: 'usd' },
        { ...payoutTxn, currency: 'usd' },
      ]),
    ).rejects.toBeInstanceOf(StripePayoutError);
  });
});
