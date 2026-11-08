/**
 * Tax-report read API (T-0035, design §3.6, RQ-0102) against a real PostgreSQL as lf_app.
 *
 * SS-PLAT-114 (ledger side) — the BAS report reads the ledger only through these two functions:
 *   taxedLines         the posted (posted or reversed, never draft) journal lines that carry a
 *                      tax code, of one company, by entry-date range or by entry id, with the
 *                      account type and system role the tax module needs and, for a reversal,
 *                      the source type of the entry it reverses;
 *   allocationReleases every allocation (and allocation reversal) dated in a range, once per
 *                      side: the base amount it released from that side's open item, the entry
 *                      on the other side, and the total base original of the side's entry.
 * Both are reads: the database fingerprint does not change.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostingCommand, PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { allocate, reverseAllocation, subledgerEntriesOf } from './subledger.ts';
import { allocationReleases, taxedLines, type TaxedLine } from './tax-lines.ts';
import {
  createLedgerFixture,
  databaseFingerprint,
  type LedgerFixture,
} from './testing/journal-fixture.ts';

let f: LedgerFixture;
let acme: string;
const GST = '01900000-0000-7000-8000-0000000b0001';
const inT = <R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R> => f.inTenant(fn);
const A = (code: string) => ({ id: f.acct[code] ?? `missing ${code}` });

const postCmd = (
  sourceType: string,
  entryDate: string,
  lines: PostingLineInput[],
  companyId = f.companyId,
) =>
  inT((trx) =>
    post(trx, {
      companyId,
      idempotencyKey: randomUUID(),
      entryDate,
      sourceType,
      lines,
    } satisfies PostingCommand),
  ).then((r) => r.entryId);

const item = (entryId: string) =>
  inT((trx) => subledgerEntriesOf(trx, entryId)).then((items) => {
    const it0 = items[0];
    if (!it0) throw new Error(`no open item for ${entryId}`);
    return it0.id;
  });

let invoice: string;
let receipt: string;
let reversal: string;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-0000000035bb');
  await inT(async (trx) => {
    for (const company of [f.companyId, f.otherCompanyId]) {
      for (const st of ['ar_invoice', 'ar_receipt', 'manual_journal']) {
        await trx
          .insertInto('app.number_series')
          .values({ company_id: company, code: `je_${st}`, prefix: `${st.toUpperCase()}-` })
          .execute();
      }
    }
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: f.companyId, legal_name: 'Acme Pty Ltd' })
      .returning('id')
      .executeTakeFirstOrThrow();
    acme = p.id;
  });
  // GP-001 shape: INV dated 2026-11-05.
  invoice = await postCmd('ar_invoice', '2026-11-05', [
    { account: { role: 'AR_CONTROL' }, debit: '1375.00', partyId: acme },
    { account: A('4110'), credit: '1000.00', taxCodeId: GST, taxAmount: '100.00', partyId: acme },
    { account: A('4120'), credit: '250.00', taxCodeId: GST, taxAmount: '25.00', partyId: acme },
    { account: { role: 'GST_COLLECTED' }, credit: '125.00', taxCodeId: GST },
  ]);
  receipt = await postCmd('ar_receipt', '2026-11-15', [
    { account: A('1010'), debit: '1375.00' },
    { account: { role: 'AR_CONTROL' }, credit: '1375.00', partyId: acme },
  ]);
  // Excluded: another month, another company, a draft.
  await postCmd('manual_journal', '2026-12-02', [
    { account: A('6200'), debit: '100.00', taxCodeId: GST, taxAmount: '10.00' },
    { account: A('1010'), credit: '100.00' },
  ]);
  await inT((trx) =>
    post(trx, {
      companyId: f.otherCompanyId,
      idempotencyKey: randomUUID(),
      entryDate: '2026-11-06',
      sourceType: 'manual_journal',
      lines: [
        {
          account: { id: f.otherAcct['6200'] ?? '' },
          debit: '50.00',
          taxCodeId: GST,
          taxAmount: '5.00',
        },
        { account: { id: f.otherAcct['1010'] ?? '' }, credit: '50.00' },
      ],
    }),
  );
  await inT((trx) =>
    f.insertEntry(
      trx,
      [
        { code: '6200', debit: '10.00', taxCodeId: GST, taxAmount: '1.00' },
        { code: '1010', credit: '10.00' },
      ],
      { status: 'draft', entryDate: '2026-11-07' },
    ),
  );
  // A reversal of part of the invoice's lines (shape only; T-0032 builds the real path).
  reversal = await inT((trx) =>
    f.insertEntry(
      trx,
      [
        { code: '4110', debit: '100.00', taxCodeId: GST, taxAmount: '10.00' },
        { code: '2900', credit: '100.00' },
      ],
      { sourceType: 'ledger_reversal', reversalOf: invoice, entryDate: '2026-11-20' },
    ),
  );
});

afterAll(async () => {
  await f.close();
});

const view = (l: TaxedLine) =>
  [
    l.entryId === invoice ? 'INV' : l.entryId === reversal ? 'REV' : l.entryId,
    l.lineNo,
    l.entryDate,
    l.sourceType,
    l.classSourceType,
    l.accountType,
    l.systemRoles.join(','),
    l.debit,
    l.credit,
    l.taxCodeId === GST ? 'GST' : l.taxCodeId,
    l.taxAmount,
  ].join(' ');

describe('SS-PLAT-114 taxedLines — posted lines with a tax code', () => {
  it('returns the company’s posted taxed lines in the date range, nothing else', async () => {
    const lines = await inT((trx) =>
      taxedLines(trx, { companyId: f.companyId, from: '2026-11-01', to: '2026-11-30' }),
    );
    expect(lines.map(view)).toEqual([
      'INV 2 2026-11-05 ar_invoice ar_invoice revenue  0.0000 1000.0000 GST 100.0000',
      'INV 3 2026-11-05 ar_invoice ar_invoice revenue  0.0000 250.0000 GST 25.0000',
      'INV 4 2026-11-05 ar_invoice ar_invoice liability GST_COLLECTED 0.0000 125.0000 GST ',
      'REV 1 2026-11-20 ledger_reversal ar_invoice revenue  100.0000 0.0000 GST 10.0000',
    ]);
  });

  it('by entry id returns the entry’s taxed lines whatever their date', async () => {
    const lines = await inT((trx) =>
      taxedLines(trx, { companyId: f.companyId, entryIds: [invoice, receipt] }),
    );
    expect(lines.map((l) => `${String(l.lineNo)} ${l.credit}`)).toEqual([
      '2 1000.0000',
      '3 250.0000',
      '4 125.0000',
    ]);
    expect(await inT((trx) => taxedLines(trx, { companyId: f.companyId, entryIds: [] }))).toEqual(
      [],
    );
  });
});

describe('SS-PLAT-114 allocationReleases — base released per side, by allocation date', () => {
  it('reports each side of every allocation and allocation reversal dated in the range', async () => {
    const inv = await item(invoice);
    const rct = await item(receipt);
    const first = await inT((trx) =>
      allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        fromEntryId: rct,
        toEntryId: inv,
        amount: '1000.00',
        allocationDate: '2026-11-15',
      }),
    );
    await inT((trx) =>
      allocate(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        fromEntryId: rct,
        toEntryId: inv,
        amount: '375.00',
        allocationDate: '2026-12-03',
      }),
    );
    await inT((trx) =>
      reverseAllocation(trx, {
        companyId: f.companyId,
        idempotencyKey: randomUUID(),
        allocationId: first.allocationId,
        allocationDate: '2026-12-05',
      }),
    );
    const name = (id: string) => (id === invoice ? 'INV' : id === receipt ? 'RCT' : id);
    const show = (from: string, to: string) =>
      inT((trx) => allocationReleases(trx, { companyId: f.companyId, from, to })).then((rows) =>
        rows
          .map(
            (r) =>
              `${r.allocationDate} ${name(r.entryId)} ${r.classSourceType} <- ${name(r.counterEntryId)} ${r.counterClassSourceType} ${r.baseReleased}/${r.entryBaseOriginal}`,
          )
          .sort(),
      );
    expect(await show('2026-11-01', '2026-11-30')).toEqual([
      '2026-11-15 INV ar_invoice <- RCT ar_receipt 1000.0000/1375.0000',
      '2026-11-15 RCT ar_receipt <- INV ar_invoice 1000.0000/1375.0000',
    ]);
    expect(await show('2026-12-01', '2026-12-31')).toEqual([
      '2026-12-03 INV ar_invoice <- RCT ar_receipt 375.0000/1375.0000',
      '2026-12-03 RCT ar_receipt <- INV ar_invoice 375.0000/1375.0000',
      '2026-12-05 INV ar_invoice <- RCT ar_receipt -1000.0000/1375.0000',
      '2026-12-05 RCT ar_receipt <- INV ar_invoice -1000.0000/1375.0000',
    ]);
  });

  it('both reads write nothing', async () => {
    const before = await databaseFingerprint(f.admin);
    await inT((trx) =>
      taxedLines(trx, { companyId: f.companyId, from: '2026-01-01', to: '2027-12-31' }),
    );
    await inT((trx) =>
      allocationReleases(trx, { companyId: f.companyId, from: '2026-01-01', to: '2027-12-31' }),
    );
    expect(await databaseFingerprint(f.admin)).toEqual(before);
  });
});
