/**
 * Preview/post parity over random commands (T-0026, SS-PLAT-15, RQ-0035), against a real
 * PostgreSQL as lf_app. Default fast-check numRuns; amounts are bigint ten-thousandths formatted
 * as decimal strings (never floats).
 *
 * INV-preview          for any valid command, preview changes nothing (whole-database
 *                      fingerprint) and returns exactly the journal post() then stores.
 * INV-preview-outcome  for any command, valid or not, preview and post agree: both refuse with
 *                      the same error code (and nothing changes), or both succeed with the same
 *                      journal.
 */
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPeriod, setPeriodStatus } from './period.ts';
import type { PostingCommand, PostingLineInput } from './posting-command.ts';
import { post, preview } from './posting-engine.ts';
import {
  createLedgerFixture,
  databaseFingerprint,
  expectedJournal,
  storedJournal,
  type LedgerFixture,
} from './testing/journal-fixture.ts';

let f: LedgerFixture;
const users: Record<string, string> = {};
const dim: Record<string, string> = {};
const party: Record<string, string> = {};

const fmt = (u: bigint): string =>
  `${(u / 10_000n).toString()}.${(u % 10_000n).toString().padStart(4, '0')}`;

/** Account choices. `valid` ones post from any manual journal with the dimensions given. */
type AccountChoice =
  'plain' | 'role' | 'needsDept' | 'usdOnly' | 'arControl' | 'archived' | 'unknown' | 'unboundRole';
const VALID_ACCOUNTS: AccountChoice[] = ['plain', 'role', 'needsDept', 'usdOnly'];
const ANY_ACCOUNTS: AccountChoice[] = [
  ...VALID_ACCOUNTS,
  'arControl',
  'archived',
  'unknown',
  'unboundRole',
];
const PLAIN = ['1010', '1100', '4110', '5000', '6110', '6200', '6310'];

type DimChoice = 'none' | 'dept' | 'deptProject' | 'project' | 'twoDepts' | 'unknown';
type PartyChoice = 'none' | 'acme' | 'archived' | 'unknown';
type UserChoice = 'none' | 'accountant' | 'unknown';

interface LineSpec {
  side: 'debit' | 'credit';
  units: bigint;
  account: AccountChoice;
  code: string;
  dims: DimChoice;
  party: PartyChoice;
  memo: string | null;
  rate: string;
}

interface Spec {
  lines: LineSpec[];
  sourceType: 'manual_journal' | 'ar_invoice';
  user: UserChoice;
  month: '2026-08' | '2026-10' | '2027-01';
  day: number;
  memo: string | null;
  sourceId: string | null;
  unbalanceBy: bigint;
}

const lineSpec = (accounts: AccountChoice[], dims: DimChoice[], parties: PartyChoice[]) =>
  fc.record({
    units: fc.bigInt({ min: 1n, max: 10n ** 11n }),
    account: fc.constantFrom(...accounts),
    code: fc.constantFrom(...PLAIN),
    dims: fc.constantFrom(...dims),
    party: fc.constantFrom(...parties),
    memo: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
    rate: fc.constantFrom('0.65', '1.25000000', '0.00012345'),
  });

function specs(valid: boolean): fc.Arbitrary<Spec> {
  const line = valid
    ? lineSpec(VALID_ACCOUNTS, ['none', 'dept', 'deptProject', 'project'], ['none', 'acme'])
    : lineSpec(
        ANY_ACCOUNTS,
        ['none', 'dept', 'deptProject', 'project', 'twoDepts', 'unknown'],
        ['none', 'acme', 'archived', 'unknown'],
      );
  return fc
    .record({
      debits: fc.array(line, { minLength: 1, maxLength: 3 }),
      credits: fc.array(line, { minLength: 1, maxLength: 3 }),
      sourceType: valid
        ? fc.constant('manual_journal' as const)
        : fc.constantFrom('manual_journal' as const, 'ar_invoice' as const),
      user: valid
        ? fc.constantFrom<UserChoice>('none', 'accountant')
        : fc.constantFrom<UserChoice>('none', 'accountant', 'unknown'),
      month: valid
        ? fc.constantFrom('2026-10' as const, '2027-01' as const)
        : fc.constantFrom('2026-08' as const, '2026-10' as const, '2027-01' as const),
      day: fc.integer({ min: 1, max: 28 }),
      memo: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
      sourceId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
      unbalanceBy: valid ? fc.constant(0n) : fc.constantFrom(0n, 0n, 0n, 1n),
    })
    .map(({ debits, credits, ...rest }): Spec => {
      const d = debits.reduce((a, l) => a + l.units, 0n);
      const c = credits.reduce((a, l) => a + l.units, 0n);
      const plug = (
        d > c
          ? { ...(credits[0] as Omit<LineSpec, 'side'>), units: d - c, side: 'credit' }
          : c > d
            ? { ...(debits[0] as Omit<LineSpec, 'side'>), units: c - d, side: 'debit' }
            : null
      ) as LineSpec | null;
      return {
        ...rest,
        lines: [
          ...debits.map((l): LineSpec => ({ ...l, side: 'debit' })),
          ...credits.map((l): LineSpec => ({ ...l, side: 'credit' })),
          ...(plug ? [plug] : []),
        ],
      };
    });
}

