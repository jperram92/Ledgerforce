/**
 * SS-PLAT-03 — the per-company hash chain detects tampering (T-0022, design §3.3 invariant 4,
 * ADR-0004 rule 5, canonical form v1 in ADR-0017 / RQ-0016).
 * Tampering is done as a superuser with triggers switched off (session_replication_role =
 * replica), which is exactly the attacker the chain exists for: someone who can bypass every
 * other protection. Each scenario uses its own company, so chains do not interfere.
 */
import { createDb, type Database } from '@ledgerforce/db';
import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { Money } from '@ledgerforce/shared/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalV1, readChain, verifyChain } from './hash-chain.ts';
import { markReversed } from './journal.ts';
import { createLedgerFixture, type LedgerFixture, type Line } from './testing/journal-fixture.ts';

let f: LedgerFixture;
let su: Kysely<Database>;

/** A GST sale of `units` × $10 net (exact, via Money). */
const sale = (units: number): Line[] => {
  const net = Money.of(10, 'AUD').mul(units, { scale: 4, rounding: 'half-up' });
  const gst = net.mul('0.1', { scale: 4, rounding: 'half-up' });
  return [
    { code: '1200', debit: net.add(gst).toNumericString() },
    { code: '4110', credit: net.toNumericString() },
    { code: '2310', credit: gst.toNumericString() },
  ];
};

/** Posts n entries, one transaction each (so each is chained at its own commit). */
async function postMany(company: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    ids.push(
      await f.inTenant((trx) =>
        f.insertEntry(trx, sale(i), { company, memo: `INV-${String(i).padStart(4, '0')}` }),
      ),
    );
  }
  return ids;
}

const verify = (company: string) => f.inTenant((trx) => verifyChain(trx, company));

/** Run SQL as superuser with every trigger switched off. */
const tamper = (statement: ReturnType<typeof sql>) =>
  su.transaction().execute(async (trx) => {
    await sql`SET LOCAL session_replication_role = replica`.execute(trx);
    await statement.execute(trx);
  });

