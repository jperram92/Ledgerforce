/**
 * Accounting invariant suite over random documents (T-0033, SS-PLAT-11; design §10.8 gate 3,
 * §9.1 MVP exit), against a real PostgreSQL as lf_app, through the engine API only (post,
 * reverse, allocate, reverseAllocation). Model-based: every run is a fixed-length sequence of
 * random documents — manual journals and AR invoice / credit note / receipt, AP bill / payment
 * shaped raw commands — each followed by a random action (nothing, an allocation, a reversal of an
 * earlier document, a reversal of an earlier allocation, or a command the engine must refuse).
 * A pure model tracks the expected net balance of every account and the open amount of every
 * open item, and predicts which allocations and reversals the engine accepts.
 *
 * Asserted per action:   INV-reversal (the reversal moves the trial balance back by exactly the
 *                        original's lines), refused commands write nothing.
 * Asserted per run:      INV-balance (every stored entry balances), INV-tb-zero (trial balance
 *                        nets to zero, and equals the model), INV-account-balance (account_balance
 *                        = Σ journal lines, no drift), INV-ar-control / INV-ap-control (each
 *                        subledger reconciles to its control account; no subledger drift; open
 *                        amounts equal the model), INV-immutable (every entry seen in an earlier
 *                        run is byte-for-byte unchanged except posted → reversed by reverse(); a
 *                        direct UPDATE/DELETE is refused even for a superuser), INV-hash-chain.
 *
 * Size (DL-0300): fast-check's default numRuns (100) is never lowered; the number of documents
 * per run is ceil(LF_INVARIANT_DOCS / 100). `pnpm test:db` uses the default below;
 * `pnpm test:invariants` runs the full 10,000 documents and is recorded as evidence. The seed is
 * logged and can be replayed with LF_INVARIANT_SEED. Amounts are bigint ten-thousandths
 * formatted as decimal strings (never floats).
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountBalanceDrift, trialBalance } from './account-balance.ts';
import { verifyChain } from './hash-chain.ts';
import { PeriodLockedError } from './period.ts';
import { PostingError, type PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { reverse } from './reversal.ts';
import {
  AllocationError,
  allocate,
  openItems,
  reverseAllocation,
  subledgerDrift,
  subledgerReconciliation,
} from './subledger.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

/** fast-check's default numRuns; the suite never passes a lower one. */
const RUNS = 100;
/** Documents for `pnpm test:db`; `pnpm test:invariants` sets 10,000 (DL-0300). */
const DEFAULT_DOCS = 1_000;
const TARGET_DOCS = Number.parseInt(process.env.LF_INVARIANT_DOCS ?? String(DEFAULT_DOCS), 10);
const DOCS_PER_RUN = Math.ceil(TARGET_DOCS / RUNS);
const SEED = Number.parseInt(
  process.env.LF_INVARIANT_SEED ?? String(Date.now() % 2_147_483_647),
  10,
);

let f: LedgerFixture;
const parties: string[] = [];
const dims: string[] = [];
const role: Record<string, string> = {};

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
const maxDate = (a: string, b: string) => (a > b ? a : b);

type Kind =
  'manual_journal' | 'ar_invoice' | 'ar_credit_note' | 'ar_receipt' | 'ap_bill' | 'ap_payment';
const KINDS: Kind[] = [
  'manual_journal',
  'ar_invoice',
  'ar_credit_note',
  'ar_receipt',
  'ap_bill',
  'ap_payment',
];
type ControlRole = 'AR_CONTROL' | 'AP_CONTROL';
/** Subledger kinds: the control role, whether the control line is a debit, the other accounts. */
const SHAPE: Record<
  Exclude<Kind, 'manual_journal'>,
  { role: ControlRole; debit: boolean; others: string[] }