function toCommand(s: Spec): PostingCommand {
  const lines = s.lines.map((l, i): PostingLineInput => {
    const amount = fmt(l.units + (i === 0 ? s.unbalanceBy : 0n));
    const account =
      l.account === 'role'
        ? { role: 'SUSPENSE' }
        : l.account === 'unboundRole'
          ? { role: 'PAYROLL_CLEARING_X' }
          : l.account === 'arControl'
            ? { role: 'AR_CONTROL' }
            : {
                id:
                  l.account === 'unknown'
                    ? randomUUID()
                    : (f.acct[
                        l.account === 'needsDept'
                          ? '6220'
                          : l.account === 'usdOnly'
                            ? '6700'
                            : l.account === 'archived'
                              ? '6800'
                              : l.code
                      ] ?? ''),
              };
    // 6220 requires a department: a valid command always gives one there.
    const dims =
      l.account === 'needsDept' && (l.dims === 'none' || l.dims === 'project') ? 'dept' : l.dims;
    const dimensions = {
      none: [],
      dept: [dim.SALES ?? ''],
      deptProject: [dim.P1 ?? '', dim.OPS ?? ''],
      project: [dim.P2 ?? ''],
      twoDepts: [dim.SALES ?? '', dim.OPS ?? ''],
      unknown: [randomUUID()],
    }[dims];
    const partyId = {
      none: undefined,
      acme: party.acme,
      archived: party.gone,
      unknown: randomUUID(),
    }[l.party];
    return {
      account,
      [l.side]: amount,
      ...(l.account === 'usdOnly'
        ? { txnCurrency: 'USD', txnAmount: fmt(l.units / 2n + 1n), fxRate: l.rate }
        : {}),
      ...(dimensions.length > 0 ? { dimensions } : {}),
      ...(partyId === undefined ? {} : { partyId }),
      ...(l.memo === null ? {} : { memo: l.memo }),
    };
  });
  const createdBy = { none: undefined, accountant: users.accountant, unknown: randomUUID() }[
    s.user
  ];
  return {
    companyId: f.companyId,
    idempotencyKey: randomUUID(),
    entryDate: `${s.month}-${String(s.day).padStart(2, '0')}`,
    sourceType: s.sourceType,
    lines,
    ...(createdBy === undefined ? {} : { createdBy }),
    ...(s.memo === null ? {} : { memo: s.memo }),
    ...(s.sourceId === null ? {} : { sourceId: s.sourceId }),
  };
}

const fp = () => databaseFingerprint(f.admin);
const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code ?? String(e) }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002602');
  users.accountant = await f.addUser('accountant');
  const financeAdmin = await f.addUser('finance_admin');
  await f.inTenant(async (trx) => {
    for (const [code, prefix] of [
      ['je_manual_journal', 'MJ-'],
      ['je_ar_invoice', 'AR-'],
    ] as const) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: f.companyId, code, prefix })
        .execute();
    }
    const august = await findPeriod(trx, f.companyId, '2026-08-15');
    await setPeriodStatus(trx, {
      periodId: august?.id ?? '',
      status: 'ar_locked',
      actorId: financeAdmin,
    });
    for (const [dimCode, values] of [
      ['department', ['SALES', 'OPS']],
      ['project', ['P1', 'P2']],
    ] as const) {
      const d = await trx
        .insertInto('app.dimension')
        .values({ company_id: f.companyId, code: dimCode, name: dimCode })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const code of values) {
        const v = await trx
          .insertInto('app.dimension_value')
          .values({ company_id: f.companyId, dimension_id: d.id, code, name: code })
          .returning('id')
          .executeTakeFirstOrThrow();
        dim[code] = v.id;
      }
    }
    await trx
      .updateTable('app.account')
      .set({ required_dimensions: ['department'] })
      .where('id', '=', f.acct['6220'] ?? '')
      .execute();
    await trx
      .updateTable('app.account')
      .set({ currency: 'USD' })
      .where('id', '=', f.acct['6700'] ?? '')
      .execute();
    await trx
      .updateTable('app.account')
      .set({ status: 'archived' })
      .where('id', '=', f.acct['6800'] ?? '')
      .execute();
    for (const [name, status] of [
      ['acme', 'active'],
      ['gone', 'archived'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: f.companyId, legal_name: `${name} Pty Ltd`, status })
        .returning('id')
        .executeTakeFirstOrThrow();
      party[name] = p.id;
    }
  });
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-15 preview equals post over random commands [T-0026]', () => {
  it('SS-PLAT-15 INV-preview for any valid command, preview changes nothing and equals the journal post stores [T-0026]', async () => {
    await fc.assert(
      fc.asyncProperty(specs(true), async (s) => {
        const command = toCommand(s);
        const before = await fp();
        const built = await f.inTenant((trx) => preview(trx, command));
        expect(await fp()).toEqual(before);
        const r = await f.inTenant((trx) => post(trx, command));
        expect(await f.inTenant((trx) => storedJournal(trx, r.entryId))).toEqual(
          expectedJournal(built),
        );
      }),
    );
  });

  it('SS-PLAT-15 INV-preview-outcome for any command, preview and post refuse with the same code or both give the same journal [T-0026]', async () => {
    let refusals = 0;
    await fc.assert(
      fc.asyncProperty(specs(false), async (s) => {
        const command = toCommand(s);
        const before = await fp();
        const p = await outcome(f.inTenant((trx) => preview(trx, command)));
        expect(await fp()).toEqual(before);
        const q = await outcome(f.inTenant((trx) => post(trx, command)));
        if (!p.ok || !q.ok) {
          refusals += 1;
          expect({ preview: p.ok ? 'ok' : p.code }).toEqual({ preview: q.ok ? 'ok' : q.code });
          expect(await fp()).toEqual(before);
          return;
        }
        const entryId = (q.v as { entryId: string }).entryId;
        expect(await f.inTenant((trx) => storedJournal(trx, entryId))).toEqual(
          expectedJournal(p.v as Parameters<typeof expectedJournal>[0]),
        );
      }),
    );
    // The generator must exercise refusals, not only valid commands.
    expect(refusals).toBeGreaterThan(10);
  });
});
