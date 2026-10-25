/**
 * Posting preview — "show me the journal" (T-0026, design §3.9, RQ-0035), against a real
 * PostgreSQL as lf_app.
 *
 * SS-PLAT-15 — preview writes nothing: for any document, a whole-database fingerprint (every
 *   table in every non-system schema: row count + content hash; every sequence's last value) is
 *   the same before and after preview, so no journal row, line, dimension set, account_balance,
 *   number-series counter, hash-chain head, period override, audit row or outbox row was
 *   written. Then post() stores exactly the previewed journal.
 * SS-PLAT-72 — preview and post agree on refusals: the same typed error (including an unknown
 *   createdBy, an override without period.lock.override, a used key), and neither writes.
 *
 * Commands are raw journals written by the test (no event posting rule: every golden posting is
 * still Draft). Source types such as ar_invoice only label the subledger.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PERIOD_SETTINGS } from './period-matrix.ts';
import { findPeriod, setPeriodSettings, setPeriodStatus } from './period.ts';
import { PostingError, type PostingCommand, type PostingLineInput } from './posting-command.ts';
import { post, preview, type BuiltEntry } from './posting-engine.ts';
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
/** A company whose 2026-10 period is AR-locked. */
let arLocked = '';

const A = (code: string, company?: string) => ({
  id: (company ? f.chart(company).acct : f.acct)[code] ?? `missing ${code}`,
});
const fp = () => databaseFingerprint(f.admin);

const cmd = (lines: PostingLineInput[], over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines,
  ...over,
});

const previewIt = (command: PostingCommand) => f.inTenant((trx) => preview(trx, command));
const postIt = (command: PostingCommand) => f.inTenant((trx) => post(trx, command));
const stored = (entryId: string) => f.inTenant((trx) => storedJournal(trx, entryId));
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

/** Tables a real post must change — proves the fingerprint sees writes. */
const POST_WRITES = [
  'app.journal_entry',
  'app.journal_line',
  'app.account_balance',
  'app.number_series',
  'app.journal_chain_head',
];

async function setPolicy(lockDatePolicy: 'reject' | 'post_to_first_open_date_with_note') {
  await f.inTenant((trx) =>
    setPeriodSettings(trx, {
      settings: { ...DEFAULT_PERIOD_SETTINGS, lockDatePolicy },
      setBy: users.financeAdmin ?? '',
      reason: `policy ${lockDatePolicy}`,
    }),
  );
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002601');
  users.accountant = await f.addUser('accountant');
  users.financeAdmin = await f.addUser('finance_admin');
  arLocked = await f.addCompany('Locked Books Pty Ltd');
  await f.inTenant(async (trx) => {
    for (const company of [f.companyId, arLocked]) {
      for (const [code, prefix] of [
        ['je_manual_journal', 'MJ-'],
        ['je_ar_invoice', 'AR-'],
      ] as const) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code, prefix })
          .execute();
      }
    }
    const period = await findPeriod(trx, arLocked, '2026-10-15');
    await setPeriodStatus(trx, {
      periodId: period?.id ?? '',
      status: 'ar_locked',
      actorId: users.financeAdmin ?? '',
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
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    party.acme = p.id;
  });
});

afterAll(async () => {
  await f.close();
});

