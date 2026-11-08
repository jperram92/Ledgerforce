/**
 * SS-PLAT-02 — posted journal rows are immutable (T-0021, design §3.3 invariant 2, ADR-0004).
 * Two layers: lf_app has no privilege to change, delete, truncate or un-trigger ledger rows;
 * and triggers refuse the change even for the table owner (lf_migrator). The one permitted
 * change, posted → reversed, goes through app.journal_mark_reversed() only when a posted
 * reversal of the entry exists (ADR-0004 rule 1).
 */
import { createDb, withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markReversed } from './journal.ts';
import { createLedgerFixture, type LedgerFixture, type Line } from './testing/journal-fixture.ts';

let f: LedgerFixture;
/** The table owner: holds every privilege, so only the triggers stand in its way. */
let owner: Kysely<Database>;
let posted: string;

const sale: Line[] = [
  { code: '1200', debit: '110.0000' },
  { code: '4110', credit: '100.0000' },
  { code: '2310', credit: '10.0000' },
];
const reversalOfSale: Line[] = [
  { code: '1200', credit: '110.0000' },
  { code: '4110', debit: '100.0000' },
  { code: '2310', debit: '10.0000' },
];

const asApp = (q: (db: Kysely<Database>) => Promise<unknown>) => f.inTenant((trx) => q(trx));
const asOwner = (q: (db: Kysely<Database>) => Promise<unknown>) =>
  withTenant(owner, f.tenantId, (trx) => q(trx));
const status = (id: string) =>
  f
    .inTenant((trx) =>
      trx
        .selectFrom('app.journal_entry')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    )
    .then((r) => r.status);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-0000000006aa');
  owner = createDb(f.tdb.url('lf_migrator'), 2);
  posted = await f.inTenant((trx) => f.insertEntry(trx, sale, { memo: 'INV-0001' }));
});

afterAll(async () => {
  await owner.destroy();
  await f.close();
});

