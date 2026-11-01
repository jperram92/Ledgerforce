/**
 * Reversal (void) of posted entries — T-0032, design §3.3, principle 2, GP-019, postings.md Q11.
 * Against a real PostgreSQL as lf_app.
 *
 * SS-UC10-09 — Void posts a reversal, never an edit: given posted GP-001, voiding it posts a new
 *   entry equal to GP-019 line for line (debit and credit swapped, same accounts and parties),
 *   linked by reversal_of_id; the original keeps every column and becomes status `reversed`;
 *   every account balance returns to its prior value and both AR open items close at 0.00.
 * Q11 — a document with allocations (e.g. a receipt) is not voided: credit note instead.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { Money } from '@ledgerforce/shared/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entrySeriesFor } from './posting-command.ts';
import { SOURCE_TYPES } from './period-matrix.ts';
import { post } from './posting-engine.ts';
import { reverse } from './reversal.ts';
import { allocate, subledgerEntriesOf } from './subledger.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';
import {
  AU_SERVICES_BINDINGS,
  approvedTables,
  parsePostings,
  toCommand,
  type GoldenJournal,
} from './golden/postings.ts';

const FILE = resolve(import.meta.dirname, '../../../Docs/accounting/postings.md');
const tables = approvedTables(parsePostings(readFileSync(FILE, 'utf8')));
const table = (id: string) => {
  const t = tables.find((x) => x.entryId === id);
  if (!t) throw new Error(`${id} missing`);
  return t;
};

let f: LedgerFixture;
let acme = '';

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

const commandFor = (t: GoldenJournal, entryDate = '2026-11-05') =>
  toCommand(t, {
    companyId: f.companyId,
    entryDate,
    idempotencyKey: randomUUID(),
    account: (b) => {
      const x = AU_SERVICES_BINDINGS[b];
      if (!x) throw new Error(`unresolved ${b}`);
      return 'role' in x ? { role: x.role } : { id: f.acct[x.code] ?? '' };
    },
    party: () => acme,
  });

const postInvoice = () => f.inTenant((trx) => post(trx, commandFor(table('GP-001'))));

async function balances(): Promise<Map<string, string>> {
  const rows = await f.inTenant((trx) =>
    trx
      .selectFrom('app.account_balance')
      .select(['account_id', sql<string>`sum(debit_total - credit_total)`.as('net')])
      .where('company_id', '=', f.companyId)
      .groupBy('account_id')
      .execute(),
  );
  return new Map(rows.map((r) => [r.account_id, Money.of(r.net, 'AUD').toNumericString()]));
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000003201');
  await f.inTenant(async (trx) => {
    for (const [i, st] of Object.keys(SOURCE_TYPES).entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code: entrySeriesFor(st), prefix: `J${String(i)}-` })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    acme = p.id;
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC10-09: Void posts a reversal, never an edit', () => {
  it('SS-UC10-09 voiding GP-001 posts GP-019, marks the original reversed and restores every balance', async () => {
    const before = await balances();
    const original = await postInvoice();
    const r = await f.inTenant((trx) =>
      reverse(trx, {
        companyId: f.companyId,
        entryId: original.entryId,
        idempotencyKey: randomUUID(),
        entryDate: '2026-11-06',
        memo: 'posted in error',
      }),
    );
    expect(r.replayed).toBe(false);

    const lines = await f.inTenant((trx) =>
      trx
        .selectFrom('app.journal_line as l')
        .innerJoin('app.account as a', 'a.id', 'l.account_id')
        .select(['l.line_no', 'a.code', 'l.debit', 'l.credit', 'l.party_id'])
        .where('l.entry_id', '=', r.entryId)
        .orderBy('l.line_no')
        .execute(),
    );
    const golden = table('GP-019');
    expect(lines).toHaveLength(golden.lines.length);
    golden.lines.forEach((g, i) => {
      const at = `GP-019 line ${String(i + 1)} (${g.binding})`;
      const b = AU_SERVICES_BINDINGS[g.binding];
      const code = b && 'code' in b ? b.code : undefined;
      if (code) expect(lines[i]?.code, at).toBe(code);
      expect(Money.of(lines[i]?.debit ?? '0', 'AUD').equals(Money.of(g.debit, 'AUD')), at).toBe(
        true,
      );
      expect(Money.of(lines[i]?.credit ?? '0', 'AUD').equals(Money.of(g.credit, 'AUD')), at).toBe(
        true,
      );
      expect(lines[i]?.party_id ?? null, at).toBe(g.party ? acme : null);
    });

    const [orig, rev] = await f.inTenant((trx) =>
      Promise.all(
        [original.entryId, r.entryId].map((id) =>
          trx
            .selectFrom('app.journal_entry')
            .select(['status', 'reversal_of_id', 'source_type', 'entry_date'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow(),
        ),
      ),
    );
    expect(orig?.status).toBe('reversed');
    expect(orig?.reversal_of_id).toBeNull();
    expect(rev?.status).toBe('posted');
    expect(rev?.reversal_of_id).toBe(original.entryId);
    expect(rev?.source_type).toBe('ledger_reversal');

    // Every balance is back where it was (INV-reversal).
    const after = await balances();
    for (const [account, net] of after) {
      expect(net, account).toBe(before.get(account) ?? Money.zero('AUD').toNumericString());
    }
    // Both AR open items close: the reversal is allocated to the invoice.
    const items = await f.inTenant(async (trx) => [
      ...(await subledgerEntriesOf(trx, original.entryId)),
      ...(await subledgerEntriesOf(trx, r.entryId)),
    ]);
    expect(items).toHaveLength(2);
    for (const i of items) expect(Money.of(i.openAmount, 'AUD').isZero(), i.entryId).toBe(true);
  });

  it('SS-UC10-09 a repeat with the same key returns the first reversal and writes nothing', async () => {
    const original = await postInvoice();
    const key = randomUUID();
    const go = () =>
      f.inTenant((trx) =>
        reverse(trx, {
          companyId: f.companyId,
          entryId: original.entryId,
          idempotencyKey: key,
          entryDate: '2026-11-06',
        }),
      );
    const first = await go();
    const again = await go();
    expect(again.replayed).toBe(true);
    expect(again.entryId).toBe(first.entryId);
  });

  it('SS-UC10-09 refuses to reverse an entry twice, or to reverse a reversal', async () => {
    const original = await postInvoice();
    const first = await f.inTenant((trx) =>
      reverse(trx, {
        companyId: f.companyId,
        entryId: original.entryId,
        idempotencyKey: randomUUID(),
        entryDate: '2026-11-06',
      }),
    );
    const twice = await errorOf(
      f.inTenant((trx) =>
        reverse(trx, {
          companyId: f.companyId,
          entryId: original.entryId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-11-06',
        }),
      ),
    );
    expect(twice?.code).toBe('NOT_REVERSIBLE');
    const ofReversal = await errorOf(
      f.inTenant((trx) =>
        reverse(trx, {
          companyId: f.companyId,
          entryId: first.entryId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-11-06',
        }),
      ),
    );
    expect(ofReversal?.code).toBe('NOT_REVERSIBLE');
  });

  it('Q11: an invoice with an allocation is not voided (credit note instead); nothing is written', async () => {
    const invoice = await postInvoice();
    const receipt = await f.inTenant((trx) => post(trx, commandFor(table('GP-002'), '2026-11-15')));
    await f.inTenant(async (trx) => {
      const [from] = await subledgerEntriesOf(trx, receipt.entryId);
      const [to] = await subledgerEntriesOf(trx, invoice.entryId);
      await allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        fromEntryId: from?.id ?? '',
        toEntryId: to?.id ?? '',
        amount: '100.0000',
        allocationDate: '2026-11-15',
      });
    });
    const count = () =>
      f.inTenant((trx) =>
        trx
          .selectFrom('app.journal_entry')
          .select(sql<string>`count(*)`.as('n'))
          .where('company_id', '=', f.companyId)
          .executeTakeFirstOrThrow(),
      );
    const before = await count();
    const err = await errorOf(
      f.inTenant((trx) =>
        reverse(trx, {
          companyId: f.companyId,
          entryId: invoice.entryId,
          idempotencyKey: randomUUID(),
          entryDate: '2026-11-16',
        }),
      ),
    );
    expect(err?.code).toBe('ALLOCATED');
    expect(err?.message).toMatch(/credit note/);
    expect(await count()).toEqual(before);
  });
});
