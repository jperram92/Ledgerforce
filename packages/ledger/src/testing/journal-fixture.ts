/**
 * Test fixture for ledger db tests: a fresh database, one tenant with two companies on the AU
 * services SMB chart, the empty dimension set, and a helper that writes an entry with lines the
 * way the posting engine will (as lf_app, inside a tenant transaction). Test-only.
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { createTestDatabase, type TestDatabase } from '@ledgerforce/db/testing';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { sql, type Kysely, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { dimensionSetId } from '../dimension-set.ts';

export interface Line {
  /** Account code in the main company's chart, or an account id. */
  code: string;
  debit?: string;
  credit?: string;
}

export interface EntryOptions {
  company?: string;
  status?: 'draft' | 'posted';
  reversalOf?: string;
  memo?: string;
  entryNo?: string;
  sourceId?: string;
  /** Line memo applied to every line. */
  lineMemo?: string;
}

export interface LedgerFixture {
  tdb: TestDatabase;
  db: Kysely<Database>;
  tenantId: string;
  companyId: string;
  otherCompanyId: string;
  /** Main company: account code → id. */
  acct: Record<string, string>;
  otherAcct: Record<string, string>;
  emptySet: string;
  inTenant<R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R>;
  insertEntry(trx: Transaction<Database>, lines: Line[], opts?: EntryOptions): Promise<string>;
  /** A further company on the same chart template; insertEntry({ company }) then uses its chart. */
  addCompany(name: string): Promise<string>;
  /** A company's chart (code → account id) and its empty dimension set. */
  chart(company: string): { acct: Record<string, string>; emptySet: string };
  countEntries(): Promise<number>;
  close(): Promise<void>;
}

export async function createLedgerFixture(tenantId: string): Promise<LedgerFixture> {
  const tdb = await createTestDatabase({ migrate: true });
  const db = createDb(tdb.url('lf_app'), 4);
  const inTenant = <R>(fn: (trx: Transaction<Database>) => Promise<R>) =>
    withTenant(db, tenantId, fn);

  const seeded = await inTenant(async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: tenantId, name: 'Harbour & Co Pty Ltd' })
      .execute();
    const [c1, c2] = await trx
      .insertInto('app.company')
      .values([
        { name: 'Harbour & Co Pty Ltd', base_currency: 'AUD' },
        { name: 'Harbour Holdings Pty Ltd', base_currency: 'AUD' },
      ])
      .returning('id')
      .execute();
    if (!c1 || !c2) throw new Error('fixture: company seed failed');
    const main = await loadChartTemplate(trx, c1.id, auServicesSmb);
    const other = await loadChartTemplate(trx, c2.id, auServicesSmb);
    return {
      companyId: c1.id,
      otherCompanyId: c2.id,
      acct: Object.fromEntries(main.accounts),
      otherAcct: Object.fromEntries(other.accounts),
      emptySet: await dimensionSetId(trx, c1.id, []),
    };
  });

  /** company id → its chart (code → account id) and empty dimension set. */
  const charts = new Map<string, { acct: Record<string, string>; emptySet: string }>([
    [seeded.companyId, { acct: seeded.acct, emptySet: seeded.emptySet }],
    [seeded.otherCompanyId, { acct: seeded.otherAcct, emptySet: '' }],
  ]);

  async function addCompany(name: string): Promise<string> {
    return inTenant(async (trx) => {
      const c = await trx
        .insertInto('app.company')
        .values({ name, base_currency: 'AUD' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
      charts.set(c.id, {
        acct: Object.fromEntries(chart.accounts),
        emptySet: await dimensionSetId(trx, c.id, []),
      });
      return c.id;
    });
  }

  async function insertEntry(
    trx: Transaction<Database>,
    lines: Line[],
    opts: EntryOptions = {},
  ): Promise<string> {
    const company = opts.company ?? seeded.companyId;
    const chart = charts.get(company) ?? { acct: seeded.acct, emptySet: seeded.emptySet };
    const status = opts.status ?? 'posted';
    const entry = await trx
      .insertInto('app.journal_entry')
      .values({
        company_id: company,
        entry_date: '2026-10-24',
        source_type: 'manual_journal',
        status,
        reversal_of_id: opts.reversalOf ?? null,
        memo: opts.memo ?? null,
        entry_no: opts.entryNo ?? null,
        source_id: opts.sourceId ?? null,
        idempotency_key: randomUUID(),
        posted_at: status === 'posted' ? new Date('2026-10-24T09:00:00Z') : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (lines.length > 0) {
      await trx
        .insertInto('app.journal_line')
        .values(
          lines.map((l, i) => ({
            company_id: company,
            entry_id: entry.id,
            line_no: i + 1,
            account_id: chart.acct[l.code] ?? l.code,
            debit: l.debit ?? '0',
            credit: l.credit ?? '0',
            txn_currency: 'AUD',
            txn_amount: l.debit ?? l.credit ?? '0',
            fx_rate: '1',
            dimension_set_id: chart.emptySet,
            memo: opts.lineMemo ?? null,
          })),
        )
        .execute();
    }
    return entry.id;
  }

  return {
    tdb,
    db,
    tenantId,
    ...seeded,
    inTenant,
    insertEntry,
    addCompany,
    chart(company: string) {
      const c = charts.get(company);
      if (!c) throw new Error(`fixture: unknown company ${company}`);
      return c;
    },
    countEntries: () =>
      inTenant((trx) =>
        trx
          .selectFrom('app.journal_entry')
          .select(sql<number>`count(*)::int`.as('n'))
          .executeTakeFirstOrThrow(),
      ).then((r) => r.n),
    async close() {
      await db.destroy();
      await tdb.close();
    },
  };
}
