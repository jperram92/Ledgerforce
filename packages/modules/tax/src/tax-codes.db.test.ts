/**
 * Tax codes in the database (T-0118, design §3.4/§3.6, DL-0261), against a real PostgreSQL as
 * lf_app: per-company effective-dated codes seeded from AU_TAX_CODES, lookup by date, no
 * overlapping ranges per code, the company tax_rounding setting, and the posting engine
 * refusing a line whose tax code is another company's or not in force on the entry date.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { entrySeriesFor, post, reverse, storedSourceType } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AU_TAX_CODES, taxCodeOn } from './au-tax-codes.ts';
import { seedTaxCodes, taxCodeIdOn } from './tax-codes.ts';

let f: LedgerFixture;
let other = '';
let acme = '';

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000011801');
  other = await f.addCompany('Other Books Pty Ltd');
  await f.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_ar_invoice', prefix: 'TX-' })
      .execute();
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

describe('SS-PLAT-100: Tax codes per company, effective-dated, enforced by the engine (T-0118)', () => {
  it('SS-PLAT-100 seeds every AU code once per company; a second seed adds nothing', async () => {
    const first = await f.inTenant((trx) => seedTaxCodes(trx, f.companyId));
    expect(first).toBe(AU_TAX_CODES.length);
    expect(await f.inTenant((trx) => seedTaxCodes(trx, f.companyId))).toBe(0);
    expect(await f.inTenant((trx) => seedTaxCodes(trx, other))).toBe(AU_TAX_CODES.length);
  });

  it('SS-PLAT-100 looks a code up by date, consistent with the catalogue', async () => {
    const id = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2026-11-05'));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await f.inTenant((trx) =>
      trx
        .selectFrom('app.tax_code')
        .select(['code', 'rate', 'kind'])
        .where('id', '=', id ?? '')
        .executeTakeFirstOrThrow(),
    );
    expect(row.code).toBe('GST');
    expect(row.rate).toBe('0.10000000');
    expect(taxCodeOn('GST', '2026-11-05')?.kind).toBe(row.kind);
    expect(await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2000-06-30'))).toBe(
      undefined,
    );
  });

  it('SS-PLAT-100 refuses an overlapping effective range for the same code; a closed range can be followed', async () => {
    const overlap = await errorOf(
      f.inTenant((trx) =>
        trx
          .insertInto('app.tax_code')
          .values({
            company_id: f.companyId,
            code: 'GST',
            name: 'GST 12.5%',
            kind: 'taxable',
            rate: '0.125',
            effective_from: '2030-07-01',
          })
          .execute(),
      ),
    );
    expect(overlap?.message).toMatch(/overlap/);
    await f.inTenant(async (trx) => {
      await trx
        .updateTable('app.tax_code')
        .set({ effective_to: '2030-06-30' })
        .where('company_id', '=', f.companyId)
        .where('code', '=', 'GST')
        .execute();
      await trx
        .insertInto('app.tax_code')
        .values({
          company_id: f.companyId,
          code: 'GST',
          name: 'GST 12.5%',
          kind: 'taxable',
          rate: '0.125',
          effective_from: '2030-07-01',
        })
        .execute();
    });
    const later = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2030-07-01'));
    const earlier = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2030-06-30'));
    expect(later).toBeDefined();
    expect(later).not.toBe(earlier);
  });

  it('SS-PLAT-100 a tax code may name its own collected account, only from its own company', async () => {
    const gst = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2026-11-05'));
    const set = (account: string) =>
      f.inTenant((trx) =>
        trx
          .updateTable('app.tax_code')
          .set({ collected_account_id: account })
          .where('id', '=', gst ?? '')
          .execute(),
      );
    await set(f.acct['2310'] ?? '');
    const foreign = await f.inTenant((trx) =>
      trx
        .selectFrom('app.account')
        .select('id')
        .where('company_id', '=', other)
        .executeTakeFirst(),
    );
    const theirs = foreign?.id ?? randomUUID();
    expect((await errorOf(set(theirs)))?.message).toMatch(/foreign key/);
  });

  it('SS-PLAT-100 company tax_rounding defaults to total_invoice and accepts only the two rules', async () => {
    const c = await f.inTenant((trx) =>
      trx
        .selectFrom('app.company')
        .select('tax_rounding')
        .where('id', '=', f.companyId)
        .executeTakeFirstOrThrow(),
    );
    expect(c.tax_rounding).toBe('total_invoice');
    await f.inTenant((trx) =>
      trx
        .updateTable('app.company')
        .set({ tax_rounding: 'per_line_2dp' })
        .where('id', '=', other)
        .execute(),
    );
    const bad = await errorOf(
      f.inTenant((trx) =>
        sql`UPDATE app.company SET tax_rounding = 'per_bogus' WHERE id = ${other}`.execute(trx),
      ),
    );
    expect(bad?.message).toMatch(/tax_rounding|check/);
  });

  it('SS-PLAT-100 the engine refuses a tax code of another company, or one not in force on the entry date', async () => {
    const gstHere = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2026-11-05'));
    const gstOther = await f.inTenant((trx) => taxCodeIdOn(trx, other, 'GST', '2026-11-05'));
    const gst2030 = await f.inTenant((trx) => taxCodeIdOn(trx, f.companyId, 'GST', '2030-07-01'));
    const invoice = (taxCodeId: string | undefined) => ({
      companyId: f.companyId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-11-05',
      sourceType: 'ar_invoice',
      lines: [
        { account: { role: 'AR_CONTROL' }, debit: '110.00', partyId: acme },
        {
          account: { id: f.acct['4110'] ?? '' },
          credit: '100.00',
          ...(taxCodeId ? { taxCodeId, taxAmount: '10.00' } : {}),
        },
        { account: { role: 'GST_COLLECTED' }, credit: '10.00' },
      ],
    });
    const ok = await f.inTenant((trx) => post(trx, invoice(gstHere)));
    expect(ok.replayed).toBe(false);
    for (const wrong of [gstOther, gst2030]) {
      const err = await errorOf(f.inTenant((trx) => post(trx, invoice(wrong))));
      expect(err?.code).toBe('INVALID_TAX_CODE');
    }
  });

  it('SS-PLAT-100 a reversal keeps the tax code its original was taxed at, even after that code ended', async () => {
    await f.inTenant((trx) =>
      trx
        .insertInto('app.number_series')
        .values({
          company_id: f.companyId,
          code: entrySeriesFor(storedSourceType('ledger.reversal')),
          prefix: 'RV-',
        })
        .execute(),
    );
    const old = await f.inTenant((trx) =>
      trx
        .insertInto('app.tax_code')
        .values({
          company_id: f.companyId,
          code: 'OLD-GST',
          name: 'Ended code',
          kind: 'taxable',
          rate: '0.10',
          effective_from: '2026-01-01',
          effective_to: '2026-12-31',
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    const posted = await f.inTenant((trx) =>
      post(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        entryDate: '2026-11-05',
        sourceType: 'ar_invoice',
        lines: [
          { account: { role: 'AR_CONTROL' }, debit: '110.00', partyId: acme },
          {
            account: { id: f.acct['4110'] ?? '' },
            credit: '100.00',
            taxCodeId: old.id,
            taxAmount: '10.00',
          },
          { account: { role: 'GST_COLLECTED' }, credit: '10.00' },
        ],
      }),
    );
    const r = await f.inTenant((trx) =>
      reverse(trx, {
        companyId: f.companyId,
        entryId: posted.entryId,
        idempotencyKey: randomUUID(),
        entryDate: '2027-01-10',
      }),
    );
    expect(r.replayed).toBe(false);
  });
});
