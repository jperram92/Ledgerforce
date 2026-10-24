/**
 * SS-PLAT-40 — statement parsers read what banks actually send and fail loudly on what they
 * cannot read (T-0058, RQ-0019): OFX dates keep the bank's day, OFX 1.x character sets, CAMT
 * statuses and balances, CSV quoting, amount styles and date orders, mapping validation, and
 * duplicate keys. Properties: rendering random lines as CSV or OFX and parsing them back gives
 * the same lines in the same order; duplicate keys are deterministic and unique within a file.
 */
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dedupeKeys } from './dedupe.ts';
import {
  assertBalances,
  detectFormat,
  parseStatement,
  StatementParseError,
  validateCsvMapping,
  type CsvMapping,
  type StatementLine,
} from './parse.ts';

const AUD = 'AUD';
const csv = (text: string, mapping: CsvMapping) =>
  parseStatement(Buffer.from(text, 'utf8'), { format: 'csv', currency: AUD, csv: mapping });
const ofx = (body: string) =>
  parseStatement(Buffer.from(`<OFX><CURDEF>AUD<BANKTRANLIST>${body}</BANKTRANLIST></OFX>`), {
    format: 'ofx',
    currency: AUD,
  });
const trn = (dt: string, amt: string, extra = '') =>
  `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>${dt}<TRNAMT>${amt}<FITID>X${dt}${amt}${extra}<NAME>N${extra}</STMTTRN>`;
const plain = (lines: readonly StatementLine[]) => JSON.parse(JSON.stringify(lines)) as unknown;

const SIGNED: CsvMapping = {
  header: false,
  dateFormat: 'YYYY-MM-DD',
  columns: { date: 0, amount: 1, description: [2] },
};