describe('SS-PLAT-02: Posted journal rows are immutable', () => {
  describe('lf_app has no privilege to change ledger rows', () => {
    it('UPDATE of a posted entry or its lines is refused', async () => {
      await expect(
        asApp((db) =>
          db
            .updateTable('app.journal_entry')
            .set({ memo: 'edited' })
            .where('id', '=', posted)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp((db) =>
          db
            .updateTable('app.journal_line')
            .set({ memo: 'edited' })
            .where('entry_id', '=', posted)
            .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('DELETE of a posted entry or its lines is refused', async () => {
      await expect(
        asApp((db) => db.deleteFrom('app.journal_line').where('entry_id', '=', posted).execute()),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        asApp((db) => db.deleteFrom('app.journal_entry').where('id', '=', posted).execute()),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('ALTER TABLE … DISABLE TRIGGER is refused (lf_app does not own the tables)', async () => {
      for (const table of ['app.journal_entry', 'app.journal_line', 'app.dimension_set']) {
        await expect(
          asApp((db) => sql`ALTER TABLE ${sql.raw(table)} DISABLE TRIGGER ALL`.execute(db)),
          table,
        ).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('TRUNCATE and session_replication_role (which skips triggers) are refused', async () => {
      await expect(asApp((db) => sql`TRUNCATE app.journal_line`.execute(db))).rejects.toMatchObject(
        { code: '42501' },
      );
      await expect(
        asApp((db) => sql`SET LOCAL session_replication_role = replica`.execute(db)),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('the rows are unchanged afterwards', async () => {
      const row = await f.inTenant((trx) =>
        trx
          .selectFrom('app.journal_entry')
          .select(['memo', 'status'])
          .where('id', '=', posted)
          .executeTakeFirstOrThrow(),
      );
      expect(row).toEqual({ memo: 'INV-0001', status: 'posted' });
      const lines = await f.inTenant((trx) =>
        trx
          .selectFrom('app.journal_line')
          .select(sql<number>`count(*)::int`.as('n'))
          .where('entry_id', '=', posted)
          .executeTakeFirstOrThrow(),
      );
      expect(lines.n).toBe(3);
    });
  });

  describe('triggers refuse the change even for the table owner', () => {
    it('UPDATE of a posted entry raises', async () => {
      await expect(
        asOwner((db) =>
          db
            .updateTable('app.journal_entry')
            .set({ memo: 'edited' })
            .where('id', '=', posted)
            .execute(),
        ),
      ).rejects.toThrow(/posted journal entry .* is immutable/);
    });

    it('UPDATE or DELETE of a posted entry’s line raises', async () => {
      await expect(
        asOwner((db) =>
          db
            .updateTable('app.journal_line')
            .set({ debit: '999.0000' })
            .where('entry_id', '=', posted)
            .where('line_no', '=', 1)
            .execute(),
        ),
      ).rejects.toThrow(/is immutable/);
      await expect(
        asOwner((db) => db.deleteFrom('app.journal_line').where('entry_id', '=', posted).execute()),
      ).rejects.toThrow(/is immutable/);
    });

    it('DELETE of a posted entry raises', async () => {
      await expect(
        asOwner((db) => db.deleteFrom('app.journal_entry').where('id', '=', posted).execute()),
      ).rejects.toThrow(/is immutable/);
    });

    it('TRUNCATE of the journal or dimension sets raises', async () => {
      for (const table of ['app.journal_line', 'app.journal_entry', 'app.dimension_set']) {
        await expect(
          asOwner((db) => sql`TRUNCATE ${sql.raw(table)} CASCADE`.execute(db)),
          table,
        ).rejects.toThrow(/cannot be truncated/);
      }
    });

    it('UPDATE or DELETE of a dimension set raises', async () => {
      await expect(
        asOwner((db) =>
          db
            .updateTable('app.dimension_set')
            .set({ primary1_value_id: null })
            .where('id', '=', f.emptySet)
            .execute(),
        ),
      ).rejects.toThrow(/dimension sets are immutable/);
      await expect(
        asOwner((db) => db.deleteFrom('app.dimension_set').where('id', '=', f.emptySet).execute()),
      ).rejects.toThrow(/dimension sets are immutable/);
    });
  });

  describe('the one permitted change: posted → reversed, through the posting-engine function', () => {
    it('refuses to mark an entry reversed without a posted reversal of it', async () => {
      const other = await f.inTenant((trx) => f.insertEntry(trx, sale));
      await expect(f.inTenant((trx) => markReversed(trx, posted, other))).rejects.toThrow(
        /is not a posted reversal of/,
      );
    });

    it('refuses a "reversal" whose lines do not mirror the original (sides swapped, same accounts)', async () => {
      const e = await f.inTenant((trx) => f.insertEntry(trx, sale));
      const partial: Line[] = [
        { code: '1200', credit: '100.0000' },
        { code: '4110', debit: '100.0000' },
      ];
      const bad = await f.inTenant((trx) => f.insertEntry(trx, partial, { reversalOf: e }));
      await expect(f.inTenant((trx) => markReversed(trx, e, bad))).rejects.toThrow(
        /does not mirror the lines of/,
      );
      expect(await status(e)).toBe('posted');
    });

    it('marks the original reversed once its reversal is posted, and nothing else changes', async () => {
      const before = await f.inTenant((trx) =>
        trx
          .selectFrom('app.journal_entry')
          .selectAll()
          .where('id', '=', posted)
          .executeTakeFirstOrThrow(),
      );
      await f.inTenant(async (trx) => {
        const reversal = await f.insertEntry(trx, reversalOfSale, { reversalOf: posted });
        await markReversed(trx, posted, reversal);
      });
      const after = await f.inTenant((trx) =>
        trx
          .selectFrom('app.journal_entry')
          .selectAll()
          .where('id', '=', posted)
          .executeTakeFirstOrThrow(),
      );
      expect(after).toEqual({ ...before, status: 'reversed' });
    });

    it('a reversed entry cannot be reversed again or changed', async () => {
      const second = await f.inTenant((trx) =>
        f.insertEntry(trx, reversalOfSale, { reversalOf: posted }),
      );
      await expect(f.inTenant((trx) => markReversed(trx, posted, second))).rejects.toThrow(
        /is not posted/,
      );
      await expect(
        asOwner((db) =>
          db.updateTable('app.journal_entry').set({ memo: 'x' }).where('id', '=', posted).execute(),
        ),
      ).rejects.toThrow(/is immutable/);
      expect(await status(posted)).toBe('reversed');
    });

    it('even the owner cannot mark an entry reversed when no posted reversal of it exists', async () => {
      const e = await f.inTenant((trx) => f.insertEntry(trx, sale));
      await expect(
        asOwner((db) =>
          db
            .updateTable('app.journal_entry')
            .set({ status: 'reversed' })
            .where('id', '=', e)
            .execute(),
        ),
      ).rejects.toThrow(/is immutable/);
      expect(await status(e)).toBe('posted');
    });

    it('even the owner cannot combine the status change with any other edit', async () => {
      const e = await f.inTenant((trx) => f.insertEntry(trx, sale));
      await f.inTenant((trx) => f.insertEntry(trx, reversalOfSale, { reversalOf: e }));
      await expect(
        asOwner((db) =>
          db
            .updateTable('app.journal_entry')
            .set({ status: 'reversed', memo: 'sneaky' })
            .where('id', '=', e)
            .execute(),
        ),
      ).rejects.toThrow(/is immutable/);
      expect(await status(e)).toBe('posted');
    });

    it('lf_app cannot call the function for another tenant’s entry (RLS inside SECURITY DEFINER)', async () => {
      const B = '01900000-0000-7000-8000-0000000006bb';
      await withTenant(f.db, B, (trx) =>
        trx.insertInto('app.tenant').values({ id: B, name: 'Other Pty Ltd' }).execute(),
      );
      const e = await f.inTenant((trx) => f.insertEntry(trx, sale));
      const r = await f.inTenant((trx) => f.insertEntry(trx, reversalOfSale, { reversalOf: e }));
      await expect(withTenant(f.db, B, (trx) => markReversed(trx, e, r))).rejects.toThrow(
        /unknown journal entry/,
      );
      expect(await status(e)).toBe('posted');
    });
  });
});