const seqOf = (id: string) =>
  f.inTenant((trx) =>
    trx
      .selectFrom('app.journal_entry')
      .select(['chain_seq', 'prev_hash', 'hash'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-0000000007aa');
  su = createDb(f.tdb.url('superuser'), 2);
});

afterAll(async () => {
  await su.destroy();
  await f.close();
});

describe('SS-PLAT-03: Hash chain detects tampering', () => {
  it('100 posted entries form one chain (seq 1..100, each linked to the previous hash) that verifies', async () => {
    const company = await f.addCompany('Chain 100 Pty Ltd');
    const ids = await postMany(company, 100);
    const first = await seqOf(ids[0] ?? '');
    expect(first.chain_seq).toBe('1');
    expect(first.prev_hash).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    const second = await seqOf(ids[1] ?? '');
    expect(second.chain_seq).toBe('2');
    expect(second.prev_hash).toBe(first.hash);
    expect(await verify(company)).toEqual({ ok: true, entries: 100 });
  });

  it('a superuser altering one amount (kept balanced) is reported at that entry', async () => {
    const company = await f.addCompany('Tamper amount Pty Ltd');
    const ids = await postMany(company, 100);
    const victim = ids[36] ?? '';
    await tamper(
      sql`UPDATE app.journal_line SET debit = debit + 1000 WHERE entry_id = ${victim} AND line_no = 1`,
    );
    await tamper(
      sql`UPDATE app.journal_line SET credit = credit + 1000 WHERE entry_id = ${victim} AND line_no = 2`,
    );
    expect(await verify(company)).toEqual({
      ok: false,
      entries: 100,
      firstBroken: { chainSeq: '37', entryId: victim, reason: 'hash_mismatch' },
    });
  });

  it('a superuser altering a header field (memo) is reported at that entry', async () => {
    const company = await f.addCompany('Tamper memo Pty Ltd');
    const ids = await postMany(company, 20);
    const victim = ids[9] ?? '';
    await tamper(
      sql`UPDATE app.journal_entry SET memo = 'INV-0010 (adjusted)' WHERE id = ${victim}`,
    );
    expect(await verify(company)).toMatchObject({
      ok: false,
      firstBroken: { chainSeq: '10', entryId: victim, reason: 'hash_mismatch' },
    });
  });

  it('a superuser who re-hashes the altered entry breaks the next link instead', async () => {
    const company = await f.addCompany('Tamper rehash Pty Ltd');
    const ids = await postMany(company, 60);
    const victim = ids[49] ?? '';
    await tamper(sql`UPDATE app.journal_entry SET memo = 'rewritten' WHERE id = ${victim}`);
    await tamper(sql`
      UPDATE app.journal_entry e
         SET hash = encode(sha256(convert_to(app.journal_canonical_v1(e.tenant_id, e.id, e.chain_seq, e.prev_hash), 'UTF8')), 'hex')
       WHERE e.id = ${victim}`);
    expect(await verify(company)).toMatchObject({
      ok: false,
      firstBroken: { chainSeq: '51', entryId: ids[50], reason: 'prev_hash_mismatch' },
    });
  });

  it('a superuser deleting an entry leaves a sequence gap; deleting the last one mismatches the head', async () => {
    const company = await f.addCompany('Tamper delete Pty Ltd');
    const ids = await postMany(company, 30);
    await tamper(sql`DELETE FROM app.journal_line WHERE entry_id = ${ids[19] ?? ''}`);
    await tamper(sql`DELETE FROM app.journal_entry WHERE id = ${ids[19] ?? ''}`);
    expect(await verify(company)).toMatchObject({
      ok: false,
      firstBroken: { chainSeq: '21', entryId: ids[20], reason: 'sequence_gap' },
    });

    const company2 = await f.addCompany('Tamper tail Pty Ltd');
    const ids2 = await postMany(company2, 5);
    await tamper(sql`DELETE FROM app.journal_line WHERE entry_id = ${ids2[4] ?? ''}`);
    await tamper(sql`DELETE FROM app.journal_entry WHERE id = ${ids2[4] ?? ''}`);
    expect(await verify(company2)).toMatchObject({
      ok: false,
      firstBroken: { chainSeq: '5', entryId: null, reason: 'head_mismatch' },
    });
  });

  it('concurrent posting in one company still yields a single linear chain', async () => {
    const company = await f.addCompany('Concurrent Pty Ltd');
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        f.inTenant((trx) => f.insertEntry(trx, sale(1 + i), { company })),
      ),
    );
    const chain = await f.inTenant((trx) => readChain(trx, company));
    expect(chain.entries.map((e) => e.chain_seq)).toEqual(
      Array.from({ length: 24 }, (_, i) => String(i + 1)),
    );
    expect(await verify(company)).toEqual({ ok: true, entries: 24 });
  });

  it('a reversal (the one permitted change, status → reversed) keeps the chain valid', async () => {
    const company = await f.addCompany('Reversal Pty Ltd');
    const [original] = await postMany(company, 3);
    const lines = sale(1).map((l) => ({ code: l.code, debit: l.credit, credit: l.debit }) as Line);
    await f.inTenant(async (trx) => {
      const reversal = await f.insertEntry(trx, lines, { company, reversalOf: original ?? '' });
      await markReversed(trx, original ?? '', reversal);
    });
    expect(await verify(company)).toEqual({ ok: true, entries: 4 });
  });

  it('the application cannot choose a hash, and lines cannot be added to a chained entry', async () => {
    const company = await f.addCompany('Forgery Pty Ltd');
    await expect(
      f.inTenant(async (trx) => {
        const id = await f.insertEntry(trx, sale(1), { company });
        await sql`UPDATE app.journal_entry SET hash = ${'a'.repeat(64)} WHERE id = ${id}`.execute(
          trx,
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      f.inTenant((trx) =>
        trx
          .insertInto('app.journal_entry')
          .values({
            company_id: company,
            entry_date: '2026-10-24',
            source_type: 'manual_journal',
            status: 'posted',
            idempotency_key: 'forged-hash',
            posted_at: new Date(),
            // Deliberately outside the type: proves the database, not the compiler, refuses it.
            hash: sql<null>`${'a'.repeat(64)}`,
          })
          .execute(),
      ),
    ).rejects.toThrow(/set by the database/);
    const [chained] = await postMany(company, 1);
    const { acct, emptySet } = f.chart(company);
    await expect(
      f.inTenant(async (trx) => {
        const extra = [
          { code: '6200', debit: '1.0000' },
          { code: '1010', credit: '1.0000' },
        ];
        await trx
          .insertInto('app.journal_line')
          .values(
            extra.map((l, i) => ({
              company_id: company,
              entry_id: chained ?? '',
              line_no: 10 + i,
              account_id: acct[l.code] ?? '',
              debit: l.debit ?? '0',
              credit: l.credit ?? '0',
              txn_currency: 'AUD',
              txn_amount: '1.0000',
              fx_rate: '1',
              dimension_set_id: emptySet,
            })),
          )
          .execute();
      }),
    ).rejects.toThrow(/is chained/);
  });

  it('draft entries are not chained', async () => {
    const company = await f.addCompany('Draft Pty Ltd');
    const id = await f.inTenant((trx) => f.insertEntry(trx, sale(1), { company, status: 'draft' }));
    expect(await seqOf(id)).toEqual({ chain_seq: null, prev_hash: null, hash: null });
    expect(await verify(company)).toEqual({ ok: true, entries: 0 });
  });

  it('property: the TypeScript canonical form equals the SQL one for any content', async () => {
    const company = await f.addCompany('Canonical Pty Ltd');
    let n = 0;
    // PostgreSQL text cannot hold U+0000; everything else (control chars, astral, combining) is fair game.
    const text = fc
      .string({ unit: 'grapheme', maxLength: 40 })
      .filter((s) => !s.includes('\u0000'));
    const ctrl = fc.string({
      unit: fc.constantFrom('\n', '\t', '\r', ',', ':', '~', '\\', '"', 'é', '😀', '\u001f', ' '),
      maxLength: 12,
    });
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.oneof(text, ctrl)),
        fc.option(text),
        fc.option(fc.oneof(text, ctrl)),
        fc.integer({ min: 1, max: 99_999 }),
        async (memo, entryNo, lineMemo, cents) => {
          await f.inTenant((trx) =>
            f.insertEntry(trx, sale(cents), {
              company,
              ...(memo === null ? {} : { memo }),
              ...(entryNo === null ? {} : { entryNo: `${entryNo}#${String((n += 1))}` }),
              ...(lineMemo === null ? {} : { lineMemo }),
            }),
          );
          const chain = await f.inTenant((trx) => readChain(trx, company));
          const last = chain.entries[chain.entries.length - 1];
          if (!last) throw new Error('no entry read back');
          const fromSql = await f.inTenant((trx) =>
            sql<{
              c: string;
            }>`SELECT app.journal_canonical_v1(tenant_id, id, chain_seq, prev_hash) AS c
                               FROM app.journal_entry WHERE id = ${last.id}`.execute(trx),
          );
          expect(canonicalV1(last, chain.lines.get(last.id) ?? [])).toBe(fromSql.rows[0]?.c);
        },
      ),
      { numRuns: 40 },
    );
    expect(await verify(company)).toMatchObject({ ok: true });
  });
});