> = {
  ar_invoice: { role: 'AR_CONTROL', debit: true, others: ['4110', '4120'] },
  ar_credit_note: { role: 'AR_CONTROL', debit: false, others: ['4110', '4120'] },
  ar_receipt: { role: 'AR_CONTROL', debit: false, others: ['1010', '1020'] },
  ap_bill: { role: 'AP_CONTROL', debit: false, others: ['5000', '6110', '6200', '6310'] },
  ap_payment: { role: 'AP_CONTROL', debit: true, others: ['1010', '1020'] },
};
/** Postable, non-control, unrestricted accounts of the AU services chart (manual journals). */
const CODES = ['1010', '1020', '1100', '4110', '4120', '5000', '6110', '6200', '6310', '2900'];
/** USD rates as base/txn fractions, so base = txn × rate is exact in ten-thousandths. */
const RATES = [
  { rate: '0.5', num: 1n, den: 2n },
  { rate: '0.8', num: 4n, den: 5n },
  { rate: '1.25', num: 5n, den: 4n },
];
const MONTHS = ['2026-07', '2026-09', '2026-12', '2027-03', '2027-06'];

const docArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  debits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 3 }),
  credits: fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 3 }),
  codes: fc.array(fc.nat(), { minLength: 7, maxLength: 7 }),
  dims: fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 7, maxLength: 7 }),
  party: fc.nat({ max: 1 }),
  usd: fc.integer({ min: 0, max: 3 }).map((x) => x === 0),
  rate: fc.nat({ max: RATES.length - 1 }),
  month: fc.constantFrom(...MONTHS),
  day: fc.integer({ min: 1, max: 28 }),
});
type DocGen = typeof docArb extends fc.Arbitrary<infer T> ? T : never;

const actionArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('none' as const) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant('alloc' as const),
      i: fc.nat(),
      j: fc.nat(),
      // mostly pick the counter-item among the opposite-side items of the same role, party and
      // currency (so allocations happen); otherwise any item (so refusals are exercised too)
      match: fc.integer({ min: 0, max: 3 }).map((x) => x > 0),
      // percent of the smaller open amount; > 100 tries to over-allocate
      pct: fc.integer({ min: 1, max: 130 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('reverse' as const), k: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('unalloc' as const), k: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('refused' as const),
      why: fc.constantFrom('unbalanced', 'control_in_journal', 'outside_periods'),
      u: fc.bigInt({ min: 1n, max: 10n ** 9n }),
    }),
  },
);
type Action = typeof actionArb extends fc.Arbitrary<infer T> ? T : never;

interface ModelItem {
  id: string;
  entryId: string;
  role: ControlRole;
  party: string;
  currency: string;
  date: string;
  original: bigint;
  open: bigint;
}
interface ModelDoc {
  entryId: string;
  date: string;
  /** Net base (debit − credit) per account id. */
  net: Map<string, bigint>;
  item: ModelItem | undefined;
  reversed: boolean;
}
interface ModelAlloc {
  id: string;
  date: string;
  from: ModelItem;
  to: ModelItem;
  u: bigint;
  reversed: boolean;
}

