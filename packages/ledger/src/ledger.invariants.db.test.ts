/**
 * SS-PLAT-11 — accounting invariants over 10,000 random documents (T-0033, design §10.8 gate 3,
 * §9.1 MVP exit), against a real PostgreSQL as lf_app.
 *
 * fast-check generates a seeded stream of document intents (invoices, credit notes, receipts,
 * bills, payments, manual journals, voids). An interpreter turns each into raw posting commands
 * through the real engine — allocating receipts, credits and payments to open items, and voiding
 * earlier documents — while keeping an independent model in bigint ten-thousandths (never
 * floats). Afterwards:
 *   INV-balance    every entry balances (Σdebit = Σcredit, ≥ 2 lines);
 *   INV-tb-zero    the trial balance nets to zero and equals the model per account;
 *                  account_balance equals the sum of posted lines (no drift);
 *   INV-ar-control AR subledger = AR control, per party open amounts = model;
 *   INV-ap-control AP subledger = AP control, per party open amounts = model;
 *   INV-reversal   a voided document and its reversal net to zero on every account and leave
 *                  no open amount; a document with allocations cannot be voided (ALLOCATED).
 *
 * The seed is logged; reproduce a failure with LF_FC_SEED=<seed>. The document count is fixed.
 */
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trialBalance, accountBalanceDrift } from './account-balance.ts';
import { entrySeriesFor, PostingError, type PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { reverse } from './reversal.ts';
import {
  allocate,
  subledgerDrift,
  subledgerEntriesOf,
  subledgerReconciliation,
} from './subledger.ts';
import { SOURCE_TYPES } from './period-matrix.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

const DOCUMENTS = 10_000;
/** Intents drawn: voids are extra, so the stream is longer than the documents it must post. */
const INTENTS = 12_000;
const SEED = process.env.LF_FC_SEED ? Number.parseInt(process.env.LF_FC_SEED, 10) : 20_261_101;
if (!Number.isSafeInteger(SEED)) throw new Error(`LF_FC_SEED must be an integer`);
const CHUNK = 200;

type Kind = 'invoice' | 'credit_note' | 'receipt' | 'bill' | 'payment' | 'journal' | 'void';

interface Intent {
  kind: Kind;
  party: number;
  /** Net amount in cents. */
  cents: bigint;
  taxed: boolean;
  /** Which earlier document a void targets (modulo the documents so far). */
  pick: number;
}

const intent: fc.Arbitrary<Intent> = fc.record({
  kind: fc.constantFrom<Kind>(
    'invoice',
    'invoice',
    'invoice',
    'credit_note',
    'receipt',
    'receipt',
    'bill',
    'bill',
    'payment',
    'journal',
    'void',
  ),
  party: fc.nat({ max: 4 }),
  cents: fc.bigInt({ min: 1n, max: 2_000_000n }),
  taxed: fc.boolean(),
  pick: fc.nat({ max: 1_000_000 }),
});

/** bigint ten-thousandths → "123.4567" (signless). */
const fmt = (u: bigint): string => {
  const a = u < 0n ? -u : u;
  return `${(a / 10_000n).toString()}.${(a % 10_000n).toString().padStart(4, '0')}`;
};
/** "−12.3400" | "12.34" → bigint ten-thousandths. */
const units = (s: string): bigint => {
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(i) * 10_000n + BigInt((f + '0000').slice(0, 4));
  return neg ? -v : v;
};

interface ModelDoc {
  entryId: string;
  /** account id → signed net (debit +). */
  lines: Map<string, bigint>;
  role: 'AR_CONTROL' | 'AP_CONTROL' | null;
  party: string | null;
  /** Signed open amount of the document's control line (debit +), or 0n. */
  open: bigint;
  allocated: boolean;
  reversed: boolean;
}

let f: LedgerFixture;
const customers: string[] = [];
const suppliers: string[] = [];
const role: Record<string, string> = {};

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003301');
  await f.inTenant(async (trx) => {
    const series = [...new Set(Object.keys(SOURCE_TYPES).map((s) => entrySeriesFor(s)))];
    for (const [i, code] of series.entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix: `I${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (let i = 0; i < 5; i++) {
      for (const [list, name] of [
        [customers, 'Customer'],
        [suppliers, 'Supplier'],
      ] as const) {
        const p = await trx
          .insertInto('app.party')
          .values({ company_id: f.companyId, legal_name: `${name} ${String(i)}`, status: 'active' })
          .returning('id')
          .executeTakeFirstOrThrow();
        list.push(p.id);
      }
    }
    const roles = await trx
      .selectFrom('app.account_system_role')
      .select(['role', 'account_id'])
      .where('company_id', '=', f.companyId)
      .execute();
    for (const r of roles) role[r.role] = r.account_id;
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-11: Invariants hold over 10,000 random documents', () => {
  it('SS-PLAT-11 INV-balance INV-tb-zero INV-ar-control INV-ap-control INV-reversal over 10,000 seeded documents', async () => {
    console.info(
      `[SS-PLAT-11] fast-check seed ${String(SEED)} (reproduce with LF_FC_SEED=${String(SEED)})`,
    );
    const intents = fc.sample(intent, { seed: SEED, numRuns: INTENTS });
    expect(intents).toHaveLength(INTENTS);

    const AR = role.AR_CONTROL ?? '';
    const AP = role.AP_CONTROL ?? '';
    const GST_C = role.GST_COLLECTED ?? '';
    const GST_P = role.GST_PAID ?? '';
    const BANK = f.acct['1010'] ?? '';
    const REVENUE = f.acct['4110'] ?? '';
    const EXPENSE = f.acct['6200'] ?? '';
    for (const id of [AR, AP, GST_C, GST_P, BANK, REVENUE, EXPENSE]) expect(id).not.toBe('');

    const docs: ModelDoc[] = [];
    const model = new Map<string, bigint>();
    const add = (lines: Map<string, bigint>, sign: bigint) => {
      for (const [a, v] of lines) model.set(a, (model.get(a) ?? 0n) + sign * v);
    };
    let reversals = 0;
    let refusedVoids = 0;
    let allocations = 0;

    for (let start = 0; start < INTENTS && docs.length < DOCUMENTS; start += CHUNK) {
      await f.inTenant(async (trx) => {
        for (let i = start; i < Math.min(start + CHUNK, INTENTS) && docs.length < DOCUMENTS; i++) {
          const it = intents[i];
          if (!it) throw new Error(`no intent ${String(i)}`);
          // Dates move forward through FY2027 so allocations and voids are never back-dated.
          const day = new Date(Date.UTC(2026, 6, 1) + Math.floor((i * 360) / INTENTS) * 86_400_000);
          const date = day.toISOString().slice(0, 10);
          const key = `inv:${String(SEED)}:${String(i)}`;

          if (it.kind === 'void') {
            const candidates = docs.filter((d) => !d.reversed);
            const target = candidates[it.pick % Math.max(candidates.length, 1)];
            if (!target) continue;
            try {
              await reverse(trx, {
                companyId: f.companyId,
                entryId: target.entryId,
                idempotencyKey: key,
                entryDate: date,
              });
            } catch (e) {
              expect(e, `void of ${target.entryId}`).toBeInstanceOf(PostingError);
              expect((e as PostingError).code).toBe('ALLOCATED');
              expect(target.allocated).toBe(true);
              refusedVoids += 1;
              continue;
            }
            expect(target.allocated, `void of allocated ${target.entryId} must be refused`).toBe(
              false,
            );
            add(target.lines, -1n);
            target.reversed = true;
            target.open = 0n;
            reversals += 1;
            continue;
          }

          const net = it.cents * 100n;
          const gst = it.taxed ? ((it.cents + 5n) / 10n) * 100n : 0n;
          const gross = net + gst;
          const lines = new Map<string, bigint>();
          const cmd: PostingLineInput[] = [];
          const line = (account: string, signed: bigint, party?: string) => {
            if (signed === 0n) return;
            lines.set(account, (lines.get(account) ?? 0n) + signed);
            cmd.push({
              account: { id: account },
              ...(signed > 0n ? { debit: fmt(signed) } : { credit: fmt(signed) }),
              ...(party ? { partyId: party } : {}),
            });
          };
          let sourceType: string;
          let ctrl: 'AR_CONTROL' | 'AP_CONTROL' | null = null;
          let party: string | null = null;
          let open = 0n;
          switch (it.kind) {
            case 'invoice':
              party = customers[it.party] ?? '';
              ctrl = 'AR_CONTROL';
              open = gross;
              line(AR, gross, party);
              line(REVENUE, -net);
              line(GST_C, -gst);
              sourceType = 'ar_invoice';
              break;
            case 'credit_note':
              party = customers[it.party] ?? '';
              ctrl = 'AR_CONTROL';
              open = -gross;
              line(REVENUE, net);
              line(GST_C, gst);
              line(AR, -gross, party);
              sourceType = 'ar_credit_note';
              break;
            case 'receipt':
              party = customers[it.party] ?? '';
              ctrl = 'AR_CONTROL';
              open = -gross;
              line(BANK, gross);
              line(AR, -gross, party);
              sourceType = 'ar_receipt';
              break;
            case 'bill':
              party = suppliers[it.party] ?? '';
              ctrl = 'AP_CONTROL';
              open = -gross;
              line(EXPENSE, net);
              line(GST_P, gst);
              line(AP, -gross, party);
              sourceType = 'ap_bill';
              break;
            case 'payment':
              party = suppliers[it.party] ?? '';
              ctrl = 'AP_CONTROL';
              open = gross;
              line(AP, gross, party);
              line(BANK, -gross);
              sourceType = 'ap_payment';
              break;
            default:
              line(EXPENSE, gross);
              line(BANK, -gross);
              sourceType = 'manual_journal';
          }
          const r = await post(trx, {
            companyId: f.companyId,
            idempotencyKey: key,
            entryDate: date,
            sourceType,
            lines: cmd,
          });
          const doc: ModelDoc = {
            entryId: r.entryId,
            lines,
            role: ctrl,
            party,
            open,
            allocated: false,
            reversed: false,
          };
          docs.push(doc);
          add(lines, 1n);

          // Settle against the party's oldest open document of the opposite sign.
          if (
            ctrl &&
            (it.kind === 'receipt' || it.kind === 'credit_note' || it.kind === 'payment')
          ) {
            const target = docs.find(
              (d) =>
                d !== doc &&
                !d.reversed &&
                d.role === ctrl &&
                d.party === party &&
                d.open !== 0n &&
                d.open > 0n !== doc.open > 0n,
            );
            if (target) {
              const settle = [target.open, doc.open]
                .map((v) => (v < 0n ? -v : v))
                .reduce((a, b) => (a < b ? a : b));
              const [from] = await subledgerEntriesOf(trx, doc.entryId);
              const [to] = await subledgerEntriesOf(trx, target.entryId);
              await allocate(trx, {
                companyId: f.companyId,
                idempotencyKey: `${key}:alloc`,
                fromEntryId: from?.id ?? '',
                toEntryId: to?.id ?? '',
                amount: fmt(settle),
                allocationDate: date,
              });
              doc.open += doc.open > 0n ? -settle : settle;
              target.open += target.open > 0n ? -settle : settle;
              doc.allocated = true;
              target.allocated = true;
              allocations += 1;
            }
          }
        }
      });
    }
    console.info(
      `[SS-PLAT-11] ${String(docs.length)} documents, ${String(allocations)} allocations, ` +
        `${String(reversals)} voids, ${String(refusedVoids)} voids refused (ALLOCATED)`,
    );
    expect(docs.length).toBe(DOCUMENTS);
    // The stream must exercise every path, or the invariants prove little.
    expect(allocations).toBeGreaterThan(100);
    expect(reversals).toBeGreaterThan(100);
    expect(refusedVoids).toBeGreaterThan(10);

    await f.inTenant(async (trx) => {
      // INV-balance: every entry balances with at least two lines.
      const unbalanced = await sql<{ id: string }>`
        SELECT e.id::text FROM app.journal_entry e
          JOIN app.journal_line l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
         WHERE e.company_id = ${f.companyId}
         GROUP BY e.id HAVING sum(l.debit) <> sum(l.credit) OR count(*) < 2`.execute(trx);
      expect(unbalanced.rows).toEqual([]);
      const entries = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM app.journal_entry WHERE company_id = ${f.companyId}`.execute(
        trx,
      );
      expect(entries.rows[0]?.n).toBe(String(docs.length + reversals));

      // INV-tb-zero: TB nets to zero, equals the model, and account_balance has no drift.
      const tb = await trialBalance(trx, f.companyId);
      const net = tb.reduce((s, r) => s + units(r.debit) - units(r.credit), 0n);
      expect(net).toBe(0n);
      const stored = new Map(tb.map((r) => [r.accountId, units(r.debit) - units(r.credit)]));
      for (const [a, v] of model) expect(stored.get(a) ?? 0n, `account ${a}`).toBe(v);
      for (const [a, v] of stored) expect(model.get(a) ?? 0n, `account ${a}`).toBe(v);
      expect(await accountBalanceDrift(trx, f.companyId)).toEqual([]);

      // INV-ar-control / INV-ap-control: subledger = control, and per party = model.
      const rec = await subledgerReconciliation(trx, { companyId: f.companyId });
      for (const r of rec) expect(r.reconciled, `${r.controlRole}: ${r.difference}`).toBe(true);
      expect(await subledgerDrift(trx, f.companyId)).toEqual([]);
      const perParty = await sql<{ control_role: string; party_id: string; open: string }>`
        SELECT control_role, party_id::text, sum(base_open_amount)::text AS open
          FROM app.subledger_entry WHERE company_id = ${f.companyId}
         GROUP BY control_role, party_id`.execute(trx);
      const want = new Map<string, bigint>();
      for (const d of docs) {
        if (!d.role) continue;
        const k = `${d.role}:${String(d.party)}`;
        want.set(k, (want.get(k) ?? 0n) + d.open);
      }
      for (const r of perParty.rows) {
        const k = `${r.control_role}:${r.party_id}`;
        expect(units(r.open), k).toBe(want.get(k) ?? 0n);
      }
      expect(model.get(AR) ?? 0n).toBe(
        [...want].filter(([k]) => k.startsWith('AR_')).reduce((s, [, v]) => s + v, 0n),
      );
      expect(model.get(AP) ?? 0n).toBe(
        [...want].filter(([k]) => k.startsWith('AP_')).reduce((s, [, v]) => s + v, 0n),
      );

      // INV-reversal: each voided document and its reversal net to zero on every account.
      const pairs = await sql<{ id: string; account_id: string; net: string }>`
        SELECT o.id::text, l.account_id::text, sum(l.debit - l.credit)::text AS net
          FROM app.journal_entry o
          JOIN app.journal_entry r ON r.tenant_id = o.tenant_id AND r.reversal_of_id = o.id
          JOIN app.journal_line l ON l.tenant_id = o.tenant_id AND l.entry_id IN (o.id, r.id)
         WHERE o.company_id = ${f.companyId}
         GROUP BY o.id, l.account_id`.execute(trx);
      expect(new Set(pairs.rows.map((p) => p.id)).size).toBe(reversals);
      for (const p of pairs.rows) expect(units(p.net), `${p.id} ${p.account_id}`).toBe(0n);
      const status = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM app.journal_entry
         WHERE company_id = ${f.companyId} AND status = 'reversed'`.execute(trx);
      expect(status.rows[0]?.n).toBe(String(reversals));
    });
  }, 1_800_000);
});
