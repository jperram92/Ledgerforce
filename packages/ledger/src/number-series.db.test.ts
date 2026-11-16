/**
 * Defining a document number series (T-0186, RQ-0167 finding 1, DL-0713, design §3.4).
 * SS-PLAT-131 (ledger layer): the invoice series is created with its prefix and width; the same
 * values again change nothing; prefix and width may change only while no number has been issued;
 * the next number is shown as app.next_document_number would issue it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineNumberSeries, nextNumber, NumberSeriesError, numberSeriesOf } from './numbering.ts';
import { createLedgerFixture, type LedgerFixture } from './testing/journal-fixture.ts';

let f: LedgerFixture;
let other: LedgerFixture;
const CODE = 'ar_invoice_document';

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000018601');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000018602');
}, 120_000);

afterAll(async () => {
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-131: defineNumberSeries (ledger)', () => {
  it('SS-PLAT-131 creates the series, then the same values change nothing [T-0186]', async () => {
    const first = await f.inTenant((trx) =>
      defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: 'INV-', padWidth: 5 }),
    );
    expect(first).toEqual({
      changed: true,
      series: {
        code: CODE,
        prefix: 'INV-',
        padWidth: 5,
        nextNumber: 'INV-00001',
        issued: false,
        status: 'active',
      },
    });
    const again = await f.inTenant((trx) =>
      defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: 'INV-', padWidth: 5 }),
    );
    expect(again.changed).toBe(false);
    expect(await f.inTenant((trx) => numberSeriesOf(trx, f.companyId, [CODE]))).toEqual([
      first.series,
    ]);
  });

  it('SS-PLAT-131 prefix and width change while unused, and are fixed once a number is issued [T-0186]', async () => {
    const changed = await f.inTenant((trx) =>
      defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: 'TI/', padWidth: 3 }),
    );
    expect(changed).toMatchObject({ changed: true, series: { nextNumber: 'TI/001' } });
    expect(await f.inTenant((trx) => nextNumber(trx, f.companyId, CODE))).toBe('TI/001');
    const [s] = await f.inTenant((trx) => numberSeriesOf(trx, f.companyId, [CODE]));
    expect(s).toMatchObject({ issued: true, nextNumber: 'TI/002' });
    const refused = await f
      .inTenant((trx) =>
        defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: 'X-', padWidth: 3 }),
      )
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NumberSeriesError);
    expect(refused).toMatchObject({ code: 'NUMBER_SERIES_IN_USE' });
    // The same values on an issued series are still a no-op, not a refusal.
    const same = await f.inTenant((trx) =>
      defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: 'TI/', padWidth: 3 }),
    );
    expect(same.changed).toBe(false);
  });

  it('SS-PLAT-131 refuses malformed input before touching the database [T-0186]', async () => {
    for (const bad of [
      { code: 'AR-INV', prefix: 'INV-', padWidth: 6 },
      { code: CODE, prefix: 'INV "x"', padWidth: 6 },
      { code: CODE, prefix: 'A'.repeat(21), padWidth: 6 },
      { code: CODE, prefix: 'INV-', padWidth: 0 },
      { code: CODE, prefix: 'INV-', padWidth: 19 },
      { code: CODE, prefix: 'INV-', padWidth: 2.5 },
    ]) {
      const e = await f
        .inTenant((trx) => defineNumberSeries(trx, { companyId: f.companyId, ...bad }))
        .catch((x: unknown) => x);
      expect(e, JSON.stringify(bad)).toMatchObject({ code: 'INVALID_NUMBER_SERIES' });
    }
  });

  it("SS-PLAT-131 another tenant's company is unknown [T-0186]", async () => {
    const e = await other
      .inTenant((trx) =>
        defineNumberSeries(trx, { companyId: f.companyId, code: CODE, prefix: '', padWidth: 6 }),
      )
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'UNKNOWN_COMPANY' });
    expect(await other.inTenant((trx) => numberSeriesOf(trx, f.companyId, [CODE]))).toEqual([]);
  });
});
