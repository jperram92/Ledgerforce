/**
 * Posting engine pipeline against a real PostgreSQL as lf_app (T-0025, design §3.9).
 *
 * SS-PLAT-65 — a valid raw command posts as one posted, numbered, hash-chained entry with its
 *   lines exactly as built; preview returns the same journal and writes nothing; the write is one
 *   unit (a failure in it, including the outbox hook, leaves nothing behind).
 * SS-PLAT-64 — every refusal is typed and leaves the database unchanged: accounts (unknown,
 *   unbound role, archived, non-postable, currency), control accounts outside their subledger,
 *   party, dimensions (invalid, required missing), number series, company, period.
 *
 * Commands here are raw journals written by the test (no event posting rule: every golden
 * posting is still Draft). Source types such as ar_invoice only label the subledger.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@ledgerforce/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dimensionSetId } from './dimension-set.ts';
import { verifyChain } from './hash-chain.ts';
import { DEFAULT_PERIOD_SETTINGS, type PeriodStatus } from './period-matrix.ts';
import { PeriodLockedError, findPeriod, setPeriodSettings, setPeriodStatus } from './period.ts';
import { PostingError, type PostingCommand, type PostingLineInput } from './posting-command.ts';
import { post, preview, type PostedEvent, type PostingOutbox } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const users: Record<string, string> = {};
const dim: Record<string, string> = {};
const party: Record<string, string> = {};

const A = (code: string) => ({ id: f.acct[code] ?? `missing ${code}` });

const jcmd = (lines: PostingLineInput[], over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines,
  ...over,
});

const RENT: PostingLineInput[] = [
  { account: { id: '' }, debit: '1000.0000', memo: 'Rent October' },
  { account: { role: 'SUSPENSE' }, credit: '1000.0000' },
];
const rent = () => [
  { ...(RENT[0] as PostingLineInput), account: A('6200') },
  RENT[1] as PostingLineInput,
];

async function addSeries(company: string, code: string, prefix: string) {
  await f.inTenant((trx) =>
    trx.insertInto('app.number_series').values({ company_id: company, code, prefix }).execute(),
  );
}

/** Everything the engine could write, plus every series counter (superuser, this tenant). */
const snapshot = () =>
  f.admin
    .query(
      `SELECT (SELECT count(*) FROM app.journal_entry WHERE tenant_id = $1)::int AS entries,
              (SELECT count(*) FROM app.journal_line WHERE tenant_id = $1)::int AS lines,
              (SELECT count(*) FROM app.dimension_set WHERE tenant_id = $1)::int AS sets,
              (SELECT count(*) FROM app.period_override WHERE tenant_id = $1)::int AS overrides,
              (SELECT json_agg(json_build_array(company_id, code, next_value) ORDER BY company_id, code)
                 FROM app.number_series WHERE tenant_id = $1) AS series`,
      [f.tenantId],
    )
    .then((r) => r.rows[0] as Record<string, unknown>);

const run = (command: PostingCommand, outbox?: PostingOutbox) =>
  f.inTenant((trx) => post(trx, command, outbox ? { outbox } : {}));

/** The command is refused with `code` (PostingError or PeriodLockedError) and nothing changes. */
async function refused(command: PostingCommand, code: string, line?: number) {
  const before = await snapshot();
  const err = await run(command).catch((e: unknown) => e);
  expect(err instanceof PostingError || err instanceof PeriodLockedError, String(err)).toBe(true);
  expect((err as { code: string }).code).toBe(code);
  if (line !== undefined) expect((err as PostingError).line).toBe(line);
  expect(await snapshot()).toEqual(before);
  return err as Error;
}

const storedLines = (entryId: string) =>
  f.inTenant((trx) =>
    sql<Record<string, unknown>>`
      SELECT line_no, account_id, debit::text, credit::text, txn_currency, txn_amount::text,
             fx_rate::text, tax_code_id, tax_amount::text, dimension_set_id, party_id, memo
        FROM app.journal_line WHERE entry_id = ${entryId} ORDER BY line_no`
      .execute(trx)
      .then((r) => r.rows),
  );

