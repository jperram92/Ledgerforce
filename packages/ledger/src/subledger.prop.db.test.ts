/**
 * Subledger invariants over random postings and allocations through the engine (T-0028,
 * SS-PLAT-81, SS-PLAT-82), against a real PostgreSQL as lf_app. Default fast-check numRuns;
 * amounts are bigint ten-thousandths formatted as decimal strings (never floats).
 *
 * INV-ar-control   Σ AR open items (base) = AR control balance + unposted FX difference
 * INV-ap-control   the same for AP (subledgerReconciliation reconciled; subledgerDrift empty)
 * INV-allocation   an allocation succeeds exactly when the model says it may (same account and
 *                  currency, opposite sides, amount ≤ both open amounts); open amounts never
 *                  exceed the original nor cross zero; a reversal restores both items.
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import {
  AllocationError,
  allocate,
  openItems,
  reverseAllocation,
  subledgerDrift,
  subledgerEntriesOf,
  subledgerReconciliation,
} from './subledger.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const SERIES = ['ar_invoice', 'ar_receipt', 'ap_bill', 'ap_payment'];

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
const abs = (u: bigint) => (u < 0n ? -u : u);

type Kind = 'ar_invoice' | 'ar_receipt' | 'ap_bill' | 'ap_payment';
const KINDS: Kind[] = ['ar_invoice', 'ar_receipt', 'ap_bill', 'ap_payment'];
const ROLE: Record<Kind, 'AR_CONTROL' | 'AP_CONTROL'> = {
  ar_invoice: 'AR_CONTROL',
  ar_receipt: 'AR_CONTROL',
  ap_bill: 'AP_CONTROL',
  ap_payment: 'AP_CONTROL',
};
/** Is the control line a debit? */
const DEBIT: Record<Kind, boolean> = {
  ar_invoice: true,
  ar_receipt: false,
  ap_bill: false,
  ap_payment: true,
};

const op = fc.oneof(
  fc.record({
    t: fc.constant('post' as const),
    kind: fc.constantFrom(...KINDS),
    usd: fc.boolean(),
    txn: fc.bigInt({ min: 1n, max: 10n ** 8n }),
    base: fc.bigInt({ min: 1n, max: 10n ** 8n }),
  }),
  fc.record({
    t: fc.constant('alloc' as const),
    i: fc.nat(),
    j: fc.nat(),
    // fraction of the smaller open amount, in percent; > 100 tries to over-allocate
    pct: fc.integer({ min: 1, max: 130 }),
  }),
  fc.record({ t: fc.constant('reverse' as const), k: fc.nat() }),
);

