/**
 * ABA writer field rules (T-0056, RQ-0006): padding, truncation and the validation that stops a
 * file the bank would reject (or that would pay the wrong account) from ever being written.
 */
import { describe, expect, it } from 'vitest';
import { AbaFormatError, toBecs, writeAba, type AbaFile, type AbaLine } from './aba.ts';

const line = (over: Partial<AbaLine> = {}): AbaLine => ({
  bsb: '062-000',
  accountNumber: '12345678',
  accountName: 'Payee',
  amount: '1.00',
  lodgementReference: 'REF',
  ...over,
});
const file = (over: Partial<AbaFile> = {}, lines: AbaLine[] = [line()]): AbaFile => ({
  fiMnemonic: 'NAB',
  userName: 'USER',
  apcaUserId: '123456',
  description: 'PAYMENTS',
  processingDate: '2026-01-31',
  remitter: { bsb: '083-001', accountNumber: '987654', name: 'REMITTER' },
  lines,
  ...over,
});
const records = (f: AbaFile) => writeAba(f).split('\r\n');
const refused = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(AbaFormatError);
    return (e as Error).message;
  }
  throw new Error('expected an AbaFormatError');
};

describe('ABA layout', () => {
  it('writes one header, one detail per line and one trailer, each 120 characters, CRLF-terminated', () => {
    const out = writeAba(file());
    expect(out.endsWith('\r\n')).toBe(true);
    const r = out.split('\r\n');
    expect(r).toHaveLength(4);
    expect(r[3]).toBe('');
    expect(r.slice(0, 3).map((x) => [x[0], x.length])).toEqual([
      ['0', 120],
      ['1', 120],
      ['7', 120],
    ]);
  });

  it('formats the processing date DDMMYY and zero-fills the APCA user id', () => {
    const h = records(file())[0] ?? '';
    expect(h.slice(74, 80)).toBe('310126');
    expect(h.slice(56, 62)).toBe('123456');
    expect(h.slice(20, 23)).toBe('NAB');
  });

  it('right-justifies account numbers with spaces and amounts with zeros', () => {
    const d = records(file({}, [line({ accountNumber: '42', amount: '7.5' })]))[1] ?? '';
    expect(d.slice(8, 17)).toBe('       42');
    expect(d.slice(20, 30)).toBe('0000000750');
    expect(d.slice(18, 20)).toBe('50');
  });

  it('uses the transaction code given on the line (53 for net pay)', () => {
    const d = records(file({}, [line({ transactionCode: '53' })]))[1] ?? '';
    expect(d.slice(18, 20)).toBe('53');
  });

  it('truncates text fields to their width and left-justifies them', () => {
    const d =
      records(
        file({}, [line({ accountName: 'X'.repeat(40), lodgementReference: 'Y'.repeat(30) })]),
      )[1] ?? '';
    expect(d.slice(30, 62)).toBe('X'.repeat(32));
    expect(d.slice(62, 80)).toBe('Y'.repeat(18));
  });

  it('totals credits in the trailer and counts the detail records', () => {
    const t =
      records(file({}, [line({ amount: '1.01' }), line({ amount: '2.02' }), line()]))[4] ?? '';
    expect(t.slice(0, 8)).toBe('7999-999');
    expect(t.slice(20, 50)).toBe('000000040300000004030000000000');
    expect(t.slice(74, 80)).toBe('000003');
  });
});

describe('ABA validation', () => {
  it('rejects characters outside the BECS set', () => {
    expect(refused(() => writeAba(file({}, [line({ accountName: 'Pipe | Co' })])))).toMatch(
      /account name/,
    );
    expect(refused(() => writeAba(file({}, [line({ lodgementReference: 'a\nb' })])))).toMatch(
      /lodgement reference/,
    );
    expect(refused(() => writeAba(file({ userName: 'Café' })))).toMatch(/user name/);
  });

  it('rejects an account number longer than 9 characters even without its hyphens', () => {
    expect(refused(() => writeAba(file({}, [line({ accountNumber: '1234567890' })])))).toMatch(
      /account number/,
    );
    // Hyphens are dropped only when needed to fit (RQ-0006).
    const d = records(file({}, [line({ accountNumber: '12-3456-789' })]))[1] ?? '';
    expect(d.slice(8, 17)).toBe('123456789');
    const kept = records(file({}, [line({ accountNumber: '12-345' })]))[1] ?? '';
    expect(kept.slice(8, 17)).toBe('   12-345');
    expect(refused(() => writeAba(file({}, [line({ accountNumber: '' })])))).toMatch(
      /account number/,
    );
  });

  it('rejects a malformed BSB, APCA user id, FI mnemonic or date', () => {
    expect(refused(() => writeAba(file({}, [line({ bsb: '06200' })])))).toMatch(/BSB/);
    expect(refused(() => writeAba(file({ apcaUserId: '12345' })))).toMatch(/APCA/);
    expect(refused(() => writeAba(file({ fiMnemonic: 'cba' })))).toMatch(/mnemonic/);
    expect(refused(() => writeAba(file({ processingDate: '2026-02-30' })))).toMatch(/date/);
  });

  it('rejects zero, negative, sub-cent and over-width amounts', () => {
    for (const amount of ['0', '-1.00', '1.005', '100000000.00', 'abc']) {
      expect(refused(() => writeAba(file({}, [line({ amount })])))).toMatch(/amount/);
    }
    expect(records(file({}, [line({ amount: '99999999.99' })]))[1]?.slice(20, 30)).toBe(
      '9999999999',
    );
  });

  it('rejects an empty batch, more lines than the bank accepts, and totals over 10 digits', () => {
    expect(refused(() => writeAba(file({}, [])))).toMatch(/at least one/);
    expect(refused(() => writeAba(file({}, [line(), line()]), { maxDetailRecords: 1 }))).toMatch(
      /at most 1/,
    );
    expect(
      refused(() =>
        writeAba(file({}, [line({ amount: '99999999.99' }), line({ amount: '0.01' })])),
      ),
    ).toMatch(/total/);
  });
});

describe('toBecs', () => {
  it('transliterates accents and replaces other characters with spaces', () => {
    expect(toBecs('Café Noël & Sons')).toBe('Cafe Noel & Sons');
    expect(toBecs('A|B  "C"\nD')).toBe('A B C D');
  });
});
