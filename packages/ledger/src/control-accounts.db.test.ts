/**
 * SS-PLAT-07 — control accounts reject manual journals, imports and rule lines (T-0029, design
 * §3.2, §11.3 item 3, RQ-0043, DL-0136). Real PostgreSQL as lf_app.
 *
 * The rule lives in the engine's validate step (DL-0136), so it holds for every caller and for
 * preview as well as post. Neither the CSV journal import nor custom rules (§4.5) exist yet:
 * an import enters manual journals (source type manual_journal, RQ-0043 finding 5) and a rule
 * journal without a subledger document has no subledger source type. This file proves the
 * refusal at the engine boundary for the three labelled paths and, exhaustively, for every
 * catalogued source type × control role; packages/modules/journals proves the document path.
 * The engine also writes the approver of an approved journal (approved_by, RQ-0043 finding 6).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCE_TYPES, sourceClassOf } from './period-matrix.ts';
import {
  PostingError,
  controlAccountAccepts,
  type PostingCommand,
  type PostingLineInput,
} from './posting-command.ts';
import { post, preview } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const users: Record<string, string> = {};
const CONTROL_ROLES = ['AR_CONTROL', 'AP_CONTROL', 'PAYROLL_CLEARING'] as const;
const CONTROL_CODES = { AR_CONTROL: '1200', AP_CONTROL: '2000', PAYROLL_CLEARING: '2350' };

const cmd = (
  sourceType: string,
  lines: PostingLineInput[],
  over: Partial<PostingCommand> = {},
): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType,
  lines,
  ...over,
});

/** A debit on the control account (by role or id) against suspense. */
const onControl = (account: PostingLineInput['account']): PostingLineInput[] => [
  { account, debit: '250.0000' },
  { account: { role: 'SUSPENSE' }, credit: '250.0000' },
];

const ledgerRows = () =>
  f.admin
    .query(
      `SELECT (SELECT count(*) FROM app.journal_entry WHERE tenant_id = $1)::int AS entries,
              (SELECT count(*) FROM app.journal_line WHERE tenant_id = $1)::int AS lines,
              (SELECT count(*) FROM app.subledger_entry WHERE tenant_id = $1)::int AS items,
              (SELECT json_agg(json_build_array(code, next_value) ORDER BY code)
                 FROM app.number_series WHERE tenant_id = $1) AS series`,
      [f.tenantId],
    )
    .then((r) => r.rows[0] as Record<string, unknown>);

