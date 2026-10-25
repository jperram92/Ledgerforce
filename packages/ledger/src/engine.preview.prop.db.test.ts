/**
 * Preview/post parity over random commands (T-0026, SS-PLAT-15, RQ-0035), against a real
 * PostgreSQL as lf_app. Default fast-check numRuns; amounts are bigint ten-thousandths formatted
 * as decimal strings (never floats).
 *
 * SS-PLAT-15 INV-preview          for any valid command, preview changes nothing (whole-database
 *                      fingerprint) and returns exactly the journal post() then stores.
 * SS-PLAT-72 INV-preview-outcome  for any command, valid or not, preview and post agree: both refuse with
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

/** Valid account choices: each posts from a manual journal with the dimensions given. */
type AccountChoice = 'plain' | 'role' | 'needsDept' | 'usdOnly';
const PLAIN = ['1010', '1100', '4110', '5000', '6110', '6200', '6310'];
type DimChoice = 'none' | 'dept' | 'deptProject' | 'project';

/**
 * At most one fault per command, so every refusal is reached in isolation (a command with many
 * faults only ever exercises the first check). 'overrideByAdmin' is a valid override.
 */
const FAULTS = [
  'none',
  'archivedAccount',
  'unknownAccount',
  'unboundRole',
  'arControlFromJournal',
  'twoDepts',
  'unknownDimension',
  'missingDepartment',
  'archivedParty',
  'unknownParty',
  'usdOnlyInAud',
  'unknownUser',
  'arInvoiceInLockedPeriod',
  'overrideByAccountant',
  'overrideByAdmin',
  'unbalanced',
] as const;
type Fault = (typeof FAULTS)[number];
/** The outcome each fault must produce, so the parity check cannot pass vacuously. */
const EXPECTED: Record<Fault, string> = {
  none: 'ok',
  archivedAccount: 'ACCOUNT_INACTIVE',
  unknownAccount: 'UNKNOWN_ACCOUNT',
  unboundRole: 'UNBOUND_SYSTEM_ROLE',
  arControlFromJournal: 'CONTROL_ACCOUNT',
  twoDepts: 'INVALID_DIMENSION',
  unknownDimension: 'INVALID_DIMENSION',
  missingDepartment: 'MISSING_DIMENSION',
  archivedParty: 'INVALID_PARTY',
  unknownParty: 'INVALID_PARTY',
  usdOnlyInAud: 'ACCOUNT_CURRENCY',
  unknownUser: 'UNKNOWN_USER',
  arInvoiceInLockedPeriod: 'PERIOD_LOCKED',
  overrideByAccountant: 'OVERRIDE_NOT_PERMITTED',
  overrideByAdmin: 'ok',
  unbalanced: 'UNBALANCED',
};

interface LineSpec {
  side: 'debit' | 'credit';
  units: bigint;
  account: AccountChoice;
  code: string;
  dims: DimChoice;
  withParty: boolean;
  memo: string | null;
  rate: string;
}

interface Spec {
  lines: LineSpec[];
  withUser: boolean;
  month: '2026-08' | '2026-10' | '2027-01';
  day: number;
  memo: string | null;
  sourceId: string | null;
  fault: Fault;
}

const lineSpec = fc.record({
  units: fc.bigInt({ min: 1n, max: 10n ** 11n }),
  account: fc.constantFrom<AccountChoice>('plain', 'role', 'needsDept', 'usdOnly'),
  code: fc.constantFrom(...PLAIN),
  dims: fc.constantFrom<DimChoice>('none', 'dept', 'deptProject', 'project'),
  withParty: fc.boolean(),
  memo: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
  rate: fc.constantFrom('0.65', '1.25000000', '0.00012345'),
});

