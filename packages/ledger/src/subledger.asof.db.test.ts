/**
 * Open items and allocations as at a date (T-0049, RQ-0122 finding 3): the read API that ageing
 * and statements use. open(asOf) = original − sign(original) × Σ allocations dated ≤ asOf
 * (reversals are negative rows, so they add back); items dated after asOf are excluded. The base
 * sum per role equals subledgerReconciliation(asOf).subledgerBalance. Real PostgreSQL, lf_app.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand, PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import {
  AllocationError,
  allocate,
  allocationsBetween,
  openItemsAsOf,
  reverseAllocation,
  subledgerEntriesOf,
  subledgerReconciliation,
  type OpenItem,
} from './subledger.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const party: Record<string, string> = {};
const inT = <R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R> => f.inTenant(fn);
const P = (name: string) => party[name] ?? `missing ${name}`;
const AR = { role: 'AR_CONTROL' } as const;
const AP = { role: 'AP_CONTROL' } as const;
const SUSPENSE = { role: 'SUSPENSE' } as const;

const cmd = (lines: PostingLineInput[], sourceType: string, entryDate: string): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate,
  lines,
  sourceType,
  sourceId: `${sourceType}-${randomUUID().slice(0, 8)}`,
});

async function postItem(c: PostingCommand): Promise<OpenItem> {
  return inT(async (trx) => {
    const r = await post(trx, c);
    const [item] = await subledgerEntriesOf(trx, r.entryId);
    if (!item) throw new Error('no open item');
    return item;
  });
}

let inv: OpenItem;
let rct: OpenItem;
let usd: OpenItem;
let bill: OpenItem;
let allocationId: string;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004901');
  await inT(async (trx) => {
    for (const st of ['ar_invoice', 'ar_receipt', 'ap_bill']) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code: `je_${st}`, prefix: `${st.toUpperCase()}-` })
        .execute();
    }
    for (const name of ['acme', 'bolt', 'supplier']) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd` })
        .returning('id')
        .executeTakeFirstOrThrow();
      party[name] = p.id;
    }
  });
  inv = await postItem(
    cmd(
      [
        { account: AR, debit: '1000.00', partyId: P('acme'), dueDate: '2026-10-31' },
        { account: SUSPENSE, credit: '1000.00' },
      ],
      'ar_invoice',
      '2026-10-01',
    ),
  );
  rct = await postItem(
    cmd(
      [
        { account: SUSPENSE, debit: '600.00' },
        { account: AR, credit: '600.00', partyId: P('acme') },
      ],
      'ar_receipt',
      '2026-10-15',
    ),
  );
  usd = await postItem(
    cmd(
      [
        {
          account: AR,
          debit: '150.00',
          partyId: P('bolt'),
          txnCurrency: 'USD',
          txnAmount: '100.00',
          fxRate: '1.5',
        },
        { account: SUSPENSE, credit: '150.00' },
      ],
      'ar_invoice',
      '2026-10-25',
    ),
  );
  bill = await postItem(
    cmd(
      [
        { account: SUSPENSE, debit: '70.00' },
        { account: AP, credit: '70.00', partyId: P('supplier') },
      ],
      'ap_bill',
      '2026-10-02',
    ),
  );
  allocationId = (
    await inT((trx) =>
      allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        fromEntryId: rct.id,
        toEntryId: inv.id,
        amount: '600.00',
        allocationDate: '2026-10-20',
      }),
    )
  ).allocationId;
  await inT((trx) =>
    reverseAllocation(trx, {
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      allocationId,
      allocationDate: '2026-11-05',
    }),
  );
}, 120_000);

afterAll(async () => {
  await f?.close();
});

const asOf = (date: string, q: { partyId?: string; openOnly?: boolean } = {}) =>
  inT((trx) =>
    openItemsAsOf(trx, { companyId: f.companyId, controlRole: 'AR_CONTROL', asOf: date, ...q }),
  );
const open = (items: Awaited<ReturnType<typeof asOf>>, id: string) => {
  const i = items.find((x) => x.id === id);
  return i ? [i.openAmountAsOf, i.baseOpenAmountAsOf] : null;
};

describe('openItemsAsOf', () => {
  it('excludes items dated after the date and applies allocations dated on or before it', async () => {
    const d10 = await asOf('2026-10-10');
    expect(d10.map((i) => i.id)).toEqual([inv.id]);
    expect(open(d10, inv.id)).toEqual(['1000.0000', '1000.0000']);

    const d16 = await asOf('2026-10-16');
    expect(open(d16, rct.id)).toEqual(['-600.0000', '-600.0000']);
    expect(open(d16, inv.id)).toEqual(['1000.0000', '1000.0000']);

    const d20 = await asOf('2026-10-20');
    expect(open(d20, inv.id)).toEqual(['400.0000', '400.0000']);
    expect(open(d20, rct.id)).toEqual(['0.0000', '0.0000']);
    expect((await asOf('2026-10-20', { openOnly: true })).map((i) => i.id)).toEqual([inv.id]);
  });

  it('adds a reversal back from its own date; today equals the stored open amounts', async () => {
    const d31 = await asOf('2026-10-31');
    expect(open(d31, inv.id)).toEqual(['400.0000', '400.0000']);
    expect(open(d31, usd.id)).toEqual(['100.0000', '150.0000']);
    const d11 = await asOf('2026-11-05');
    expect(open(d11, inv.id)).toEqual(['1000.0000', '1000.0000']);
    expect(open(d11, rct.id)).toEqual(['-600.0000', '-600.0000']);
    for (const i of d11) {
      expect([i.openAmountAsOf, i.baseOpenAmountAsOf]).toEqual([
        Money.of(i.openAmount, 'XXX').toNumericString(),
        Money.of(i.baseOpenAmount, 'XXX').toNumericString(),
      ]);
      expect(i.asOf).toBe('2026-11-05');
    }
  });

  it('filters by role and party; the base sum equals the reconciliation as at the date', async () => {
    expect((await asOf('2026-11-30', { partyId: P('bolt') })).map((i) => i.id)).toEqual([usd.id]);
    const ap = await inT((trx) =>
      openItemsAsOf(trx, { companyId: f.companyId, controlRole: 'AP_CONTROL', asOf: '2026-11-30' }),
    );
    expect(ap.map((i) => i.id)).toEqual([bill.id]);
    for (const date of ['2026-10-10', '2026-10-16', '2026-10-20', '2026-11-05']) {
      const items = await asOf(date);
      const sum = items.reduce(
        (s, i) => s.add(Money.of(i.baseOpenAmountAsOf, 'XXX')),
        Money.zero('XXX'),
      );
      const rec = await inT((trx) =>
        subledgerReconciliation(trx, { companyId: f.companyId, asOf: date }),
      );
      expect(sum.toNumericString(), date).toBe(
        Money.of(
          rec.find((r) => r.controlRole === 'AR_CONTROL')?.subledgerBalance ?? 'x',
          'XXX',
        ).toNumericString(),
      );
    }
  });

  it('refuses a malformed date', async () => {
    const e = await asOf('2026-02-30').then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AllocationError);
    expect((e as AllocationError).code).toBe('INVALID_COMMAND');
  });
});

describe('allocationsBetween', () => {
  it('lists allocations dated in the range with party and role, reversals as negative rows', async () => {
    const oct = await inT((trx) =>
      allocationsBetween(trx, { companyId: f.companyId, from: '2026-10-01', to: '2026-10-31' }),
    );
    expect(oct.map((a) => [a.allocationId, a.amount, a.allocationDate, a.reversalOfId])).toEqual([
      [allocationId, '600.0000', '2026-10-20', null],
    ]);
    expect(oct[0]).toMatchObject({
      fromEntryId: rct.id,
      toEntryId: inv.id,
      partyId: P('acme'),
      controlRole: 'AR_CONTROL',
      currency: 'AUD',
    });
    const all = await inT((trx) =>
      allocationsBetween(trx, {
        companyId: f.companyId,
        to: '2026-11-30',
        controlRole: 'AR_CONTROL',
        partyId: P('acme'),
      }),
    );
    expect(all.map((a) => a.amount)).toEqual(['600.0000', '-600.0000']);
    expect(all[1]?.reversalOfId).toBe(allocationId);
    const bolt = await inT((trx) =>
      allocationsBetween(trx, { companyId: f.companyId, to: '2026-11-30', partyId: P('bolt') }),
    );
    expect(bolt).toEqual([]);
  });
});