/** Documents of every kind the engine handles today (raw journals; no posting rules). */
const documents = (): {
  name: string;
  command: PostingCommand;
  check?: (b: BuiltEntry) => void;
}[] => [
  {
    name: 'manual journal by account id and system role, with memo, source id and user',
    command: cmd(
      [
        { account: A('6200'), debit: '1000.0000', memo: 'Rent October' },
        { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
      ],
      { createdBy: users.accountant ?? '', sourceId: 'MJ-REF-15', memo: 'October rent' },
    ),
  },
  {
    name: 'a dimension combination no entry has used yet (post would create the set), with a party',
    command: cmd([
      {
        account: A('6220'),
        debit: '80.1234',
        dimensions: [dim.P2 ?? '', dim.SALES ?? ''],
        partyId: party.acme ?? '',
      },
      { account: { role: 'SUSPENSE' }, credit: '80.1234' },
    ]),
  },
  {
    name: 'a foreign-currency line (txn amount and rate carried as given)',
    command: cmd([
      {
        account: A('6700'),
        debit: '1000.0000',
        txnCurrency: 'USD',
        txnAmount: '650.0000',
        fxRate: '0.65000000',
      },
      { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
    ]),
    check: (b) => expect(b.lines[0]?.fxRate).toBe('0.65'),
  },
  {
    name: 'an AR control account from its own subledger',
    command: cmd(
      [
        { account: { role: 'AR_CONTROL' }, debit: '55.0000', partyId: party.acme ?? '' },
        { account: { role: 'SUSPENSE' }, credit: '55.0000' },
      ],
      { sourceType: 'ar_invoice', sourceId: 'INV-15' },
    ),
  },
  {
    name: 'an override into an AR-locked period (post would record the override and audit it)',
    command: cmd(
      [
        { account: { role: 'AR_CONTROL' }, debit: '7.0000' },
        { account: { role: 'SUSPENSE' }, credit: '7.0000' },
      ],
      {
        companyId: arLocked,
        entryDate: '2026-10-20',
        sourceType: 'ar_invoice',
        createdBy: users.financeAdmin ?? '',
        periodOverride: { reason: 'Late invoice approved' },
      },
    ),
    check: (b) => expect(b).toMatchObject({ needsOverride: true, entryDate: '2026-10-20' }),
  },
];

describe('SS-PLAT-15 preview writes nothing [T-0026]', () => {
  it('SS-PLAT-15 preview of any document changes no row or sequence anywhere; post then stores exactly the previewed journal [T-0026]', async () => {
    for (const doc of documents()) {
      const before = await fp();
      const built = await previewIt(doc.command);
      expect(await fp(), doc.name).toEqual(before);
      doc.check?.(built);

      const r = await postIt(doc.command);
      expect(await stored(r.entryId), doc.name).toEqual(expectedJournal(built));
      const after = await fp();
      for (const t of POST_WRITES)
        expect(after.tables[t], `${doc.name}: ${t}`).not.toBe(before.tables[t]);
    }
  });

  it('SS-PLAT-15 preview of a date the lock-date policy moves changes nothing and shows the moved date and note [T-0026]', async () => {
    await setPolicy('post_to_first_open_date_with_note');
    try {
      const command = cmd(
        [
          { account: { role: 'AR_CONTROL' }, debit: '12.0000' },
          { account: { role: 'SUSPENSE' }, credit: '12.0000' },
        ],
        { companyId: arLocked, entryDate: '2026-10-21', sourceType: 'ar_invoice', memo: 'Late' },
      );
      const before = await fp();
      const built = await previewIt(command);
      expect(await fp()).toEqual(before);
      expect(built).toMatchObject({ redirected: true, entryDate: '2026-11-01' });
      expect(built.memo).toMatch(/^Late\nDated 2026-10-21 in period 2026-10 \(ar_locked\)/);
      const r = await postIt(command);
      expect(await stored(r.entryId)).toEqual(expectedJournal(built));
    } finally {
      await setPolicy('reject');
    }
  });

  it('SS-PLAT-15 preview runs in a READ ONLY transaction: it issues no write statement at all [T-0026]', async () => {
    for (const doc of documents()) {
      const before = await fp();
      await f.inTenant(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        return preview(trx, doc.command);
      });
      expect(await fp(), doc.name).toEqual(before);
    }
  });

  it('SS-PLAT-72 a refused preview refuses with the same typed error as post, and neither changes anything [T-0026]', async () => {
    const suspense = (credit: string): PostingLineInput => ({
      account: { role: 'SUSPENSE' },
      credit,
    });
    const rent = [{ account: A('6200'), debit: '5.0000' }, suspense('5.0000')];
    const cases: [string, PostingCommand][] = [
      ['UNKNOWN_USER', cmd(rent, { createdBy: randomUUID() })],
      [
        'OVERRIDE_NOT_PERMITTED',
        cmd(
          [
            { account: { role: 'AR_CONTROL' }, debit: '3.0000' },
            { account: { role: 'SUSPENSE' }, credit: '3.0000' },
          ],
          {
            companyId: arLocked,
            entryDate: '2026-10-20',
            sourceType: 'ar_invoice',
            createdBy: users.accountant ?? '',
            periodOverride: { reason: 'try' },
          },
        ),
      ],
      ['MISSING_DIMENSION', cmd([{ account: A('6220'), debit: '1.0000' }, suspense('1.0000')])],
      [
        'CONTROL_ACCOUNT',
        cmd([{ account: { role: 'AR_CONTROL' }, debit: '1.0000' }, suspense('1.0000')]),
      ],
      [
        'PERIOD_LOCKED',
        cmd([{ account: { role: 'AR_CONTROL' }, debit: '1.0000' }, suspense('1.0000')], {
          companyId: arLocked,
          entryDate: '2026-10-20',
          sourceType: 'ar_invoice',
        }),
      ],
      ['UNBALANCED', cmd([{ account: A('6200'), debit: '5.0000' }, suspense('4.0000')])],
    ];
    for (const [code, command] of cases) {
      const before = await fp();
      const p = await errorOf(previewIt(command));
      const q = await errorOf(postIt(command));
      expect(p?.code, `preview ${code}: ${String(p?.message)}`).toBe(code);
      expect(q?.code, `post ${code}: ${String(q?.message)}`).toBe(code);
      expect(await fp(), code).toEqual(before);
    }
    // The override message names the permission (as the database trigger does).
    expect((await errorOf(previewIt(cases[1]?.[1] as PostingCommand)))?.message).toMatch(
      /period\.lock\.override/,
    );
  });

  it('SS-PLAT-72 preview of a key that has posted: same document → ALREADY_POSTED with the entry, other document → IDEMPOTENCY_CONFLICT; nothing changes [T-0026]', async () => {
    const command = cmd(
      [
        { account: A('6200'), debit: '9.0000' },
        { account: { role: 'SUSPENSE' }, credit: '9.0000' },
      ],
      { sourceId: 'DOC-1' },
    );
    const r = await postIt(command);
    const before = await fp();
    const same = await errorOf(previewIt(command));
    expect(same).toBeInstanceOf(PostingError);
    expect(same).toMatchObject({ code: 'ALREADY_POSTED', entryId: r.entryId, entryNo: r.entryNo });
    // post() would replay that entry and write nothing.
    await expect(postIt(command)).resolves.toEqual({ ...r, replayed: true });
    const other = await errorOf(previewIt({ ...command, sourceId: 'DOC-2' }));
    expect(other).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(postIt({ ...command, sourceId: 'DOC-2' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await fp()).toEqual(before);
  });
});