describe('SS-PLAT-40: statement parsers', () => {
  describe('OFX', () => {
    it('keeps the date as written, whatever the offset or time', () => {
      const s = ofx(
        trn('20261101003000.000[+11:AEDT]', '1.00', 'a') +
          trn('20261101233000[-5:EST]', '1.00', 'b') +
          trn('20261101', '1.00', 'c') +
          trn('20261101120000[+5.30:IST]', '1.00', 'd'),
      );
      expect(s.lines.map((l) => l.postedOn)).toEqual([
        '2026-11-01',
        '2026-11-01',
        '2026-11-01',
        '2026-11-01',
      ]);
    });

    it('rejects an impossible date and a malformed amount, naming the transaction', () => {
      expect(() => ofx(trn('20260231', '1.00'))).toThrow(StatementParseError);
      expect(() => ofx(trn('2026-11-01', '1.00'))).toThrow(/DTPOSTED/);
      expect(() => ofx(trn('20261101', '1.0.0'))).toThrow(/TRNAMT/);
      expect(() => ofx(trn('20261101', '1e3'))).toThrow(/TRNAMT/);
    });

    it('accepts a decimal comma and a leading plus sign', () => {
      const s = ofx(trn('20261101', '+1234,5', 'a') + trn('20261101', '-0,05', 'b'));
      expect(s.lines.map((l) => l.amount.toNumericString())).toEqual(['1234.5000', '-0.0500']);
    });

    it('decodes an OFX 1.x file in its declared CHARSET (1252) and entities', () => {
      const head = 'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n';
      const body = `<OFX><STMTRS><CURDEF>AUD<BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>-3.20<FITID>1<NAME>Café &lt;Nord&gt; &amp; Co</STMTTRN></BANKTRANLIST></STMTRS></OFX>`;
      const bytes = Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(body, 'latin1')]);
      const s = parseStatement(bytes, { format: 'ofx', currency: AUD });
      expect(s.lines[0]?.description).toBe('Café <Nord> & Co');
    });

    it('uses PAYEE/NAME when NAME is absent and CHECKNUM when REFNUM is absent', () => {
      const s = ofx(
        '<STMTTRN><DTPOSTED>20261101<TRNAMT>-5<FITID>9<CHECKNUM>1001<PAYEE><NAME>City Water</PAYEE></STMTTRN>',
      );
      expect(s.lines[0]).toMatchObject({ description: 'City Water', reference: '1001' });
    });

    it('refuses a file in another currency than the bank account', () => {
      expect(() =>
        parseStatement(Buffer.from('<OFX><CURDEF>USD<BANKTRANLIST></BANKTRANLIST></OFX>'), {
          format: 'ofx',
          currency: AUD,
        }),
      ).toThrow(/currency USD/);
    });

    it('refuses a file that is not OFX', () => {
      expect(() => parseStatement(Buffer.from('hello'), { format: 'ofx', currency: AUD })).toThrow(
        StatementParseError,
      );
    });
  });

  describe('CAMT.053', () => {
    const doc = (ntries: string, bal = '') =>
      Buffer.from(
        `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>AU00X</IBAN></Id></Acct>${bal}${ntries}</Stmt></BkToCstmrStmt></Document>`,
      );
    const ntry = (amt: string, ind: string, sts: string, extra = '') =>
      `<Ntry><Amt Ccy="AUD">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts>${sts}</Sts><BookgDt><Dt>2026-11-01</Dt></BookgDt>${extra}</Ntry>`;

    it('reads version .001.02 (status as text) and signs by CdtDbtInd', () => {
      const s = parseStatement(
        doc(
          ntry('5.00', 'DBIT', 'BOOK', '<AddtlNtryInf>Fee</AddtlNtryInf>') +
            ntry('7.00', 'CRDT', 'PDNG'),
        ),
        { format: 'camt053', currency: AUD },
      );
      expect(plain(s.lines)).toEqual([
        {
          postedOn: '2026-11-01',
          amount: { amount: '-5.0000', currency: 'AUD' },
          description: 'Fee',
          reference: null,
          bankTxnId: null,
        },
      ]);
      expect(s.accountRef).toBe('AU00X');
    });

    it('refuses an entry in another currency or with an unknown indicator', () => {
      expect(() =>
        parseStatement(doc(ntry('5.00', 'DBIT', 'BOOK').replace('AUD', 'NZD')), {
          format: 'camt053',
          currency: AUD,
        }),
      ).toThrow(/NZD/);
      expect(() =>
        parseStatement(doc(ntry('5.00', 'XXXX', 'BOOK')), { format: 'camt053', currency: AUD }),
      ).toThrow(/CdtDbtInd/);
    });

    it('reads a debit opening balance as negative', () => {
      const bal = `<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="AUD">10.00</Amt><CdtDbtInd>DBIT</CdtDbtInd></Bal>`;
      const s = parseStatement(doc('', bal), { format: 'camt053', currency: AUD });
      expect(s.openingBalance?.toNumericString()).toBe('-10.0000');
    });

    it('refuses a document that is not camt.053', () => {
      expect(() =>
        parseStatement(
          Buffer.from('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"/>'),
          { format: 'camt053', currency: AUD },
        ),
      ).toThrow(/camt\.053/);
    });
  });

  describe('balances', () => {
    it('opening + lines must equal closing when the file gives both', () => {
      const line = (a: string): StatementLine => ({
        postedOn: '2026-11-01',
        amount: Money.of(a, AUD),
        description: 'x',
        reference: null,
        bankTxnId: null,
      });
      const base = {
        format: 'camt053' as const,
        currency: AUD,
        accountRef: null,
        periodStart: null,
        periodEnd: null,
        lines: [line('10.00'), line('-2.50')],
      };
      expect(() =>
        assertBalances({
          ...base,
          openingBalance: Money.of('100', AUD),
          closingBalance: Money.of('107.50', AUD),
        }),
      ).not.toThrow();
      expect(() =>
        assertBalances({
          ...base,
          openingBalance: Money.of('100', AUD),
          closingBalance: Money.of('107.51', AUD),
        }),
      ).toThrow(/107\.5000.*107\.5100|107\.5100.*107\.5000/);
      expect(() =>
        assertBalances({ ...base, openingBalance: null, closingBalance: Money.of('1', AUD) }),
      ).not.toThrow();
    });
  });

  describe('CSV', () => {
    it('handles RFC 4180 quoting: commas, doubled quotes and line breaks inside fields', () => {
      const s = csv(
        '2026-11-01,-1.00,"Say ""hi"", then\nleave"\r\n2026-11-02,2.00,plain\n',
        SIGNED,
      );
      expect(s.lines.map((l) => l.description)).toEqual(['Say "hi", then leave', 'plain']);
    });

    it('reads signed amounts in the styles banks use', () => {
      const s = csv(
        [
          '2026-11-01,"1,234.56",a',
          '2026-11-01,(10.00),b',
          '2026-11-01,$-4.50,c',
          '2026-11-01,7.00 DR,d',
          '2026-11-01,7.00 CR,e',
          '2026-11-01,+0.0001,f',
        ].join('\n'),
        SIGNED,
      );
      expect(s.lines.map((l) => l.amount.toNumericString())).toEqual([
        '1234.5600',
        '-10.0000',
        '-4.5000',
        '-7.0000',
        '7.0000',
        '0.0001',
      ]);
    });

    it('rejects amounts it cannot read exactly, with the row number', () => {
      expect(() => csv('2026-11-01,1.00001,a', SIGNED)).toThrow(/row 1/);
      expect(() => csv('2026-11-01,abc,a', SIGNED)).toThrow(StatementParseError);
      expect(() => csv('2026-11-01,1e3,a', SIGNED)).toThrow(StatementParseError);
      expect(() => csv('2026-11-01,,a', SIGNED)).toThrow(/amount/);
    });

    it('reads the configured date order and rejects impossible dates', () => {
      const m = (dateFormat: CsvMapping['dateFormat']): CsvMapping => ({ ...SIGNED, dateFormat });
      expect(csv('03/11/2026,1,a', m('DD/MM/YYYY')).lines[0]?.postedOn).toBe('2026-11-03');
      expect(csv('11/03/2026,1,a', m('MM/DD/YYYY')).lines[0]?.postedOn).toBe('2026-11-03');
      expect(csv('20261103,1,a', m('YYYYMMDD')).lines[0]?.postedOn).toBe('2026-11-03');
      expect(csv('3/11/2026,1,a', m('DD/MM/YYYY')).lines[0]?.postedOn).toBe('2026-11-03');
      expect(() => csv('31/02/2026,1,a', m('DD/MM/YYYY'))).toThrow(/date/);
      expect(() => csv('2026-11-03,1,a', m('DD/MM/YYYY'))).toThrow(/date/);
    });

    it('debit/credit columns: debit is money out, credit money in; both filled is an error', () => {
      const m: CsvMapping = {
        header: true,
        dateFormat: 'YYYY-MM-DD',
        delimiter: ';',
        columns: { date: 'when', debit: 'out', credit: 'in', description: ['what', 'who'] },
      };
      const s = csv('When;Out;In;What;Who\n2026-11-01;5.00;;Fee;Bank\n2026-11-02;;9.00;Pay;\n', m);
      expect(s.lines.map((l) => [l.amount.toNumericString(), l.description])).toEqual([
        ['-5.0000', 'Fee Bank'],
        ['9.0000', 'Pay'],
      ]);
      expect(() => csv('When;Out;In;What;Who\n2026-11-01;5.00;1.00;Fee;Bank\n', m)).toThrow(/both/);
    });

    it('a missing header column is refused before any row is read', () => {
      const m: CsvMapping = { ...SIGNED, header: true, columns: { ...SIGNED.columns, date: 'D' } };
      expect(() => csv('X,Y,Z\n2026-11-01,1,a\n', { ...m, columns: { ...m.columns } })).toThrow(
        /column "D"/,
      );
    });

    it('skips blank lines', () => {
      expect(csv('\n2026-11-01,1,a\n\n', SIGNED).lines).toHaveLength(1);
    });

    it('validateCsvMapping accepts a stored mapping and rejects a broken one', () => {
      expect(validateCsvMapping(SIGNED)).toEqual(SIGNED);
      const bad: unknown[] = [
        null,
        { ...SIGNED, dateFormat: 'D/M/Y' },
        { ...SIGNED, columns: { date: 0, description: [2] } }, // no amount
        { ...SIGNED, columns: { date: 0, amount: 1, debit: 3, description: [2] } }, // both styles
        { ...SIGNED, columns: { date: 'Date', amount: 1, description: [2] } }, // name without header
        { ...SIGNED, columns: { date: 0, amount: 1, description: [] } },
        { ...SIGNED, delimiter: 'x' },
        { ...SIGNED, columns: { date: -1, amount: 1, description: [2] } },
      ];
      for (const b of bad) expect(() => validateCsvMapping(b), JSON.stringify(b)).toThrow();
    });
  });

  describe('format detection', () => {
    it('recognises OFX 1.x, OFX 2.x, CAMT.053 and falls back to CSV', () => {
      expect(detectFormat(Buffer.from('OFXHEADER:100\nDATA:OFXSGML\n<OFX>'))).toBe('ofx');
      expect(detectFormat(Buffer.from('<?xml version="1.0"?><?OFX OFXHEADER="200"?><OFX>'))).toBe(
        'ofx',
      );
      expect(
        detectFormat(
          Buffer.from('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">'),
        ),
      ).toBe('camt053');
      expect(detectFormat(Buffer.from('Date,Amount\n'))).toBe('csv');
    });
  });

  describe('duplicate keys', () => {
    const l = (description: string, bankTxnId: string | null = null): StatementLine => ({
      postedOn: '2026-11-03',
      amount: Money.of('-4.50', AUD),
      description,
      reference: null,
      bankTxnId,
    });

    it('bank id when given; else a hash of date, amount, description and occurrence', () => {
      const keys = dedupeKeys([l('Coffee'), l('Coffee'), l('Tea'), l('x', 'F1'), l('y', 'F1')]);
      expect(keys[0]).toMatch(/^h:[0-9a-f]{64}$/);
      expect(keys[1]).toMatch(/^h:[0-9a-f]{64}$/);
      expect(keys[0]).not.toBe(keys[1]); // two identical coffees are both real
      expect(keys[3]).toBe('id:F1');
      expect(keys[4]).toBe('id#2:F1'); // a reused bank id does not swallow a line
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('the reference does not change the key (a re-export may add or drop it)', () => {
      expect(dedupeKeys([{ ...l('Coffee'), reference: 'R1' }])).toEqual(dedupeKeys([l('Coffee')]));
    });
  });

  describe('properties', () => {
    const lineArb = fc.record({
      postedOn: fc
        .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z') })
        .map((d) => d.toISOString().slice(0, 10)),
      cents: fc.bigInt({ min: -99_999_999_999n, max: 99_999_999_999n }),
      description: fc
        .stringMatching(/^[A-Za-z0-9 ,.&'"/-]{1,40}$/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter((s) => s.length > 0),
      reference: fc.option(fc.stringMatching(/^[A-Za-z0-9-]{1,12}$/), { nil: null }),
      bankTxnId: fc.option(fc.stringMatching(/^[A-Za-z0-9]{1,16}$/), { nil: null }),
    });
    const toLine = (
      r: typeof lineArb extends fc.Arbitrary<infer T> ? T : never,
    ): StatementLine => ({
      postedOn: r.postedOn,
      amount: Money.fromMinorUnits(r.cents, AUD),
      description: r.description,
      reference: r.reference,
      bankTxnId: r.bankTxnId,
    });
    const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    it('CSV: render → parse gives the same lines in the same order', () => {
      const m: CsvMapping = {
        header: true,
        dateFormat: 'YYYY-MM-DD',
        columns: {
          date: 'Date',
          amount: 'Amount',
          description: ['Description'],
          reference: 'Ref',
          bankTxnId: 'Id',
        },
      };
      fc.assert(
        fc.property(fc.array(lineArb, { maxLength: 30 }), (rows) => {
          const lines = rows.map(toLine);
          const text = [
            'Date,Amount,Description,Ref,Id',
            ...lines.map((x) =>
              [
                x.postedOn,
                quote(x.amount.toNumericString()),
                quote(x.description),
                x.reference ?? '',
                x.bankTxnId ?? '',
              ].join(','),
            ),
          ].join('\r\n');
          expect(plain(csv(text, m).lines)).toEqual(plain(lines));
        }),
      );
    });

    it('OFX: render → parse gives the same lines in the same order', () => {
      fc.assert(
        fc.property(fc.array(lineArb, { maxLength: 30 }), (rows) => {
          const lines = rows.map(toLine);
          const body = lines
            .map(
              (x) =>
                `<STMTTRN><DTPOSTED>${x.postedOn.replace(/-/g, '')}120000[+10:AEST]<TRNAMT>${x.amount.toNumericString()}` +
                (x.bankTxnId ? `<FITID>${x.bankTxnId}` : '') +
                (x.reference ? `<REFNUM>${x.reference}` : '') +
                `<NAME>${xml(x.description)}</STMTTRN>`,
            )
            .join('\n');
          expect(plain(ofx(body).lines)).toEqual(plain(lines));
        }),
      );
    });

    it('duplicate keys: deterministic, unique within a file, and stable under re-import', () => {
      fc.assert(
        fc.property(fc.array(lineArb, { maxLength: 30 }), (rows) => {
          const lines = rows.map(toLine);
          const keys = dedupeKeys(lines);
          expect(new Set(keys).size).toBe(keys.length);
          expect(dedupeKeys(lines.map((x) => ({ ...x })))).toEqual(keys);
        }),
      );
    });
  });
});