/** post() and preview() both refuse with CONTROL_ACCOUNT on line 1; nothing is written. */
async function refusedOnControl(command: PostingCommand): Promise<PostingError> {
  const before = await ledgerRows();
  const viaPreview = await f.inTenant((trx) => preview(trx, command)).catch((e: unknown) => e);
  const viaPost = await f.inTenant((trx) => post(trx, command)).catch((e: unknown) => e);
  for (const err of [viaPreview, viaPost]) {
    expect(err, `${command.sourceType}: ${String(err)}`).toBeInstanceOf(PostingError);
    expect((err as PostingError).code).toBe('CONTROL_ACCOUNT');
    expect((err as PostingError).line).toBe(1);
  }
  expect(await ledgerRows()).toEqual(before);
  return viaPost as PostingError;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002901');
  users.accountant = await f.addUser('accountant');
  users.approver = await f.addUser('approver');
  await f.inTenant(async (trx) => {
    for (const [i, st] of Object.keys(SOURCE_TYPES).entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code: `je_${st}`, prefix: `S${String(i)}-` })
        .execute();
    }
  });
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-07: Control accounts reject manual journals, imports and rule lines', () => {
  it('SS-PLAT-07 a manual journal, a CSV journal import and a rule line on AR_CONTROL without subledger source are each refused with CONTROL_ACCOUNT', async () => {
    // The three paths, as each would reach the engine today (RQ-0043 finding 5).
    const manual = cmd('manual_journal', onControl({ role: 'AR_CONTROL' }), {
      sourceId: 'manual:adjust-debtors',
      createdBy: users.accountant ?? '',
    });
    const csvImport = cmd('manual_journal', onControl({ id: f.acct['1200'] ?? '' }), {
      sourceId: 'import:journals-2026-10.csv#row-2',
      memo: 'CSV journal import',
    });
    const ruleLine = cmd('manual_journal', onControl({ role: 'AR_CONTROL' }), {
      sourceId: 'rule:deposit-on-closed-won@3',
      memo: 'Custom rule journal without a subledger document',
    });
    for (const c of [manual, csvImport, ruleLine]) {
      const err = await refusedOnControl(c);
      expect(err.message).toMatch(/1200.*AR_CONTROL.*manual_journal is not its subledger/);
    }
  });

  it('SS-PLAT-07 every source type outside the subledger is refused on every control account; the subledger itself posts', async () => {
    let refusedCount = 0;
    let accepted = 0;
    for (const role of CONTROL_ROLES) {
      for (const st of Object.keys(SOURCE_TYPES)) {
        if (sourceClassOf(st) === 'reversal') continue; // never a raw command (DL-0136)
        for (const account of [{ role }, { id: f.acct[CONTROL_CODES[role]] ?? '' }]) {
          const c = cmd(st, onControl(account));
          if (controlAccountAccepts(role, st)) {
            const r = await f.inTenant((trx) => post(trx, c));
            expect(r.replayed).toBe(false);
            accepted += 1;
          } else {
            await refusedOnControl(c);
            refusedCount += 1;
          }
        }
      }
    }
    // AR: 8 AR-class types; AP: ap_bill, ap_payment; payroll: pay run, net-pay batch (DL-0136).
    expect(accepted).toBe(2 * (8 + 2 + 2));
    expect(refusedCount).toBe(2 * (3 * 14 - 12));
    // manual_journal is never among the accepted ones.
    for (const role of CONTROL_ROLES) {
      expect(controlAccountAccepts(role, 'manual_journal')).toBe(false);
    }
  });

  it('SS-PLAT-07 a journal line on a non-control account next to a refused control line does not slip through (line 2 on AP_CONTROL)', async () => {
    const before = await ledgerRows();
    const c = cmd('manual_journal', [
      { account: { id: f.acct['6200'] ?? '' }, debit: '10.0000' },
      { account: { role: 'AP_CONTROL' }, credit: '10.0000' },
    ]);
    const err = await f.inTenant((trx) => post(trx, c)).catch((e: unknown) => e);
    expect((err as PostingError).code).toBe('CONTROL_ACCOUNT');
    expect((err as PostingError).line).toBe(2);
    expect(await ledgerRows()).toEqual(before);
  });
});

describe('Posting engine records the approver of a journal (RQ-0043 finding 6) [T-0029]', () => {
  it('approvedBy is written to journal_entry.approved_by, shown by preview and covered by the hash chain', async () => {
    const c = cmd(
      'manual_journal',
      [
        { account: { id: f.acct['6200'] ?? '' }, debit: '7000.0000' },
        { account: { id: f.acct['1010'] ?? '' }, credit: '7000.0000' },
      ],
      { createdBy: users.accountant ?? '', approvedBy: users.approver ?? '' },
    );
    const built = await f.inTenant((trx) => preview(trx, c));
    expect(built.approvedBy).toBe(users.approver);
    const r = await f.inTenant((trx) => post(trx, c));
    const row = await f.inTenant((trx) =>
      sql<{ created_by: string; approved_by: string; hash: string | null }>`
        SELECT created_by::text, approved_by::text, hash FROM app.journal_entry WHERE id = ${r.entryId}`
        .execute(trx)
        .then((x) => x.rows[0]),
    );
    expect(row).toMatchObject({ created_by: users.accountant, approved_by: users.approver });
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an approvedBy that is not a user of the tenant is refused with UNKNOWN_USER before any write', async () => {
    const before = await ledgerRows();
    const c = cmd(
      'manual_journal',
      [
        { account: { id: f.acct['6200'] ?? '' }, debit: '1.0000' },
        { account: { id: f.acct['1010'] ?? '' }, credit: '1.0000' },
      ],
      { approvedBy: randomUUID() },
    );
    for (const run of [preview, post] as const) {
      const err = await f.inTenant((trx) => run(trx, c)).catch((e: unknown) => e);
      expect((err as PostingError).code).toBe('UNKNOWN_USER');
    }
    expect(await ledgerRows()).toEqual(before);
    const bad = await f
      .inTenant((trx) => post(trx, { ...c, approvedBy: 'not-a-uuid' }))
      .catch((e: unknown) => e);
    expect((bad as PostingError).code).toBe('INVALID_COMMAND');
  });
});