/** A generated document as a raw posting command, and its expected net per account id. */
function buildDoc(g: DocGen): {
  kind: Kind;
  date: string;
  lines: PostingLineInput[];
  net: Map<string, bigint>;
  control?: { role: ControlRole; party: string; currency: string; txn: bigint };
} {
  const date = `${g.month}-${String(g.day).padStart(2, '0')}`;
  const net = new Map<string, bigint>();
  const add = (id: string, u: bigint) => net.set(id, (net.get(id) ?? 0n) + u);
  const dim = (i: number) => {
    const d = dims[g.dims[i] ?? -1];
    return d === undefined ? {} : { dimensions: [d] };
  };
  if (g.kind === 'manual_journal') {
    const d = g.debits.reduce((a, b) => a + b, 0n);
    const c = g.credits.reduce((a, b) => a + b, 0n);
    const sides: ['debit' | 'credit', bigint][] = [
      ...g.debits.map((u): ['debit', bigint] => ['debit', u]),
      ...g.credits.map((u): ['credit', bigint] => ['credit', u]),
      ...(d > c
        ? [['credit', d - c] as ['credit', bigint]]
        : c > d
          ? [['debit', c - d] as ['debit', bigint]]
          : []),
    ];
    const lines = sides.map(([side, u], i): PostingLineInput => {
      const id = f.acct[CODES[(g.codes[i] ?? 0) % CODES.length] ?? '1010'] ?? '';
      add(id, side === 'debit' ? u : -u);
      return {
        account: { id },
        [side]: fmt(u),
        ...dim(i),
        // a USD line carries its transaction amount at rate 0.5; the base is what posts
        ...(g.usd && i === 0 ? { txnCurrency: 'USD', txnAmount: fmt(u * 2n), fxRate: '0.5' } : {}),
      };
    });
    return { kind: g.kind, date, lines, net };
  }
  const shape = SHAPE[g.kind];
  const r = g.usd ? (RATES[g.rate] ?? RATES[0]) : undefined;
  // Each other line has base a × num; the control line carries txn Σa × den in USD.
  const amounts = g.debits;
  const base = amounts.map((a) => (r ? a * r.num : a));
  const sumU = base.reduce((a, b) => a + b, 0n);
  const txn = r ? amounts.reduce((a, b) => a + b, 0n) * r.den : sumU;
  const party = parties[g.party] ?? '';
  const controlId = role[shape.role] ?? '';
  add(controlId, shape.debit ? sumU : -sumU);
  const lines: PostingLineInput[] = [
    {
      account: { role: shape.role },
      ...(shape.debit ? { debit: fmt(sumU) } : { credit: fmt(sumU) }),
      partyId: party,
      ...(r ? { txnCurrency: 'USD', txnAmount: fmt(txn), fxRate: r.rate } : {}),
    },
    ...base.map((u, i): PostingLineInput => {
      const id = f.acct[shape.others[(g.codes[i] ?? 0) % shape.others.length] ?? '1010'] ?? '';
      add(id, shape.debit ? -u : u);
      return {
        account: { id },
        ...(shape.debit ? { credit: fmt(u) } : { debit: fmt(u) }),
        ...dim(i),
      };
    }),
  ];
  return {
    kind: g.kind,
    date,
    lines,
    net,
    control: {
      role: shape.role,
      party,
      currency: r ? 'USD' : 'AUD',
      txn: shape.debit ? txn : -txn,
    },
  };
}

/** Net (debit − credit) per account id, from account_balance via the trial balance. */
async function netById(): Promise<Map<string, bigint>> {
  const tb = await f.inTenant((trx) => trialBalance(trx, f.companyId));
  return new Map(tb.map((r) => [r.accountId, units(r.debit) - units(r.credit)]));
}

/** Every stored entry of the company, with its lines rendered as text, for the mutation check. */
async function snapshot(): Promise<Map<string, { status: string; row: string }>> {
  const r = await f.admin.query<{ id: string; status: string; row: string }>(
    `SELECT e.id::text, e.status::text,
            concat_ws('#', e.entry_no, e.entry_date::text, e.period_id::text, e.source_type,
              e.source_id, e.reversal_of_id::text, e.idempotency_key, e.memo, e.chain_seq::text,
              e.prev_hash, e.hash, e.posted_at::text,
              (SELECT string_agg(concat_ws(':', l.line_no, l.account_id, l.debit, l.credit,
                        l.txn_currency, l.txn_amount, l.fx_rate, l.tax_code_id, l.tax_amount,
                        l.dimension_set_id, l.party_id, l.memo), '|' ORDER BY l.line_no)
                 FROM app.journal_line l WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id)
            ) AS row
       FROM app.journal_entry e WHERE e.company_id = $1`,
    [f.companyId],
  );
  return new Map(r.rows.map((x) => [x.id, { status: x.status, row: x.row }]));
}

