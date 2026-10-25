/**
 * SS-PLAT-54 (unit) — CAMT batch entries, multi-statement files and camt.052/054 (T-0059,
 * RQ-0028, design §5.7, UC-08):
 *  - a booked batch entry whose TxDtls all carry an amount becomes one line per TxDtls, signed by
 *    its own CdtDbtInd (else the entry's), adding up exactly to the booked amount — or the file
 *    is refused; a batch without part amounts stays one line; pending batches stay out;
 *  - every Stmt of a file is read, each naming its own account;
 *  - camt.052 and camt.054 are recognised and refused with a reason;
 *  - duplicate keys stay deterministic and distinct for the parts.
 * Property: any split of an entry amount into k parts round-trips exactly, and a part that is
 * off by one cent is refused.
 */
import { Money } from '@ledgerforce/shared/money';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchStatementAccount, type AccountCandidate } from './account-match.ts';
import { dedupeKeys } from './dedupe.ts';
import { StatementImportError } from './errors.ts';
import {
  assertBalances,
  detectFormat,
  parseStatement,
  splitCamt053,
  StatementParseError,
  type StatementLine,
} from './parse.ts';

const AUD = 'AUD';
const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const plain = (lines: readonly StatementLine[]) => JSON.parse(JSON.stringify(lines)) as unknown;
const camt = (bytes: Uint8Array) => parseStatement(bytes, { format: 'camt053', currency: AUD });

const line = (
  postedOn: string,
  amount: string,
  description: string,
  reference: string | null,
  bankTxnId: string | null,
  batch?: { entryRef: string | null; part: number; parts: number },
) => ({
  postedOn,
  amount: { amount, currency: AUD },
  description,
  reference,
  bankTxnId,
  ...(batch ? { batch } : {}),
});

/** Written by hand from the fixture before the reader existed. */
const BATCH_EXPECTED = [
  line('2026-12-02', '1000.0000', 'BPAY Acme Pty Ltd INV-000130', 'INV-000130', 'BPAY-778201', {
    entryRef: '202612020001',
    part: 1,
    parts: 3,
  }),
  line('2026-12-02', '450.0000', 'BPAY Blue Cup Cafe INV-000131', 'INV-000131', null, {
    entryRef: '202612020001',
    part: 2,
    parts: 3,
  }),
  line('2026-12-02', '200.0000', 'BPAY Telstra refund', null, null, {
    entryRef: '202612020001',
    part: 3,
    parts: 3,
  }),
  line('2026-12-02', '-25.0000', 'Account fee', null, '202612020002'),
  // Parts without amounts: one line, the entry's own text, no single part's reference.
  line('2026-12-10', '-99.9000', 'Direct debits Telstra (2)', null, '202612100003'),
  line('2026-12-15', '-600.0000', 'Payment Office Rent Pty', 'PAY-0042', null, {
    entryRef: '202612150004',
    part: 1,
    parts: 2,
  }),
  line('2026-12-15', '100.0000', 'Returned payment Blue Cup Cafe', 'PAY-0043', null, {
    entryRef: '202612150004',
    part: 2,
    parts: 2,
  }),
];

/** One camt.053.001.08 statement around the given entries. */
const doc = (ntries: string, version = '08') =>
  Buffer.from(
    `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.${version}"><BkToCstmrStmt><Stmt><Acct><Id><Othr><Id>062000-12345678</Id></Othr></Id><Ccy>AUD</Ccy></Acct>${ntries}</Stmt></BkToCstmrStmt></Document>`,
  );
const part = (amt: string | null, ind: string | null, text: string, ccy = AUD) =>
  `<TxDtls>${amt === null ? '' : `<Amt Ccy="${ccy}">${amt}</Amt>`}${ind === null ? '' : `<CdtDbtInd>${ind}</CdtDbtInd>`}<RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls>`;