const entryRow = (entryId: string) =>
  f.inTenant((trx) =>
    sql<Record<string, unknown>>`
      SELECT e.entry_no, e.entry_date::text AS entry_date, e.status, e.source_type, e.source_id,
             e.created_by, e.memo, e.idempotency_key, p.name AS period_name, e.hash IS NOT NULL AS chained
        FROM app.journal_entry e JOIN app.fiscal_period p ON p.tenant_id = e.tenant_id AND p.id = e.period_id
       WHERE e.id = ${entryId}`
      .execute(trx)
      .then((r) => r.rows[0]),
  );

async function companyWith(statuses: Record<string, PeriodStatus>): Promise<string> {
  const company = await f.addCompany(`Scenario ${randomUUID().slice(0, 8)} Pty Ltd`);
  await f.inTenant(async (trx) => {
    for (const [month, status] of Object.entries(statuses)) {
      const period = await findPeriod(trx, company, `${month}-15`);
      if (!period) throw new Error(`no period ${month}`);
      await setPeriodStatus(trx, {
        periodId: period.id,
        status,
        actorId: users.financeAdmin ?? '',
      });
    }
  });
  for (const [code, prefix] of [
    ['je_manual_journal', 'MJ-'],
    ['je_ar_invoice', 'AR-'],
  ] as const) {
    await addSeries(company, code, prefix);
  }
  return company;
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002501');
  users.accountant = await f.addUser('accountant');
  users.financeAdmin = await f.addUser('finance_admin');
  for (const [code, prefix] of [
    ['je_manual_journal', 'MJ-'],
    ['je_ar_invoice', 'AR-'],
    ['je_ap_bill', 'AP-'],
  ] as const) {
    await addSeries(f.companyId, code, prefix);
  }
  await f.inTenant(async (trx) => {
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: f.companyId, code: 'department', name: 'Department' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [code, status] of [
      ['SALES', 'active'],
      ['OPS', 'active'],
      ['OLD', 'archived'],
    ] as const) {
      const v = await trx
        .insertInto('app.dimension_value')
        .values({ company_id: f.companyId, dimension_id: d.id, code, name: code, status })
        .returning('id')
        .executeTakeFirstOrThrow();
      dim[code] = v.id;
    }
    await trx
      .updateTable('app.account')
      .set({ required_dimensions: ['department'] })
      .where('id', '=', f.acct['6220'] ?? '')
      .execute();
    await trx
      .updateTable('app.account')
      .set({ status: 'archived' })
      .where('id', '=', f.acct['6800'] ?? '')
      .execute();
    await trx
      .updateTable('app.account')
      .set({ currency: 'USD' })
      .where('id', '=', f.acct['6700'] ?? '')
      .execute();
    for (const [name, company, status] of [
      ['acme', f.companyId, 'active'],
      ['gone', f.companyId, 'archived'],
      ['elsewhere', f.otherCompanyId, 'active'],
    ] as const) {
      const p = await trx
        .insertInto('app.party')
        .values({ company_id: company, legal_name: `${name} Pty Ltd`, status })
        .returning('id')
        .executeTakeFirstOrThrow();
      party[name] = p.id;
    }
  });
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-65 a valid command posts as one numbered, chained entry [T-0025]', () => {
  it('SS-PLAT-65 writes the entry and its lines exactly as built, by account id and system role [T-0025]', async () => {
    const command = jcmd(rent(), {
      createdBy: users.accountant ?? '',
      sourceId: 'MJ-REF-1',
      memo: 'October rent',
    });
    const r = await run(command);
    expect(r.replayed).toBe(false);
    expect(r.entryNo).toMatch(/^MJ-\d{6}$/);
    expect(r).toMatchObject({ entryDate: '2026-10-24', memo: 'October rent' });
    expect(await entryRow(r.entryId)).toEqual({
      entry_no: r.entryNo,
      entry_date: '2026-10-24',
      status: 'posted',
      source_type: 'manual_journal',
      source_id: 'MJ-REF-1',
      created_by: users.accountant,
      memo: 'October rent',
      idempotency_key: command.idempotencyKey,
      period_name: '2026-10',
      chained: true,
    });
    const base = {
      txn_currency: 'AUD',
      fx_rate: '1.00000000',
      tax_code_id: null,
      tax_amount: null,
      dimension_set_id: f.emptySet,
      party_id: null,
    };
    expect(await storedLines(r.entryId)).toEqual([
      {
        ...base,
        line_no: 1,
        account_id: f.acct['6200'],
        debit: '1000.0000',
        credit: '0.0000',
        txn_amount: '1000.0000',
        memo: 'Rent October',
      },
      {
        ...base,
        line_no: 2,
        account_id: f.acct['2900'],
        debit: '0.0000',
        credit: '1000.0000',
        txn_amount: '1000.0000',
        memo: null,
      },
    ]);
    await expect(f.inTenant((trx) => verifyChain(trx, f.companyId))).resolves.toMatchObject({
      ok: true,
    });
  });

  it('SS-PLAT-65 consecutive posts take consecutive numbers from the source type series [T-0025]', async () => {
    const a = await run(jcmd(rent()));
    const b = await run(jcmd(rent()));
    const n = (no: string) => BigInt(no.slice(3));
    expect(n(b.entryNo) - n(a.entryNo)).toBe(1n);
    const ar = await run(
      jcmd(
        [
          { account: { role: 'AR_CONTROL' }, debit: '5.0000', partyId: party.acme ?? '' },
          { account: { role: 'SUSPENSE' }, credit: '5.0000' },
        ],
        {
          sourceType: 'ar_invoice',
        },
      ),
    );
    expect(ar.entryNo).toMatch(/^AR-\d{6}$/);
  });

  it('SS-PLAT-65 carries transaction currency, amount, rate, tax code and party as given [T-0025]', async () => {
    const taxCode = randomUUID();
    const r = await run(
      jcmd([
        {
          account: A('6310'),
          debit: '152.3457',
          txnCurrency: 'USD',
          txnAmount: '100.0000',
          fxRate: '1.52345678',
          taxCodeId: taxCode,
          taxAmount: '0.0000',
        },
        { account: A('1010'), credit: '152.3457', partyId: party.acme ?? '' },
      ]),
    );
    const lines = await storedLines(r.entryId);
    expect(lines[0]).toMatchObject({
      txn_currency: 'USD',
      txn_amount: '100.0000',
      fx_rate: '1.52345678',
      debit: '152.3457',
      tax_code_id: taxCode,
      tax_amount: '0.0000',
    });
    expect(lines[1]).toMatchObject({
      txn_currency: 'AUD',
      txn_amount: '152.3457',
      fx_rate: '1.00000000',
      party_id: party.acme,
    });
  });

  it('SS-PLAT-65 a base-currency line must keep rate 1 and txn amount = base; a foreign one needs both [T-0025]', async () => {
    await refused(
      jcmd([
        { ...(rent()[0] as PostingLineInput), txnCurrency: 'AUD', fxRate: '1.1' },
        rent()[1] as PostingLineInput,
      ]),
      'INVALID_COMMAND',
      1,
    );
    await refused(
      jcmd([
        { ...(rent()[0] as PostingLineInput), txnCurrency: 'AUD', txnAmount: '999.0000' },
        rent()[1] as PostingLineInput,
      ]),
      'INVALID_COMMAND',
      1,
    );
    await refused(
      jcmd([
        { ...(rent()[0] as PostingLineInput), txnCurrency: 'USD', fxRate: '1.5' },
        rent()[1] as PostingLineInput,
      ]),
      'INVALID_COMMAND',
      1,
    );
    await refused(
      jcmd([
        { ...(rent()[0] as PostingLineInput), txnCurrency: 'USD', txnAmount: '600.0000' },
        rent()[1] as PostingLineInput,
      ]),
      'INVALID_COMMAND',
      1,
    );
  });

  it('SS-PLAT-65 preview returns the journal post will write, and writes nothing (read-only transaction) [T-0025]', async () => {
    const lines: PostingLineInput[] = [
      {
        account: A('6220'),
        debit: '80.0000',
        dimensions: [dim.OPS ?? ''],
        partyId: party.acme ?? '',
      },
      { account: { role: 'SUSPENSE' }, credit: '80.0000' },
    ];
    const command = jcmd(lines, { createdBy: users.accountant ?? '' });
    const before = await snapshot();
    const built = await f.inTenant(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return preview(trx, command);
    });
    expect(await snapshot()).toEqual(before);
    expect(built).toMatchObject({
      companyId: f.companyId,
      baseCurrency: 'AUD',
      entryDate: '2026-10-24',
      redirected: false,
      needsOverride: false,
      numberSeries: 'je_manual_journal',
      total: '80.0000',
    });
    expect(built.lines).toEqual([
      {
        lineNo: 1,
        accountId: f.acct['6220'],
        accountCode: '6220',
        debit: '80.0000',
        credit: '0.0000',
        txnCurrency: 'AUD',
        txnAmount: '80.0000',
        fxRate: '1',
        taxCodeId: null,
        taxAmount: null,
        dimensionValueIds: [dim.OPS],
        partyId: party.acme,
        memo: null,
      },
      {
        lineNo: 2,
        accountId: f.acct['2900'],
        accountCode: '2900',
        debit: '0.0000',
        credit: '80.0000',
        txnCurrency: 'AUD',
        txnAmount: '80.0000',
        fxRate: '1',
        taxCodeId: null,
        taxAmount: null,
        dimensionValueIds: [],
        partyId: null,
        memo: null,
      },
    ]);
    const r = await run(command);
    const stored = await storedLines(r.entryId);
    expect(stored.map((l) => [l.line_no, l.account_id, l.debit, l.credit, l.party_id])).toEqual(
      built.lines.map((l) => [l.lineNo, l.accountId, l.debit, l.credit, l.partyId]),
    );
    const opsSet = await f.inTenant((trx) => dimensionSetId(trx, f.companyId, [dim.OPS ?? '']));
    expect(stored[0]?.dimension_set_id).toBe(opsSet);
  });

  it('SS-PLAT-65 the outbox hook runs inside the posting transaction and sees the entry [T-0025]', async () => {
    const events: PostedEvent[] = [];
    const seen: unknown[] = [];
    const outbox: PostingOutbox = {
      async enqueue(trx: Transaction<Database>, e) {
        events.push(e);
        const row = await trx
          .selectFrom('app.journal_entry')
          .select('entry_no')
          .where('id', '=', e.entryId)
          .executeTakeFirst();
        seen.push(row?.entry_no);
      },
    };
    const command = jcmd(rent(), { sourceId: 'X-1' });
    const r = await run(command, outbox);
    expect(events).toEqual([
      {
        companyId: f.companyId,
        entryId: r.entryId,
        entryNo: r.entryNo,
        entryDate: '2026-10-24',
        sourceType: 'manual_journal',
        sourceId: 'X-1',
        idempotencyKey: command.idempotencyKey,
      },
    ]);
    expect(seen).toEqual([r.entryNo]);
  });

  it('SS-PLAT-65 a failure inside the write leaves nothing, even if the caller commits [T-0025]', async () => {
    const boom: PostingOutbox = { enqueue: () => Promise.reject(new Error('outbox down')) };
    const lines: PostingLineInput[] = [
      { account: A('6220'), debit: '7.0000', dimensions: [dim.SALES ?? ''] },
      { account: { role: 'SUSPENSE' }, credit: '7.0000' },
    ];
    const before = await snapshot();
    await expect(run(jcmd(lines), boom)).rejects.toThrow('outbox down');
    expect(await snapshot()).toEqual(before);
    // The caller swallows the error and commits its own transaction: still nothing written.
    const swallowed = await f.inTenant(async (trx) => {
      const e = await post(trx, jcmd(lines), { outbox: boom }).catch((x: unknown) => x);
      await sql`SELECT 1`.execute(trx); // the transaction is still usable
      return e;
    });
    expect(String(swallowed)).toMatch(/outbox down/);
    expect(await snapshot()).toEqual(before);
  });
});

