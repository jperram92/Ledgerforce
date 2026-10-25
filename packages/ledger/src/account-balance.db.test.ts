/**
 * account_balance maintenance (T-0027, design §3.3, RQ-0032) against a real PostgreSQL.
 *
 * SS-PLAT-66 — every posting maintains account_balance per (company, account, period, dimension
 *   set, transaction currency) in the same transaction; replays and failed posts change nothing;
 *   draft lines count once the entry leaves draft; lf_app cannot write the table and the owner
 *   can only add to it; accountBalanceDrift() finds any difference from the posted lines.
 * SS-PLAT-67 — concurrent postings to the same accounts lose no update and do not deadlock.
 *
 * Commands are raw journals written by the test (no event posting rule: golden postings Draft).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountBalanceDrift, trialBalance } from './account-balance.ts';
import { dimensionSetId } from './dimension-set.ts';
import { findPeriod } from './period.ts';
import type { PostingCommand, PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
let owner: Kysely<Database>;
const dim: Record<string, string> = {};

const A = (code: string) => ({ id: f.acct[code] ?? `missing ${code}` });

const cmd = (lines: PostingLineInput[], over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: f.companyId,
  idempotencyKey: randomUUID(),
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines,
  ...over,
});

const run = (command: PostingCommand) => f.inTenant((trx) => post(trx, command));

interface BalanceRow {
  account: string;
  period: string;
  set: string;
  currency: string;
  dr: string;
  cr: string;
  txn_dr: string;
  txn_cr: string;
}

/** Every balance row of a company, by account code, period name and set id (as lf_app). */
const balances = (company = f.companyId) =>
  f.inTenant((trx) =>
    sql<BalanceRow>`
      SELECT a.code AS account, p.name AS period, b.dimension_set_id::text AS set, b.currency,
             b.debit_total::text AS dr, b.credit_total::text AS cr,
             b.txn_debit_total::text AS txn_dr, b.txn_credit_total::text AS txn_cr
        FROM app.account_balance b
        JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
        JOIN app.fiscal_period p ON p.tenant_id = b.tenant_id AND p.id = b.period_id
       WHERE b.company_id = ${company}
       ORDER BY a.code, p.start_date, b.dimension_set_id, b.currency`
      .execute(trx)
      .then((r) => r.rows),
  );

const allBalances = () =>
  f.admin
    .query(
      `SELECT to_jsonb(b)::text AS j FROM app.account_balance b WHERE tenant_id = $1 ORDER BY 1`,
      [f.tenantId],
    )
    .then((r) => r.rows.map((x: { j: string }) => x.j));

const asOwner = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
  withTenant(owner, f.tenantId, fn);

const code = (e: unknown) => (e as { code?: string }).code;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002701');
  owner = createDb(f.tdb.url('lf_migrator'), 2);
  await f.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute();
    const d = await trx
      .insertInto('app.dimension')
      .values({ company_id: f.companyId, code: 'department', name: 'Department' })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const c of ['SALES', 'OPS']) {
      const v = await trx
        .insertInto('app.dimension_value')
        .values({ company_id: f.companyId, dimension_id: d.id, code: c, name: c })
        .returning('id')
        .executeTakeFirstOrThrow();
      dim[c] = v.id;
    }
  });
});

afterAll(async () => {
  await owner.destroy();
  await f.close();
});