const batch = (amt: string, ind: string, parts: string, ref = 'E1') =>
  `<Ntry><Amt Ccy="AUD">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-12-02</Dt></BookgDt><AcctSvcrRef>${ref}</AcctSvcrRef><NtryDtls>${parts}</NtryDtls></Ntry>`;

describe('SS-PLAT-54: CAMT batch entries, multi-statement files and camt.052/054 (unit)', () => {
  describe('batch entries', () => {
    it('splits a booked batch into one line per TxDtls; pending batches stay out', () => {
      const s = camt(fixture('harbour-2026-12-batch.camt053.xml'));
      expect(plain(s.lines)).toEqual(BATCH_EXPECTED);
      expect(() => {
        assertBalances(s);
      }).not.toThrow();
      const bpay = s.lines.filter((l) => l.batch?.entryRef === '202612020001');
      expect(bpay).toHaveLength(3);
      expect(
        bpay.reduce((sum, l) => sum.add(l.amount), Money.zero(AUD)).equals(Money.of('1650', AUD)),
      ).toBe(true);
    });

    it('reads .001.02 part amounts from AmtDtls/TxAmt and takes the entry sign', () => {
      const [operating] = splitCamt053(fixture('harbour-2027-01-02-two-accounts.camt053.xml'));
      expect(plain(operating?.read(AUD).lines ?? [])).toEqual([
        line('2027-01-02', '120.0000', 'BPAY Acme Pty Ltd INV-000140', 'INV-000140', null, {
          entryRef: '202701020001',
          part: 1,
          parts: 2,
        }),
        line('2027-01-02', '180.0000', 'BPAY Blue Cup Cafe INV-000141', 'INV-000141', null, {
          entryRef: '202701020001',
          part: 2,
          parts: 2,
        }),
      ]);
    });

    it('refuses a batch whose parts do not add up to the booked amount, naming the entry', () => {
      const parts = part('1000.00', 'CRDT', 'a') + part('450.00', 'CRDT', 'b');
      expect(() => camt(doc(batch('1450.00', 'CRDT', parts)))).not.toThrow();
      for (const amt of ['1450.01', '1449.99']) {
        expect(() => camt(doc(batch(amt, 'CRDT', parts)))).toThrow(StatementParseError);
        expect(() => camt(doc(batch(amt, 'CRDT', parts)))).toThrow(
          /CAMT entry 1 \(E1\).*1450\.0000.*booked/,
        );
      }
      // Same total, wrong sign on one part: refused too.
      const flipped = part('1000.00', 'CRDT', 'a') + part('450.00', 'DBIT', 'b');
      expect(() => camt(doc(batch('1450.00', 'CRDT', flipped)))).toThrow(/add up/);
    });

    it('refuses a batch where only some parts carry an amount, or a part in another currency', () => {
      const some = part('1000.00', 'CRDT', 'a') + part(null, null, 'b');
      expect(() => camt(doc(batch('1450.00', 'CRDT', some)))).toThrow(
        /CAMT entry 1 \(E1\).*some.*amount/,
      );
      const nzd = part('1000.00', 'CRDT', 'a') + part('450.00', 'CRDT', 'b', 'NZD');
      expect(() => camt(doc(batch('1450.00', 'CRDT', nzd)))).toThrow(/NZD/);
      const bad = part('1000.00', 'CRDT', 'a') + part('450.00', 'XXXX', 'b');
      expect(() => camt(doc(batch('1450.00', 'CRDT', bad)))).toThrow(/CdtDbtInd/);
    });

    it('a single TxDtls stays one line with the booked amount, exactly as before (T-0058)', () => {
      const s = camt(doc(batch('12.00', 'DBIT', part(null, null, 'Fee'))));
      expect(plain(s.lines)).toEqual([line('2026-12-02', '-12.0000', 'Fee', null, 'E1')]);
    });

    it('collects TxDtls across repeated NtryDtls', () => {
      const ntry = batch('3.00', 'CRDT', part('1.00', 'CRDT', 'a')).replace(
        '</NtryDtls>',
        `</NtryDtls><NtryDtls>${part('2.00', 'CRDT', 'b')}</NtryDtls>`,
      );
      expect(camt(doc(ntry)).lines.map((l) => l.amount.toNumericString())).toEqual([
        '1.0000',
        '2.0000',
      ]);
    });
  });

  describe('several statements per file', () => {
    it('reads every Stmt with its own account, currency and lines', () => {
      const stmts = splitCamt053(fixture('harbour-2027-01-02-two-accounts.camt053.xml'));
      expect(stmts.map((s) => [s.index, s.accountRef, s.currency])).toEqual([
        [1, '062000-12345678', 'AUD'],
        [2, '062000-87654321', 'AUD'],
      ]);
      const savings = stmts[1]?.read(AUD);
      expect(plain(savings?.lines ?? [])).toEqual([
        line('2027-01-02', '-1000.0000', 'Transfer to Operating', null, '202701020101'),
        line('2027-01-02', '41.1000', 'Interest', null, '202701020102'),
      ]);
      expect(savings?.openingBalance?.toNumericString()).toBe('20000.0000');
      expect(savings?.closingBalance?.toNumericString()).toBe('19041.1000');
      for (const s of stmts) {
        const parsed = s.read(AUD);
        expect(() => {
          assertBalances(parsed);
        }).not.toThrow();
      }
    });

    it('the single-account reader refuses a file with several statements and says what to do', () => {
      expect(() => camt(fixture('harbour-2027-01-02-two-accounts.camt053.xml'))).toThrow(
        /2 statements.*company/,
      );
    });
  });

  describe('camt.052 and camt.054', () => {
    it('are recognised and refused with the reason, by detection and by the camt.053 reader', () => {
      const cases = [
        ['harbour-2027-01-04.camt052.xml', /camt\.052.*intraday.*camt\.053/],
        ['harbour-2027-01-04.camt054.xml', /camt\.054.*notification.*camt\.053/],
      ] as const;
      for (const [name, why] of cases) {
        const bytes = fixture(name);
        expect(() => detectFormat(bytes), name).toThrow(StatementParseError);
        expect(() => detectFormat(bytes), name).toThrow(why);
        expect(() => camt(bytes), name).toThrow(why);
        expect(() => splitCamt053(bytes), name).toThrow(why);
      }
    });

    it('another camt message is refused as not a statement', () => {
      const bytes = Buffer.from(
        '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.060.001.05"/>',
      );
      expect(() => detectFormat(bytes)).toThrow(/camt\.060.*not a camt\.053/);
    });
  });

  describe('which bank account a statement is for', () => {
    const acct = (id: string, bsb: string, last3: string, extra: Partial<AccountCandidate> = {}) => ({
      id,
      name: id,
      bsb,
      last3,
      currency: AUD,
      status: 'active',
      ...extra,
    });
    const ops = acct('operating', '062-000', '678');
    const sav = acct('savings', '062-000', '321');
    const other = acct('other-bank', '083-170', '678');
    const stmt = (accountRef: string | null, servicerId: string | null = null, currency = AUD) => ({
      index: 2,
      accountRef,
      servicerId,
      currency,
    });

    it('BSB and last 3 of the number pick the account; without a BSB the last 3 must be unique', () => {
      expect(matchStatementAccount(stmt('062000-12345678'), [ops, sav, other]).id).toBe('operating');
      expect(matchStatementAccount(stmt('083170 12345678'), [ops, sav, other]).id).toBe('other-bank');
      expect(matchStatementAccount(stmt('12345678', '083170'), [ops, sav, other]).id).toBe(
        'other-bank',
      );
      expect(matchStatementAccount(stmt('87654321'), [ops, sav, other]).id).toBe('savings');
      expect(() => matchStatementAccount(stmt('12345678'), [ops, sav, other])).toThrow(
        /statement 2 .*12345678.*more than one bank account.*operating.*other-bank/,
      );
    });

    it('refuses an unknown, archived or other-currency account and a statement naming none', () => {
      const cases: [ReturnType<typeof stmt>, AccountCandidate[], RegExp][] = [
        [stmt('999999-12345678'), [ops, sav], /statement 2 .*999999-12345678.*no bank account/],
        [stmt('062000-12345678'), [{ ...ops, status: 'archived' }], /no bank account/],
        [stmt('062000-12345678', null, 'USD'), [ops], /no bank account.*USD/],
        [stmt(null), [ops], /statement 2 names no account/],
      ];
      for (const [s, accounts, why] of cases) {
        expect(() => matchStatementAccount(s, accounts)).toThrow(StatementImportError);
        expect(() => matchStatementAccount(s, accounts)).toThrow(why);
      }
    });
  });

  describe('duplicate keys', () => {
    it('parts get keys distinct from each other and from an unsplit line, the same every time', () => {
      const lines = camt(fixture('harbour-2026-12-batch.camt053.xml')).lines;
      const keys = dedupeKeys(lines);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys[0]).toBe('id:BPAY-778201');
      expect(keys[1]).toMatch(/^h:[0-9a-f]{64}$/);
      expect(dedupeKeys(camt(fixture('harbour-2026-12-batch.camt053.xml')).lines)).toEqual(keys);
      const part2 = lines[1];
      if (!part2) throw new Error('fixture');
      const { batch: _b, ...unsplit } = part2;
      expect(dedupeKeys([unsplit])[0]).not.toBe(keys[1]);
      expect(dedupeKeys([{ ...part2, batch: { entryRef: 'OTHER', part: 2, parts: 3 } }])[0]).not.toBe(
        keys[1],
      );
    });
  });

  describe('properties', () => {
    const partsArb = fc.array(
      fc.record({
        cents: fc.bigInt({ min: 1n, max: 9_999_999_999n }),
        credit: fc.boolean(),
        text: fc.stringMatching(/^[A-Za-z0-9]{1,12}$/),
      }),
      { minLength: 2, maxLength: 6 },
    );
    const render = (ps: { cents: bigint; credit: boolean; text: string }[], skewCents = 0n) => {
      const signed = ps.map((p) => Money.fromMinorUnits(p.credit ? p.cents : -p.cents, AUD));
      const total = signed.reduce((a, b) => a.add(b), Money.zero(AUD));
      const entry = total.add(Money.fromMinorUnits(skewCents, AUD));
      const body = ps
        .map((p, i) =>
          part(
            Money.fromMinorUnits(p.cents, AUD).toNumericString(),
            p.credit ? 'CRDT' : 'DBIT',
            `${p.text}${String(i)}`,
          ),
        )
        .join('');
      const amt = entry.isNegative() ? entry.negate() : entry;
      return { signed, total, xml: doc(batch(amt.toNumericString(), entry.isNegative() ? 'DBIT' : 'CRDT', body)) };
    };

    it('any split of an entry into k parts gives k lines with those exact amounts, summing to the entry', () => {
      fc.assert(
        fc.property(partsArb, (ps) => {
          const { signed, total, xml } = render(ps);
          const lines = camt(xml).lines;
          expect(lines.map((l) => l.amount.toNumericString())).toEqual(
            signed.map((m) => m.toNumericString()),
          );
          expect(lines.reduce((a, l) => a.add(l.amount), Money.zero(AUD)).equals(total)).toBe(true);
          expect(lines.map((l) => l.batch?.part)).toEqual(ps.map((_, i) => i + 1));
          const keys = dedupeKeys(lines);
          expect(new Set(keys).size).toBe(keys.length);
          expect(dedupeKeys(camt(xml).lines)).toEqual(keys);
        }),
      );
    });

    it('a booked amount one cent off the parts is always refused', () => {
      fc.assert(
        fc.property(partsArb, fc.constantFrom(1n, -1n), (ps, skew) => {
          expect(() => camt(render(ps, skew).xml)).toThrow(/add up/);
        }),
      );
    });
  });
});
