/**
 * SS-UC08-01 — the same 10 transactions as CSV, OFX (1.x SGML and 2.x XML) and CAMT.053
 * normalise to identical statement lines (T-0058, design §5.7, RQ-0019). Contract test over the
 * fixtures in ../fixtures: the files are what a bank would send; the expected lines are written
 * out by hand below, before the parsers existed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dedupeKeys } from './dedupe.ts';
import {
  parseStatement,
  validateCsvMapping,
  type CsvMapping,
  type ParsedStatement,
} from './parse.ts';

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

/** How Harbour & Co's bank lays out its CSV export (configuration, not code), validated. */
const HARBOUR_CSV: CsvMapping = validateCsvMapping(
  JSON.parse(fixture('harbour-csv-mapping.json').toString('utf8')),
);

const EXPECTED = [
  ['2026-11-02', '1375.0000', 'Direct credit Acme Pty Ltd', 'INV-000123', '202611020001'],
  ['2026-11-02', '-10.0000', 'Account fee', null, '202611020002'],
  ['2026-11-03', '-4.5000', 'Card purchase Blue Cup Cafe', null, '202611030003'],
  ['2026-11-03', '-4.5000', 'Card purchase Blue Cup Cafe', null, '202611030004'],
  ['2026-11-05', '-2200.0000', 'BPAY Office Rent Pty', 'RENT-NOV', '202611050005'],
  ['2026-11-10', '550.5500', 'Stripe payout', 'po_1Q2w3E', '202611100006'],
  ['2026-11-15', '-1234.5600', 'Transfer to ATO', 'PAYG-1125', '202611150007'],
  ['2026-11-20', '12.3400', 'Interest', null, '202611200008'],
  ['2026-11-28', '-89.9000', 'Telstra direct debit November, mobile', 'TLS-889', '202611280009'],
  ['2026-11-30', '10000.0000', 'Deposit Harbour & Co Pty Ltd', 'CAP-01', '202611300010'],
].map(([postedOn, amount, description, reference, bankTxnId]) => ({
  postedOn,
  amount: { amount, currency: 'AUD' },
  description,
  reference,
  bankTxnId,
}));

const asPlain = (s: ParsedStatement) => JSON.parse(JSON.stringify(s.lines)) as unknown;

const parsed = {
  csv: parseStatement(fixture('harbour-2026-11.csv'), {
    format: 'csv',
    currency: 'AUD',
    csv: HARBOUR_CSV,
  }),
  ofx1: parseStatement(fixture('harbour-2026-11.ofx'), { format: 'ofx', currency: 'AUD' }),
  ofx2: parseStatement(fixture('harbour-2026-11.v2.ofx'), { format: 'ofx', currency: 'AUD' }),
  camt: parseStatement(fixture('harbour-2026-11.camt053.xml'), {
    format: 'camt053',
    currency: 'AUD',
  }),
};

describe('SS-UC08-01: CSV, OFX and CAMT.053 normalise identically', () => {
  it.each(Object.keys(parsed))('%s gives the 10 expected lines, in file order', (k) => {
    expect(asPlain(parsed[k as keyof typeof parsed])).toEqual(EXPECTED);
  });

  it('all four files give identical normalised lines and identical duplicate keys', () => {
    const [first, ...rest] = Object.values(parsed);
    for (const other of rest) {
      expect(asPlain(other)).toEqual(asPlain(first as ParsedStatement));
      expect(dedupeKeys(other.lines)).toEqual(dedupeKeys((first as ParsedStatement).lines));
    }
  });

  it('keeps the posting date the bank wrote: 00:30 at +11:00 is still 2 November', () => {
    for (const s of [parsed.ofx1, parsed.ofx2, parsed.camt]) {
      expect(s.lines[0]?.postedOn).toBe('2026-11-02');
    }
  });

  it('reads the statement header: account, currency and balances where the format has them', () => {
    expect(parsed.ofx1).toMatchObject({ format: 'ofx', currency: 'AUD', accountRef: '12345678' });
    expect(parsed.ofx2).toMatchObject({ format: 'ofx', currency: 'AUD', accountRef: '12345678' });
    expect(parsed.camt).toMatchObject({
      format: 'camt053',
      currency: 'AUD',
      accountRef: '062000-12345678',
    });
    expect(parsed.csv).toMatchObject({ format: 'csv', currency: null, accountRef: null });
    expect(parsed.ofx1.closingBalance?.toNumericString()).toBe('13394.4300');
    expect(parsed.ofx1.openingBalance).toBeNull();
    expect(parsed.camt.openingBalance?.toNumericString()).toBe('5000.0000');
    expect(parsed.camt.closingBalance?.toNumericString()).toBe('13394.4300');
    expect(parsed.ofx1.periodStart).toBe('2026-11-01');
    expect(parsed.ofx1.periodEnd).toBe('2026-11-30');
  });

  it('CAMT.053 imports booked entries only (the pending entry is left out)', () => {
    const raw = fixture('harbour-2026-11.camt053.xml').toString('utf8');
    expect(raw).toContain('<Cd>PDNG</Cd>');
    expect(parsed.camt.lines.map((l) => l.description)).not.toContain('Pending card authorisation');
  });
});