function specs(valid: boolean): fc.Arbitrary<Spec> {
  return fc
    .record({
      debits: fc.array(lineSpec, { minLength: 1, maxLength: 3 }),
      credits: fc.array(lineSpec, { minLength: 1, maxLength: 3 }),
      withUser: fc.boolean(),
      // 2026-08 is AR-locked: journals still post there, AR invoices do not.
      month: fc.constantFrom('2026-08' as const, '2026-10' as const, '2027-01' as const),
      day: fc.integer({ min: 1, max: 28 }),
      memo: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
      sourceId: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
      fault: valid ? fc.constant<Fault>('none') : fc.constantFrom<Fault>(...FAULTS),
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

const ACCOUNT_CODE: Record<Exclude<AccountChoice, 'plain' | 'role'>, string> = {
  needsDept: '6220',
  usdOnly: '6700',
};
const DIMENSIONS = (): Record<DimChoice, string[]> => ({
  none: [],
  dept: [dim.SALES ?? ''],
  deptProject: [dim.P1 ?? '', dim.OPS ?? ''],
  project: [dim.P2 ?? ''],
});

/** The line without transaction-currency fields (a base-currency line). */
function inBase(l: PostingLineInput): PostingLineInput {
  const rest = { ...l };
  delete rest.txnCurrency;
  delete rest.txnAmount;
  delete rest.fxRate;
  return rest;
}

function toCommand(s: Spec): PostingCommand {
  const fault = s.fault;
  const lines = s.lines.map((l, i): PostingLineInput => {
    const first = i === 0;
    const account =
      l.account === 'role'
        ? { role: 'SUSPENSE' }
        : { id: f.acct[l.account === 'plain' ? l.code : ACCOUNT_CODE[l.account]] ?? '' };
    // 6220 requires a department: a valid command always gives one there.
    let dimensions =
      DIMENSIONS()[l.account === 'needsDept' && !l.dims.startsWith('dept') ? 'dept' : l.dims];
    let line: PostingLineInput = {
      account,
      [l.side]: fmt(l.units + (first && fault === 'unbalanced' ? 1n : 0n)),
      ...(l.account === 'usdOnly'
        ? { txnCurrency: 'USD', txnAmount: fmt(l.units / 2n + 1n), fxRate: l.rate }
        : {}),
      ...(l.withParty ? { partyId: party.acme ?? '' } : {}),
      ...(l.memo === null ? {} : { memo: l.memo }),
    };
    if (first) {
      const id = (code: string) => ({ id: f.acct[code] ?? '' });
      const faults: Partial<Record<Fault, () => void>> = {
        archivedAccount: () => (line = { ...line, account: id('6800') }),
        unknownAccount: () => (line = { ...line, account: { id: randomUUID() } }),
        unboundRole: () => (line = { ...line, account: { role: 'NO_SUCH_ROLE' } }),
        arControlFromJournal: () => (line = { ...line, account: { role: 'AR_CONTROL' } }),
        twoDepts: () => (dimensions = [dim.SALES ?? '', dim.OPS ?? '']),
        unknownDimension: () => (dimensions = [randomUUID()]),
        missingDepartment: () => {
          line = { ...inBase(line), account: id('6220') };
          dimensions = [dim.P1 ?? ''];
        },
        archivedParty: () => (line = { ...line, partyId: party.gone ?? '' }),
        unknownParty: () => (line = { ...line, partyId: randomUUID() }),
        usdOnlyInAud: () => (line = { ...inBase(line), account: id('6700') }),
      };
      faults[fault]?.();
      if (fault.startsWith('arInvoice') || fault.startsWith('override')) {
        line = { ...line, account: { role: 'AR_CONTROL' } };
      }
    }
    return dimensions.length > 0 ? { ...line, dimensions } : line;
  });
  const ar = fault === 'arInvoiceInLockedPeriod' || fault.startsWith('override');
  const createdBy =
    fault === 'unknownUser'
      ? randomUUID()
      : fault === 'overrideByAccountant'
        ? users.accountant
        : fault === 'overrideByAdmin'
          ? users.financeAdmin
          : s.withUser
            ? users.accountant
            : undefined;
  return {
    companyId: f.companyId,
    idempotencyKey: randomUUID(),
    entryDate: ar
      ? `2026-08-${String(s.day).padStart(2, '0')}`
      : `${s.month}-${String(s.day).padStart(2, '0')}`,
    sourceType: ar ? 'ar_invoice' : 'manual_journal',
    lines,
    ...(createdBy === undefined ? {} : { createdBy }),
    ...(fault.startsWith('override') ? { periodOverride: { reason: 'late invoice' } } : {}),
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
  users.financeAdmin = financeAdmin;
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

  it('SS-PLAT-72 INV-preview-outcome for any command, preview and post refuse with the same code or both give the same journal [T-0026]', async () => {
    let refusals = 0;
    const seen = new Set<Fault>();
    await fc.assert(
      fc.asyncProperty(specs(false), async (s) => {
        const command = toCommand(s);
        seen.add(s.fault);
        const before = await fp();
        const p = await outcome(f.inTenant((trx) => preview(trx, command)));
        expect(await fp()).toEqual(before);
        const q = await outcome(f.inTenant((trx) => post(trx, command)));
        expect({ fault: s.fault, post: q.ok ? 'ok' : q.code }).toEqual({
          fault: s.fault,
          post: EXPECTED[s.fault],
        });
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
    expect(seen.size).toBeGreaterThan(FAULTS.length / 2);
  });
});