/** Entries seen at the end of earlier runs; ids reversed through reverse(). */
const seen = new Map<string, { status: string; row: string }>();
const reversedIds = new Set<string>();
const totals = {
  runs: 0,
  docs: 0,
  reversals: 0,
  reversalsRefused: 0,
  allocations: 0,
  allocationsRefused: 0,
  unallocations: 0,
  refused: 0,
};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003301');
  await f.inTenant(async (trx) => {
    for (const k of [...KINDS, 'ledger_reversal']) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code: `je_${k}`, prefix: `${k}-` })
        .execute();
    }
    for (const name of ['Acme Pty Ltd', 'Birch Supplies Pty Ltd', 'Cobalt Services Pty Ltd']) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: name })
        .returning('id')
        .executeTakeFirstOrThrow();
      parties.push(p.id);
    }
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
    const roles = await sql<{ role: string; account_id: string }>`
      SELECT role, account_id::text FROM app.account_system_role
       WHERE company_id = ${f.companyId} AND role IN ('AR_CONTROL', 'AP_CONTROL')`.execute(trx);
    for (const x of roles.rows) role[x.role] = x.account_id;
  });
  console.info(
    `[T-0033] invariant suite: seed=${String(SEED)} documents=${String(TARGET_DOCS)} ` +
      `runs=${String(RUNS)} documentsPerRun=${String(DOCS_PER_RUN)}`,
  );
}, 120_000);

let startedAt = 0;

afterAll(async () => {
  const report = {
    test: 'SS-PLAT-11',
    seed: SEED,
    targetDocuments: TARGET_DOCS,
    numRuns: RUNS,
    documentsPerRun: DOCS_PER_RUN,
    ...totals,
    passed: totals.runs === RUNS && totals.docs >= TARGET_DOCS,
    durationMs: Date.now() - startedAt,
  };
  console.info(`[T-0033] ${JSON.stringify(report)}`);
  // `pnpm test:invariants` records this as evidence (LF_INVARIANT_REPORT = a JSON path).
  const out = process.env.LF_INVARIANT_REPORT;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  await f.close();
});

