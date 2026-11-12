/**
 * ABA (Cemtex / BECS Direct Entry) writer against byte-exact expected files (T-0056, SS-UC06-06).
 * The expected files in fixtures/expected/ were derived field by field from the RQ-0006 record
 * tables (APCA BECS Procedures App. C2 via S1–S6), independently of this writer: type 0 header,
 * type 1 details, type 7 trailer, 120 characters per record, CRLF after every record by default.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeAba, type AbaFile } from './aba.ts';

const expected = (name: string) =>
  readFileSync(new URL(`../fixtures/expected/${name}`, import.meta.url));

const batch: AbaFile = {
  fiMnemonic: 'CBA',
  userName: 'LEDGERFORCE DEMO PTY LTD',
  apcaUserId: '301500',
  description: 'SUPPLIERS',
  processingDate: '2026-11-06',
  remitter: { bsb: '062000', accountNumber: '12345678', name: 'LEDGERFORCE DEMO PTY LTD' },
  lines: [
    {
      bsb: '082-001',
      accountNumber: '123456789',
      accountName: 'Acme Office Supplies Pty Ltd',
      amount: '1234.56',
      lodgementReference: 'INV-1001',
    },
    {
      bsb: '033123',
      accountNumber: '12-345-678',
      accountName: 'The Very Long Supplier Name Proprietary Limited',
      amount: '0.05',
      lodgementReference: 'A REFERENCE LONGER THAN 18',
    },
    {
      bsb: '062-000',
      accountNumber: '000123',
      accountName: 'Smith & Sons',
      amount: '10000.0000',
      lodgementReference: 'Ref (Nov) #3',
    },
  ],
};

describe('SS-UC06-06: ABA file is byte-exact', () => {
  it('SS-UC06-06 a three-payment supplier batch matches the expected file byte for byte (header, details, trailer totals, CRLF)', () => {
    const file = writeAba(batch);
    expect(Buffer.from(file, 'ascii')).toEqual(expected('supplier-batch.aba'));
    for (const line of file.split('\r\n').slice(0, -1)) expect(line).toHaveLength(120);
  });

  it('SS-UC06-06 the self-balancing variant adds one code-13 debit to the funding account and nets to zero', () => {
    const file = writeAba(batch, { selfBalancing: true, trailingCrlf: false });
    expect(Buffer.from(file, 'ascii')).toEqual(expected('supplier-batch-self-balanced.aba'));
  });
});