interface ModelItem {
  id: string;
  role: string;
  currency: string;
  original: bigint;
  open: bigint;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002802');
  await f.inTenant(async (trx) => {
    for (const st of SERIES) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code: `je_${st}`, prefix: `${st}-` })
        .execute();
    }
  });
}, 120_000);

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-81/82 subledger invariants [T-0028]', () => {
  it('SS-PLAT-82 INV-ar-control INV-ap-control INV-allocation: random postings and allocations keep the subledgers equal to the controls and never over-allocate', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        const partyId = await f.inTenant(async (trx) => {
          const p = await trx
            .insertInto('app.party')
            .values({ company_id: f.companyId, legal_name: `P ${randomUUID().slice(0, 8)}` })
            .returning('id')
            .executeTakeFirstOrThrow();
          return p.id;
        });
        const items: ModelItem[] = [];
        const done: { id: string; from: ModelItem; to: ModelItem; u: bigint }[] = [];
        const reversed = new Set<string>();
        for (const o of ops) {
          if (o.t === 'post') {
            const amount = fmt(o.usd ? o.base : o.txn);
            const control: PostingLineInput = {
              account: { role: ROLE[o.kind] },
              ...(DEBIT[o.kind] ? { debit: amount } : { credit: amount }),
              partyId,
              ...(o.usd ? { txnCurrency: 'USD', txnAmount: fmt(o.txn), fxRate: '1.5' } : {}),
            };
            const other: PostingLineInput = {
              account: { role: 'SUSPENSE' },
              ...(DEBIT[o.kind] ? { credit: amount } : { debit: amount }),
            };
            const item = await f.inTenant(async (trx) => {
              const r = await post(trx, {
                companyId: f.companyId,
                idempotencyKey: randomUUID(),
                entryDate: '2026-10-10',
                sourceType: o.kind,
                lines: [control, other],
              });
              return (await subledgerEntriesOf(trx, r.entryId))[0];
            });
            if (!item) throw new Error('no open item');
            const sign = DEBIT[o.kind] ? 1n : -1n;
            expect(units(item.originalAmount)).toBe(sign * o.txn);
            expect(units(item.baseOriginalAmount)).toBe(sign * (o.usd ? o.base : o.txn));
            items.push({
              id: item.id,
              role: ROLE[o.kind],
              currency: o.usd ? 'USD' : 'AUD',
              original: sign * o.txn,
              open: sign * o.txn,
            });
          } else if (o.t === 'alloc') {
            if (items.length < 2) continue;
            const a = items[o.i % items.length] as ModelItem;
            const b = items[o.j % items.length] as ModelItem;
            if (a === b) continue;
            const smaller = abs(a.open) < abs(b.open) ? abs(a.open) : abs(b.open);
            const u = (smaller * BigInt(o.pct)) / 100n; // ten-thousandths (bigint)
            if (u <= 0n) continue;
            const may =
              a.role === b.role &&
              a.currency === b.currency &&
              a.original > 0n !== b.original > 0n &&
              u <= smaller;
            const r = await f
              .inTenant((trx) =>
                allocate(trx, {
                  companyId: f.companyId,
                  idempotencyKey: randomUUID(),
                  fromEntryId: a.id,
                  toEntryId: b.id,
                  amount: fmt(u),
                  allocationDate: '2026-10-20',
                }),
              )
              .then(
                (x) => x,
                (e: unknown) => {
                  if (!(e instanceof AllocationError)) throw e;
                  return e;
                },
              );
            expect(r instanceof AllocationError, `allocation allowed = ${String(may)}`).toBe(!may);
            if (!(r instanceof AllocationError)) {
              a.open -= (a.original > 0n ? 1n : -1n) * u;
              b.open -= (b.original > 0n ? 1n : -1n) * u;
              done.push({ id: r.allocationId, from: a, to: b, u });
            }
          } else {
            const live = done.filter((d) => !reversed.has(d.id));
            const d = live[o.k % Math.max(live.length, 1)];
            if (!d) continue;
            await f.inTenant((trx) =>
              reverseAllocation(trx, {
                companyId: f.companyId,
                idempotencyKey: randomUUID(),
                allocationId: d.id,
                allocationDate: '2026-10-21',
              }),
            );
            reversed.add(d.id);
            d.from.open += (d.from.original > 0n ? 1n : -1n) * d.u;
            d.to.open += (d.to.original > 0n ? 1n : -1n) * d.u;
          }
        }
        const [rec, drift, stored] = await f.inTenant(async (trx) => [
          await subledgerReconciliation(trx, { companyId: f.companyId }),
          await subledgerDrift(trx, f.companyId),
          await openItems(trx, { companyId: f.companyId, partyId }),
        ]);
        for (const r of rec) expect(r, r.controlRole).toMatchObject({ reconciled: true });
        expect(drift).toEqual([]);
        const byId = new Map(stored.map((s) => [s.id, s]));
        for (const m of items) {
          const s = byId.get(m.id);
          expect(units(s?.openAmount ?? 'x'), m.id).toBe(m.open);
          const orig = units(s?.baseOriginalAmount ?? '0');
          const open = units(s?.baseOpenAmount ?? '0');
          expect(abs(open) <= abs(orig) && (open === 0n || open > 0n === orig > 0n)).toBe(true);
          expect(abs(m.open) <= abs(m.original)).toBe(true);
        }
      }),
    );
  }, 600_000);
});