describe('canonical form v1 is pinned (a change needs lf-journal-v2 and a new ADR)', () => {
  it('matches a fixed reference string and hash', async () => {
    const { createHash } = await import('node:crypto');
    const entry = {
      id: '01900000-0000-7000-8000-00000000e001',
      tenant_id: '01900000-0000-7000-8000-0000000007aa',
      company_id: '01900000-0000-7000-8000-00000000c001',
      chain_seq: '1',
      prev_hash: null,
      hash: null,
      entry_no: 'JNL-000001',
      entry_date: '2026-10-24',
      period_id: null,
      source_type: 'manual_journal',
      source_id: null,
      reversal_of_id: null,
      idempotency_key: 'k1',
      memo: 'Café ☕',
      created_by: null,
      approved_by: null,
      posted_at: '2026-10-24T09:00:00.000000Z',
    };
    const line = {
      line_no: '1',
      account_id: '01900000-0000-7000-8000-00000000a001',
      debit: '110.0000',
      credit: '0.0000',
      txn_currency: 'AUD',
      txn_amount: '110.0000',
      fx_rate: '1.00000000',
      tax_code_id: null,
      tax_amount: null,
      dimension_set_id: '01900000-0000-7000-8000-00000000d001',
      party_id: null,
      memo: null,
    };
    const c = canonicalV1(entry, [line]);
    expect(c).toBe(
      '13:lf-journal-v1,' +
        '36:01900000-0000-7000-8000-0000000007aa,36:01900000-0000-7000-8000-00000000c001,' +
        '36:01900000-0000-7000-8000-00000000e001,1:1,~10:JNL-000001,10:2026-10-24,~' +
        '14:manual_journal,~~2:k1,9:Café ☕,~~27:2026-10-24T09:00:00.000000Z,1:1,' +
        '1:1,36:01900000-0000-7000-8000-00000000a001,8:110.0000,6:0.0000,3:AUD,8:110.0000,' +
        '10:1.00000000,~~36:01900000-0000-7000-8000-00000000d001,~~',
    );
    expect(createHash('sha256').update(c, 'utf8').digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
