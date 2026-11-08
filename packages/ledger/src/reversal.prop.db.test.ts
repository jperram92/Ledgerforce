/**
 * INV-reversal through the reversal path (T-0032, GP-019), against a real PostgreSQL as lf_app.
 * Default fast-check numRuns; amounts are bigint ten-thousandths formatted as decimal strings
 * (never floats).
 *
 * For any posted entry — a manual journal over random accounts, dimensions and USD lines, or an
 * AR invoice whose debit is on AR_CONTROL for a party — reverse() nets every account balance back
 * to its value before the entry, account_balance has no drift, the trial balance nets to zero,
 * the AR subledger still equals the AR control account and the original is status reversed.
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountBalanceDrift, trialBalance } from './account-balance.ts';
import type { PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { reverse } from './reversal.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const dims: string[] = [];
let party = '';
/** Postable, non-control, unrestricted accounts of the AU services chart. */
const CODES = ['1010', '1020', '1100', '4110', '4120', '5000', '6110', '6200', '6310', '2900'];

const fmt = (u: bigint): string => {
  const s = u < 0n ? '-' : '';
  const a = u < 0n ? -u : u;
  return `${s}${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
const units = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i = '0', d = ''] = (neg ? s.slice(1) : s).split('.');
  const u = BigInt(i) * 10_000n + BigInt(d.padEnd(4, '0').slice(0, 4));
  return neg ? -u : u;
};

interface Gen {
  side: 'debit' | 'credit';
  u: bigint;
  code: string;
  dim: number;
  usd: boolean;
}

const entry = fc
  .record({
    debits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 4 }),
    credits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 10n }), { minLength: 1, maxLength: 4 }),
    codes: fc.array(fc.constantFrom(...CODES), { minLength: 9, maxLength: 9 }),
    dims: fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 9, maxLength: 9 }),
    usd: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
    day: fc.integer({ min: 1, max: 28 }),
    month: fc.constantFrom('2026-07', '2026-10', '2027-01', '2027-06'),
    ar: fc.boolean(),
  })
  .map(({ debits, credits, codes, dims: ds, usd, day, month, ar }) => {
    const d = debits.reduce((a, b) => a + b, 0n);
    const c = credits.reduce((a, b) => a + b, 0n);
    const sides: [Gen['side'], bigint][] = [
      ...debits.map((u): [Gen['side'], bigint] => ['debit', u]),
      ...credits.map((u): [Gen['side'], bigint] => ['credit', u]),
      ...(d > c
        ? [['credit', d - c] as [Gen['side'], bigint]]
        : c > d
          ? [['debit', c - d] as [Gen['side'], bigint]]
          : []),
    ];
    return {
      ar,
      entryDate: `${month}-${String(day).padStart(2, '0')}`,
      lines: sides.map(([side, u], i): Gen => ({
        side,
        u,
        code: codes[i] ?? '1010',
        dim: ds[i] ?? -1,
        usd: usd[i] ?? false,
      })),
    };
  });

const toInput = (g: Gen, i: number, ar: boolean): PostingLineInput => {
  // An AR invoice: its first line (always a debit) goes to AR_CONTROL for the party.
  if (ar && i === 0) {
    return { account: { role: 'AR_CONTROL' }, debit: fmt(g.u), partyId: party };
  }
  const dim = dims[g.dim];
  return {
    account: { id: f.acct[g.code] ?? '' },
    [g.side]: fmt(g.u),
    ...(dim === undefined ? {} : { dimensions: [dim] }),
    ...(g.usd ? { txnCurrency: 'USD', txnAmount: fmt(g.u * 2n), fxRate: '0.5' } : {}),
  };
};

/** Net (debit − credit, in units) per account code, from account_balance. */
async function netByCode(): Promise<Map<string, bigint>> {
  const tb = await f.inTenant((trx) => trialBalance(trx, f.companyId));
  return new Map(tb.map((r) => [r.code, units(r.debit) - units(r.credit)]));
}

/** Σ open AR items (base) and the AR control account's net balance, in units. */
async function arSubledgerVsControl(): Promise<[bigint, bigint]> {
  return f.inTenant(async (trx) => {
    const items = await sql<{ s: string }>`
      SELECT coalesce(sum(base_open_amount), 0)::text AS s FROM app.subledger_entry
       WHERE company_id = ${f.companyId} AND control_role = 'AR_CONTROL'`.execute(trx);
    const control = await sql<{ s: string }>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS s
        FROM app.journal_line l
        JOIN app.account_system_role r ON r.account_id = l.account_id AND r.role = 'AR_CONTROL'
       WHERE l.company_id = ${f.companyId}`.execute(trx);
    return [units(items.rows[0]?.s ?? '0'), units(control.rows[0]?.s ?? '0')];
  });
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003202');
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of [
      ['je_manual_journal', 'MJ-'],
      ['je_ar_invoice', 'INV-'],
      ['je_ledger_reversal', 'REV-'],
    ] as const) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix })
        .execute();
    }
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    party = p.id;
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: f.companyId, code: 'department', name: 'department' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const v of ['SALES', 'OPS']) {
      const r = await trx
        .insertInto('app.dimension_value')
        .values({ company_id: f.companyId, dimension_id: d.id, code: v, name: v })
        .returning('id')
        .executeTakeFirstOrThrow();
      dims.push(r.id);
    }
  });
});

afterAll(async () => {
  await f.close();
});

describe('INV-reversal through reverse() [T-0032]', () => {
  it('SS-UC10-09 INV-reversal: reversing any posted entry nets every account balance to its prior value [T-0032]', async () => {
    await fc.assert(
      fc.asyncProperty(entry, async ({ ar, entryDate, lines }) => {
        const before = await netByCode();
        const original = await f.inTenant((trx) =>
          post(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            entryDate,
            sourceType: ar ? 'ar_invoice' : 'manual_journal',
            lines: lines.map((g, i) => toInput(g, i, ar)),
          }),
        );
        const r = await f.inTenant((trx) =>
          reverse(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            entryId: original.entryId,
            entryDate,
          }),
        );
        expect(r.reversalOfId).toBe(original.entryId);
        const after = await netByCode();
        for (const c of new Set([...before.keys(), ...after.keys()])) {
          expect(fmt(after.get(c) ?? 0n), c).toBe(fmt(before.get(c) ?? 0n));
        }
        await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual(
          [],
        );
        const total = [...after.values()].reduce((a, b) => a + b, 0n);
        expect(fmt(total)).toBe('0.0000');
        const [sub, control] = await arSubledgerVsControl();
        expect(fmt(sub)).toBe(fmt(control));
        const st = await f.admin.query<{ status: string }>(
          'SELECT status FROM app.journal_entry WHERE id = $1',
          [original.entryId],
        );
        expect(st.rows[0]?.status).toBe('reversed');
      }),
    );
  });
});