describe('SS-PLAT-64 refusals are typed and write nothing [T-0025]', () => {
  it('SS-PLAT-64 unknown company, account, unbound role [T-0025]', async () => {
    await refused(jcmd(rent(), { companyId: randomUUID() }), 'UNKNOWN_COMPANY');
    await refused(
      jcmd([
        { account: { id: f.otherAcct['6200'] ?? '' }, debit: '1.0000' },
        { account: { role: 'SUSPENSE' }, credit: '1.0000' },
      ]),
      'UNKNOWN_ACCOUNT',
      1,
    );
    await refused(
      jcmd([
        { account: { id: randomUUID() }, debit: '1.0000' },
        { account: { role: 'SUSPENSE' }, credit: '1.0000' },
      ]),
      'UNKNOWN_ACCOUNT',
      1,
    );
    await refused(
      jcmd(
        [A('6200'), { role: 'NO_SUCH_ROLE' }].map((account, i) => ({
          account,
          [i ? 'credit' : 'debit']: '1.0000',
        })),
      ),
      'UNBOUND_SYSTEM_ROLE',
      2,
    );
  });

  it('SS-PLAT-64 archived, non-postable and currency-restricted accounts [T-0025]', async () => {
    const two = (account: { id: string } | { role: string }) =>
      jcmd([
        { account, debit: '1.0000' },
        { account: { role: 'SUSPENSE' }, credit: '1.0000' },
      ]);
    await refused(two(A('6800')), 'ACCOUNT_INACTIVE', 1);
    await refused(two({ role: 'CURRENT_YEAR_EARNINGS' }), 'ACCOUNT_NOT_POSTABLE', 1);
    await refused(two(A('3300')), 'ACCOUNT_NOT_POSTABLE', 1);
    await refused(two(A('6700')), 'ACCOUNT_CURRENCY', 1);
    // The USD-restricted account takes a USD line.
    await run(
      jcmd([
        {
          account: A('6700'),
          debit: '15.0000',
          txnCurrency: 'USD',
          txnAmount: '10.0000',
          fxRate: '1.5',
        },
        { account: { role: 'SUSPENSE' }, credit: '15.0000' },
      ]),
    );
  });

  it('SS-PLAT-64 control accounts accept only their own subledger [T-0025]', async () => {
    const toControl = (role: string, sourceType: string, account?: { id: string }) =>
      jcmd(
        [
          { account: account ?? { role }, debit: '9.0000' },
          { account: { role: 'SUSPENSE' }, credit: '9.0000' },
        ],
        { sourceType },
      );
    const err = await refused(toControl('AR_CONTROL', 'manual_journal'), 'CONTROL_ACCOUNT', 1);
    expect(err.message).toMatch(/1200.*AR_CONTROL.*manual_journal/);
    await refused(toControl('AR_CONTROL', 'manual_journal', A('1200')), 'CONTROL_ACCOUNT', 1);
    await refused(toControl('AR_CONTROL', 'ap_bill'), 'CONTROL_ACCOUNT', 1);
    await refused(toControl('AP_CONTROL', 'ar_invoice'), 'CONTROL_ACCOUNT', 1);
    await refused(toControl('PAYROLL_CLEARING', 'manual_journal'), 'CONTROL_ACCOUNT', 1);
    await expect(run(toControl('AR_CONTROL', 'ar_invoice'))).resolves.toMatchObject({
      replayed: false,
    });
    await expect(run(toControl('AP_CONTROL', 'ap_bill'))).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('SS-PLAT-64 parties must be active parties of the company [T-0025]', async () => {
    const withParty = (p: string) =>
      jcmd([{ ...(rent()[0] as PostingLineInput), partyId: p }, rent()[1] as PostingLineInput]);
    await refused(withParty(randomUUID()), 'INVALID_PARTY', 1);
    await refused(withParty(party.gone ?? ''), 'INVALID_PARTY', 1);
    await refused(withParty(party.elsewhere ?? ''), 'INVALID_PARTY', 1);
  });

  it('SS-PLAT-64 dimensions must be valid, and required dimensions present [T-0025]', async () => {
    const on6220 = (dims?: string[]) =>
      jcmd([
        { account: A('6220'), debit: '3.0000', ...(dims ? { dimensions: dims } : {}) },
        { account: { role: 'SUSPENSE' }, credit: '3.0000' },
      ]);
    const err = await refused(on6220(), 'MISSING_DIMENSION', 1);
    expect(err.message).toMatch(/6220.*department/);
    await refused(on6220([randomUUID()]), 'INVALID_DIMENSION', 1);
    await refused(on6220([dim.OLD ?? '']), 'INVALID_DIMENSION', 1);
    await refused(on6220([dim.SALES ?? '', dim.OPS ?? '']), 'INVALID_DIMENSION', 1);
    const r = await run(on6220([dim.SALES ?? '']));
    const set = await f.inTenant((trx) => dimensionSetId(trx, f.companyId, [dim.SALES ?? '']));
    expect((await storedLines(r.entryId))[0]?.dimension_set_id).toBe(set);
  });

  it('SS-PLAT-64 a source type without an active entry number series is refused [T-0025]', async () => {
    await refused(
      jcmd(
        [
          { account: { role: 'AP_CONTROL' }, debit: '4.0000' },
          { account: A('1010'), credit: '4.0000' },
        ],
        { sourceType: 'ap_payment' },
      ),
      'NO_NUMBER_SERIES',
    );
  });

  it('SS-PLAT-64 the period must allow the source type (no period, AR lock) [T-0025]', async () => {
    await refused(jcmd(rent(), { entryDate: '2028-01-10' }), 'NO_PERIOD');
    const company = await companyWith({ '2026-10': 'ar_locked' });
    const acct = f.chart(company).acct;
    const arCmd = (over: Partial<PostingCommand> = {}) =>
      jcmd(
        [
          { account: { role: 'AR_CONTROL' }, debit: '11.0000' },
          { account: { role: 'SUSPENSE' }, credit: '11.0000' },
        ],
        {
          companyId: company,
          entryDate: '2026-10-20',
          sourceType: 'ar_invoice',
          ...over,
        },
      );
    await refused(arCmd({ createdBy: users.accountant ?? '' }), 'PERIOD_LOCKED');
    // Journals still post into an AR-locked period.
    await run(
      jcmd(
        [
          { account: { id: acct['6200'] ?? '' }, debit: '2.0000' },
          { account: { role: 'SUSPENSE' }, credit: '2.0000' },
        ],
        { companyId: company, entryDate: '2026-10-20' },
      ),
    );
    // With a recorded override by a holder of period.lock.override, the AR entry posts.
    const before = await snapshot();
    const r = await run(
      arCmd({
        createdBy: users.financeAdmin ?? '',
        periodOverride: { reason: 'Late invoice approved' },
      }),
    );
    expect(r.entryDate).toBe('2026-10-20');
    expect((await snapshot()).overrides).toBe((before.overrides as number) + 1);
    // An override requested by someone without the permission is refused, nothing written.
    const denied = await snapshot();
    await expect(
      run(arCmd({ createdBy: users.accountant ?? '', periodOverride: { reason: 'try' } })),
    ).rejects.toThrow(/period\.lock\.override/);
    expect(await snapshot()).toEqual(denied);
  });

  it('SS-PLAT-64 the tenant lock-date policy moves a locked date to the first open date, with a note [T-0025]', async () => {
    const company = await companyWith({ '2026-10': 'ar_locked' });
    const setPolicy = (lockDatePolicy: 'reject' | 'post_to_first_open_date_with_note') =>
      f.inTenant((trx) =>
        setPeriodSettings(trx, {
          settings: { ...DEFAULT_PERIOD_SETTINGS, lockDatePolicy },
          setBy: users.financeAdmin ?? '',
          reason: `policy ${lockDatePolicy}`,
        }),
      );
    await setPolicy('post_to_first_open_date_with_note');
    try {
      const r = await run(
        jcmd(
          [
            { account: { role: 'AR_CONTROL' }, debit: '12.0000' },
            { account: { role: 'SUSPENSE' }, credit: '12.0000' },
          ],
          {
            companyId: company,
            entryDate: '2026-10-20',
            sourceType: 'ar_invoice',
            memo: 'Late invoice',
          },
        ),
      );
      expect(r.entryDate).toBe('2026-11-01');
      expect(r.memo).toMatch(
        /^Late invoice\nDated 2026-10-20 in period 2026-10 \(ar_locked\); posted on the first open date 2026-11-01/,
      );
      expect(await entryRow(r.entryId)).toMatchObject({
        entry_date: '2026-11-01',
        period_name: '2026-11',
        memo: r.memo,
      });
    } finally {
      await setPolicy('reject');
    }
  });
});