describe('SS-PLAT-66 account_balance is maintained in the posting transaction [T-0027]', () => {
  it('SS-PLAT-66 a posting adds its lines per company/account/period/dimension set/currency [T-0027]', async () => {
    const company = await f.addCompany(`Balances ${randomUUID().slice(0, 8)} Pty Ltd`);
    const chart = f.chart(company);
    await f.inTenant((trx) =>
      trx
        .insertInto('app.number_series')
        .values({ company_id: company, code: 'je_manual_journal', prefix: 'MJ-' })
        .execute(),
    );
    const B = (c: string) => ({ id: chart.acct[c] ?? `missing ${c}` });
    expect(await balances(company)).toEqual([]);

    await run(
      cmd(
        [
          { account: B('6200'), debit: '100.0000' },
          { account: B('6200'), debit: '20.5000' },
          {
            account: B('1020'),
            debit: '152.3500',
            txnCurrency: 'USD',
            txnAmount: '100.0000',
            fxRate: '1.5235',
          },
          { account: B('1010'), credit: '272.8500' },
        ],
        { companyId: company },
      ),
    );
    const set = chart.emptySet;
    expect(await balances(company)).toEqual([
      // prettier-ignore
      { account: '1010', period: '2026-10', set, currency: 'AUD', dr: '0.0000', cr: '272.8500', txn_dr: '0.0000', txn_cr: '272.8500' },
      // prettier-ignore
      { account: '1020', period: '2026-10', set, currency: 'USD', dr: '152.3500', cr: '0.0000', txn_dr: '100.0000', txn_cr: '0.0000' },
      // prettier-ignore
      { account: '6200', period: '2026-10', set, currency: 'AUD', dr: '120.5000', cr: '0.0000', txn_dr: '120.5000', txn_cr: '0.0000' },
    ]);

    // Same keys accumulate; another period and another currency are separate rows.
    await run(
      cmd(
        [
          { account: B('1010'), debit: '50.0000' },
          { account: B('6200'), credit: '50.0000' },
        ],
        { companyId: company },
      ),
    );
    await run(
      cmd(
        [
          { account: B('6200'), debit: '7.0000' },
          { account: B('1010'), credit: '7.0000' },
        ],
        { companyId: company, entryDate: '2026-11-03' },
      ),
    );
    await run(
      cmd(
        [
          { account: B('1020'), debit: '10.0000' },
          { account: B('1010'), credit: '10.0000' },
        ],
        { companyId: company },
      ),
    );
    expect(await balances(company)).toEqual([
      // prettier-ignore
      { account: '1010', period: '2026-10', set, currency: 'AUD', dr: '50.0000', cr: '282.8500', txn_dr: '50.0000', txn_cr: '282.8500' },
      // prettier-ignore
      { account: '1010', period: '2026-11', set, currency: 'AUD', dr: '0.0000', cr: '7.0000', txn_dr: '0.0000', txn_cr: '7.0000' },
      // prettier-ignore
      { account: '1020', period: '2026-10', set, currency: 'AUD', dr: '10.0000', cr: '0.0000', txn_dr: '10.0000', txn_cr: '0.0000' },
      // prettier-ignore
      { account: '1020', period: '2026-10', set, currency: 'USD', dr: '152.3500', cr: '0.0000', txn_dr: '100.0000', txn_cr: '0.0000' },
      // prettier-ignore
      { account: '6200', period: '2026-10', set, currency: 'AUD', dr: '120.5000', cr: '50.0000', txn_dr: '120.5000', txn_cr: '50.0000' },
      // prettier-ignore
      { account: '6200', period: '2026-11', set, currency: 'AUD', dr: '7.0000', cr: '0.0000', txn_dr: '7.0000', txn_cr: '0.0000' },
    ]);
    await expect(f.inTenant((trx) => accountBalanceDrift(trx, company))).resolves.toEqual([]);
    // The trial balance read from account_balance: one row per account, nets to zero.
    await expect(f.inTenant((trx) => trialBalance(trx, company))).resolves.toEqual([
      { accountId: chart.acct['1010'], code: '1010', debit: '50.0000', credit: '289.8500' },
      { accountId: chart.acct['1020'], code: '1020', debit: '162.3500', credit: '0.0000' },
      { accountId: chart.acct['6200'], code: '6200', debit: '127.5000', credit: '50.0000' },
    ]);
  });

  it('SS-PLAT-66 each dimension set has its own row [T-0027]', async () => {
    const sales = await f.inTenant((trx) => dimensionSetId(trx, f.companyId, [dim.SALES ?? '']));
    const ops = await f.inTenant((trx) => dimensionSetId(trx, f.companyId, [dim.OPS ?? '']));
    await run(
      cmd([
        { account: A('4110'), credit: '300.0000', dimensions: [dim.SALES ?? ''] },
        { account: A('4110'), credit: '200.0000', dimensions: [dim.OPS ?? ''] },
        { account: A('4110'), credit: '1.0000', dimensions: [dim.SALES ?? ''] },
        { account: A('1010'), debit: '501.0000' },
      ]),
    );
    const rows = (await balances()).filter((r) => r.account === '4110');
    expect(rows).toEqual(
      [
        // prettier-ignore
        { account: '4110', period: '2026-10', set: sales, currency: 'AUD', dr: '0.0000', cr: '301.0000', txn_dr: '0.0000', txn_cr: '301.0000' },
        // prettier-ignore
        { account: '4110', period: '2026-10', set: ops, currency: 'AUD', dr: '0.0000', cr: '200.0000', txn_dr: '0.0000', txn_cr: '200.0000' },
      ].sort((x, y) => x.set.localeCompare(y.set)),
    );
  });

  it('SS-PLAT-66 a replay with the same key adds nothing [T-0027]', async () => {
    const command = cmd([
      { account: A('6310'), debit: '12.3400' },
      { account: A('1010'), credit: '12.3400' },
    ]);
    await run(command);
    const before = await allBalances();
    const again = await run(command);
    expect(again.replayed).toBe(true);
    expect(await allBalances()).toEqual(before);
  });

  it('SS-PLAT-66 a post that fails in the write step changes no balance, even if the caller commits [T-0027]', async () => {
    const before = await allBalances();
    const err = await f
      .inTenant(async (trx) => {
        await post(
          trx,
          cmd([
            { account: A('6310'), debit: '99.0000' },
            { account: A('1010'), credit: '99.0000' },
          ]),
          {
            outbox: {
              enqueue: () => Promise.reject(new Error('outbox down')),
            },
          },
        ).catch((e: unknown) => e);
        return 'committed';
      })
      .catch((e: unknown) => e);
    expect(err).toBe('committed');
    expect(await allBalances()).toEqual(before);
  });

  it('SS-PLAT-66 lf_app cannot insert, update or delete account_balance (42501) [T-0027]', async () => {
    const period = await f.inTenant((trx) => findPeriod(trx, f.companyId, '2026-10-24'));
    const attempts = [
      sql`INSERT INTO app.account_balance (company_id, account_id, period_id, dimension_set_id, currency, debit_total)
          VALUES (${f.companyId}, ${f.acct['1010']}, ${period?.id}, ${f.emptySet}, 'AUD', 1)`,
      sql`UPDATE app.account_balance SET debit_total = debit_total + 1`,
      sql`DELETE FROM app.account_balance`,
      sql`TRUNCATE app.account_balance`,
    ];
    for (const q of attempts) {
      const e = await f.inTenant((trx) => q.execute(trx)).catch((x: unknown) => x);
      expect(code(e), String(e)).toBe('42501');
    }
  });

  it('SS-PLAT-66 the owner can only add to a balance: no decrease, key change, delete or truncate [T-0027]', async () => {
    const refused = [
      sql`UPDATE app.account_balance SET debit_total = debit_total - 0.0001 WHERE debit_total > 0`,
      sql`UPDATE app.account_balance SET credit_total = 0 WHERE credit_total > 0`,
      sql`UPDATE app.account_balance SET txn_debit_total = txn_debit_total - 0.0001 WHERE txn_debit_total > 0`,
      sql`UPDATE app.account_balance SET txn_credit_total = 0 WHERE txn_credit_total > 0`,
      sql`UPDATE app.account_balance SET currency = 'NZD'`,
      sql`UPDATE app.account_balance SET account_id = ${f.acct['6200']} WHERE account_id <> ${f.acct['6200']}`,
      sql`DELETE FROM app.account_balance`,
      sql`TRUNCATE app.account_balance`,
    ];
    const before = await allBalances();
    for (const q of refused) {
      const e = await asOwner((trx) => q.execute(trx)).catch((x: unknown) => x);
      expect(code(e), String(e)).toBe('23514');
    }
    expect(await allBalances()).toEqual(before);
  });

  it('SS-PLAT-66 draft lines count only once the entry leaves draft [T-0027]', async () => {
    const before = await allBalances();
    const entry = await f.inTenant((trx) =>
      f.insertEntry(
        trx,
        [
          { code: '6110', debit: '40.0000' },
          { code: '6110', debit: '2.0000' },
          { code: '1010', credit: '42.0000' },
        ],
        { status: 'draft' },
      ),
    );
    expect(await allBalances()).toEqual(before);
    const row6110 = async () => (await balances()).filter((r) => r.account === '6110');
    expect(await row6110()).toEqual([]);
    await asOwner((trx) =>
      sql`UPDATE app.journal_entry SET status = 'posted', posted_at = now() WHERE id = ${entry}`.execute(
        trx,
      ),
    );
    expect(await row6110()).toEqual([
      // prettier-ignore
      { account: '6110', period: '2026-10', set: f.emptySet, currency: 'AUD', dr: '42.0000', cr: '0.0000', txn_dr: '42.0000', txn_cr: '0.0000' },
    ]);
    await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual([]);
  });

  it('SS-PLAT-66 accountBalanceDrift reports a balance that differs from the posted lines [T-0027]', async () => {
    await expect(f.inTenant((trx) => accountBalanceDrift(trx, f.companyId))).resolves.toEqual([]);
    // Tamper as superuser with triggers off (outside any application path).
    const c = await f.admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE app.account_balance SET debit_total = debit_total + 1
          WHERE tenant_id = $1 AND company_id = $2 AND account_id = $3`,
        [f.tenantId, f.companyId, f.acct['6110']],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const drift = await f.inTenant((trx) => accountBalanceDrift(trx, f.companyId));
    expect(drift).toEqual([
      expect.objectContaining({
        accountId: f.acct['6110'],
        currency: 'AUD',
        balanceDebit: '43.0000',
        linesDebit: '42.0000',
      }),
    ]);
  });
});

describe('SS-PLAT-67 concurrent postings lose no balance update [T-0027]', () => {
  it('SS-PLAT-67 many concurrent postings to the same accounts all count, with no deadlock [T-0027]', async () => {
    const company = await f.addCompany(`Concurrency ${randomUUID().slice(0, 8)} Pty Ltd`);
    const chart = f.chart(company);
    await f.inTenant((trx) =>
      trx
        .insertInto('app.number_series')
        .values({ company_id: company, code: 'je_manual_journal', prefix: 'MJ-' })
        .execute(),
    );
    const X = chart.acct['1010'] ?? '';
    const Y = chart.acct['6200'] ?? '';
    const pool = createDb(f.tdb.url('lf_app'), 12);
    const N = 36;
    // Units are ten-thousandths (bigint), so the expected totals are exact.
    const amounts = Array.from({ length: N }, (_, i) => BigInt(10_000 + i * 1_237));
    const fmt = (u: bigint) =>
      `${(u / 10_000n).toString()}.${(u % 10_000n).toString().padStart(4, '0')}`;
    try {
      const results = await Promise.allSettled(
        amounts.map((u, i) =>
          withTenant(pool, f.tenantId, async (trx) => {
            const [dr, cr] = i % 2 === 0 ? [X, Y] : [Y, X];
            const r = await post(trx, {
              companyId: company,
              idempotencyKey: randomUUID(),
              entryDate: '2026-10-24',
              sourceType: 'manual_journal',
              lines: [
                { account: { id: dr }, debit: fmt(u) },
                { account: { id: cr }, credit: fmt(u) },
              ],
            });
            // Hold the balance row locks a little, so the other postings must wait on them.
            await sql`SELECT pg_sleep(0.02)`.execute(trx);
            return r;
          }),
        ),
      );
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    } finally {
      await pool.destroy();
    }
    const even = amounts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0n);
    const odd = amounts.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0n);
    const set = chart.emptySet;
    expect(await balances(company)).toEqual([
      // prettier-ignore
      { account: '1010', period: '2026-10', set, currency: 'AUD', dr: fmt(even), cr: fmt(odd), txn_dr: fmt(even), txn_cr: fmt(odd) },
      // prettier-ignore
      { account: '6200', period: '2026-10', set, currency: 'AUD', dr: fmt(odd), cr: fmt(even), txn_dr: fmt(odd), txn_cr: fmt(even) },
    ]);
    await expect(f.inTenant((trx) => accountBalanceDrift(trx, company))).resolves.toEqual([]);
  });
});