async function runSequence(steps: { doc: DocGen; action: Action }[]): Promise<void> {
  const start = await netById();
  const docs: ModelDoc[] = [];
  const items: ModelItem[] = [];
  const allocs: ModelAlloc[] = [];
  const count = {
    docs: 0,
    reversals: 0,
    reversalsRefused: 0,
    allocations: 0,
    allocationsRefused: 0,
    unallocations: 0,
    refused: 0,
  };

  for (const { doc, action } of steps) {
    // 1. the document
    const b = buildDoc(doc);
    const r = await f.inTenant((trx) =>
      post(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        entryDate: b.date,
        sourceType: b.kind,
        lines: b.lines,
      }),
    );
    count.docs += 1;
    let item: ModelItem | undefined;
    if (b.control) {
      const stored = await f.inTenant((trx) =>
        openItems(trx, { companyId: f.companyId, partyId: b.control?.party ?? '' }),
      );
      const s = stored.find((x) => x.entryId === r.entryId);
      if (!s) throw new Error(`no open item for ${r.entryId}`);
      expect(units(s.originalAmount)).toBe(b.control.txn);
      item = {
        id: s.id,
        entryId: r.entryId,
        role: b.control.role,
        party: b.control.party,
        currency: b.control.currency,
        date: b.date,
        original: b.control.txn,
        open: b.control.txn,
      };
      items.push(item);
    }
    docs.push({ entryId: r.entryId, date: b.date, net: b.net, item, reversed: false });

    // 2. the action
    if (action.t === 'alloc') {
      const a = items[action.i % Math.max(items.length, 1)];
      const pool = action.match
        ? items.filter(
            (x) =>
              a !== undefined &&
              x.role === a.role &&
              x.party === a.party &&
              x.currency === a.currency &&
              x.original > 0n !== a.original > 0n,
          )
        : items;
      const c = pool[action.j % Math.max(pool.length, 1)];
      if (!a || !c || a === c) continue;
      const smaller = abs(a.open) < abs(c.open) ? abs(a.open) : abs(c.open);
      const u = (smaller * BigInt(action.pct)) / 100n;
      if (u <= 0n) continue;
      const may =
        a.role === c.role &&
        a.party === c.party &&
        a.currency === c.currency &&
        a.original > 0n !== c.original > 0n &&
        u <= smaller;
      const date = maxDate(a.date, c.date);
      const res = await f
        .inTenant((trx) =>
          allocate(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            fromEntryId: a.id,
            toEntryId: c.id,
            amount: fmt(u),
            allocationDate: date,
          }),
        )
        .then(
          (x) => x,
          (e: unknown) => {
            if (!(e instanceof AllocationError)) throw e;
            return e;
          },
        );
      expect(res instanceof AllocationError, `allocation allowed = ${String(may)}`).toBe(!may);
      if (!(res instanceof AllocationError)) {
        a.open -= (a.original > 0n ? 1n : -1n) * u;
        c.open -= (c.original > 0n ? 1n : -1n) * u;
        allocs.push({ id: res.allocationId, date, from: a, to: c, u, reversed: false });
        count.allocations += 1;
      } else {
        count.allocationsRefused += 1;
      }
    } else if (action.t === 'unalloc') {
      const live = allocs.filter((x) => !x.reversed);
      const x = live[action.k % Math.max(live.length, 1)];
      if (!x) continue;
      await f.inTenant((trx) =>
        reverseAllocation(trx, {
          companyId: f.companyId,
          idempotencyKey: randomUUID(),
          allocationId: x.id,
          allocationDate: x.date,
        }),
      );
      x.reversed = true;
      x.from.open += (x.from.original > 0n ? 1n : -1n) * x.u;
      x.to.open += (x.to.original > 0n ? 1n : -1n) * x.u;
      count.unallocations += 1;
    } else if (action.t === 'reverse') {
      const live = docs.filter((d) => !d.reversed);
      const d = live[action.k % Math.max(live.length, 1)];
      if (!d) continue;
      // Void rule (RQ-0095 Q11): only while every open item of the original is fully open.
      const may = d.item === undefined || d.item.open === d.item.original;
      const before = await netById();
      const res = await f
        .inTenant((trx) =>
          reverse(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            entryId: d.entryId,
            entryDate: d.date,
          }),
        )
        .then(
          (x) => x,
          (e: unknown) => {
            if (!(e instanceof PostingError)) throw e;
            return e;
          },
        );
      if (!may) {
        expect(res instanceof PostingError ? res.code : 'reversed').toBe('VOID_HAS_ALLOCATIONS');
        expect(await netById()).toEqual(before);
        count.reversalsRefused += 1;
        continue;
      }
      if (res instanceof PostingError) throw res;
      expect(res.reversalOfId).toBe(d.entryId);
      // INV-reversal: the trial balance moves back by exactly the original's lines.
      const after = await netById();
      for (const id of new Set([...before.keys(), ...after.keys(), ...d.net.keys()])) {
        expect(fmt(after.get(id) ?? 0n), id).toBe(
          fmt((before.get(id) ?? 0n) - (d.net.get(id) ?? 0n)),
        );
      }
      d.reversed = true;
      reversedIds.add(d.entryId);
      if (d.item) d.item.open = 0n;
      count.reversals += 1;
    } else if (action.t === 'refused') {
      const entries = await f.countEntries();
      const u = fmt(action.u);
      const lines: PostingLineInput[] =
        action.why === 'unbalanced'
          ? [
              { account: { id: f.acct['1010'] ?? '' }, debit: u },
              { account: { id: f.acct['4110'] ?? '' }, credit: fmt(action.u + 1n) },
            ]
          : [
              action.why === 'control_in_journal'
                ? { account: { role: 'AR_CONTROL' }, debit: u, partyId: parties[0] ?? '' }
                : { account: { id: f.acct['1010'] ?? '' }, debit: u },
              { account: { id: f.acct['4110'] ?? '' }, credit: u },
            ];
      const err = await f
        .inTenant((trx) =>
          post(trx, {
            companyId: f.companyId,
            idempotencyKey: randomUUID(),
            // outside FY2027: no period exists for the date
            entryDate: action.why === 'outside_periods' ? '2031-01-15' : '2026-10-15',
            sourceType: 'manual_journal',
            lines,
          }),
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err, action.why).toBeInstanceOf(
        action.why === 'outside_periods' ? PeriodLockedError : PostingError,
      );
      expect((err as { code?: string }).code, action.why).toBe(
        {
          unbalanced: 'UNBALANCED',
          control_in_journal: 'CONTROL_ACCOUNT',
          outside_periods: 'NO_PERIOD',
        }[action.why],
      );
      expect(await f.countEntries()).toBe(entries);
      count.refused += 1;
    }
  }

  // ---- per-run invariants ----
  // INV-tb-zero and the model: TB = start + Σ lines of the run's unreversed documents.
  const end = await netById();
  const expected = new Map(start);
  for (const d of docs) {
    if (d.reversed) continue;
    for (const [id, u] of d.net) expected.set(id, (expected.get(id) ?? 0n) + u);
  }
  for (const id of new Set([...end.keys(), ...expected.keys()])) {
    expect(fmt(end.get(id) ?? 0n), id).toBe(fmt(expected.get(id) ?? 0n));
  }
  expect(fmt([...end.values()].reduce((a, b) => a + b, 0n))).toBe('0.0000');

  const [unbalanced, drift, rec, sdrift, chain, stored] = await f.inTenant(async (trx) => [
    // INV-balance: every stored entry balances in base currency.
    await sql<{ entry_id: string }>`
      SELECT entry_id::text FROM app.journal_line WHERE company_id = ${f.companyId}
       GROUP BY entry_id HAVING sum(debit) <> sum(credit)`.execute(trx),
    await accountBalanceDrift(trx, f.companyId),
    await subledgerReconciliation(trx, { companyId: f.companyId }),
    await subledgerDrift(trx, f.companyId),
    await verifyChain(trx, f.companyId),
    await openItems(trx, { companyId: f.companyId }),
  ]);
  expect(unbalanced.rows).toEqual([]);
  expect(drift).toEqual([]);
  expect(rec.map((x) => x.controlRole).sort()).toEqual(['AP_CONTROL', 'AR_CONTROL']);
  for (const x of rec) expect(x, x.controlRole).toMatchObject({ reconciled: true });
  expect(sdrift).toEqual([]);
  expect(chain).toMatchObject({ ok: true });

  const byId = new Map(stored.map((s) => [s.id, s]));
  for (const m of items) {
    const s = byId.get(m.id);
    expect(units(s?.openAmount ?? '0'), m.id).toBe(m.open);
    expect(abs(m.open) <= abs(m.original)).toBe(true);
  }

  // INV-immutable: entries of earlier runs are unchanged but for posted → reversed by reverse().
  const now = await snapshot();
  for (const [id, was] of seen) {
    const is = now.get(id);
    expect(is?.row, id).toBe(was.row);
    if (is?.status !== was.status) {
      expect([was.status, is?.status, reversedIds.has(id)], id).toEqual([
        'posted',
        'reversed',
        true,
      ]);
    }
  }
  for (const [id, v] of now) seen.set(id, v);
  // and a direct change is refused by the database, even for a superuser.
  const victim = docs[0]?.entryId ?? '';
  await expect(
    f.admin.query('UPDATE app.journal_line SET memo = $2 WHERE entry_id = $1', [victim, 'edited']),
  ).rejects.toThrow(/immutable/);
  await expect(
    f.admin.query('DELETE FROM app.journal_entry WHERE id = $1', [victim]),
  ).rejects.toThrow(/immutable/);

  totals.runs += 1;
  for (const k of Object.keys(count) as (keyof typeof count)[]) totals[k] += count[k];
}

describe('SS-PLAT-11 accounting invariants over random documents [T-0033]', () => {
  it(
    `SS-PLAT-11: Invariants hold over 10,000 random documents (INV-balance INV-tb-zero INV-ar-control INV-ap-control INV-reversal; this run: ${String(TARGET_DOCS)} documents)`,
    async () => {
      const steps = fc.array(fc.record({ doc: docArb, action: actionArb }), {
        minLength: DOCS_PER_RUN,
        maxLength: DOCS_PER_RUN,
      });
      startedAt = Date.now();
      await fc.assert(fc.asyncProperty(steps, runSequence), { seed: SEED, numRuns: RUNS });
      expect(totals.runs).toBe(RUNS);
      expect(totals.docs).toBeGreaterThanOrEqual(TARGET_DOCS);
    },
    // ~ a minute per thousand documents, plus headroom for shrinking a failure
    Math.max(600_000, DOCS_PER_RUN * RUNS * 120),
  );
});
