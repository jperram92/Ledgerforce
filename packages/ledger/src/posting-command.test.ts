/**
 * Posting command boundary (T-0025, design §3.9 step 1, DL-0074). Every refusal here happens
 * before any SQL: post() gets a transaction that throws on first use.
 */
import { describe, expect, it } from 'vitest';
import {
  PostingError,
  checkCommand,
  controlAccountAccepts,
  entrySeriesFor,
  type PostingCommand,
  type PostingLineInput,
} from './posting-command.ts';
import { post, preview } from './posting-engine.ts';
import { untouchableTrx } from './testing/untouchable-trx.ts';

const COMPANY = '01900000-0000-7000-8000-00000000c001';
const BANK = '01900000-0000-7000-8000-00000000a001';

const cmd = (lines: PostingLineInput[], over: Partial<PostingCommand> = {}): PostingCommand => ({
  companyId: COMPANY,
  idempotencyKey: 'key-1',
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines,
  ...over,
});

const ok: PostingLineInput[] = [
  { account: { role: 'SUSPENSE' }, debit: '100.0000' },
  { account: { id: BANK }, credit: '100.0000' },
];

/** post() must reject with `code` and never touch the database. */
async function refusedBeforeSql(command: PostingCommand, code: string, line?: number) {
  const { trx, touched } = untouchableTrx();
  const err = await post(trx, command).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PostingError);
  expect((err as PostingError).code).toBe(code);
  if (line !== undefined) expect((err as PostingError).line).toBe(line);
  expect(touched).toEqual([]);
  const p = untouchableTrx();
  await expect(preview(p.trx, command)).rejects.toMatchObject({ code });
  expect(p.touched).toEqual([]);
}

describe('AC-1 decimals are refused at the command boundary, before writing [T-0025]', () => {
  it('AC-1 refuses a base amount with more than 4 decimal places [T-0025]', async () => {
    await refusedBeforeSql(
      cmd([
        { account: { role: 'SUSPENSE' }, debit: '100.00005' },
        { account: { id: BANK }, credit: '100.00005' },
      ]),
      'AMOUNT_SCALE',
      1,
    );
    const err = (() => {
      try {
        checkCommand(
          cmd([
            { account: { role: 'SUSPENSE' }, debit: '1.00001' },
            { account: { id: BANK }, credit: '1.00001' },
          ]),
        );
      } catch (e) {
        return e as PostingError;
      }
      return undefined;
    })();
    expect(err?.message).toMatch(/1\.00001.*more than 4 decimal places/);
  });

  it('AC-1 refuses transaction and tax amounts with more than 4 decimal places [T-0025]', async () => {
    await refusedBeforeSql(
      cmd([
        {
          account: { role: 'SUSPENSE' },
          debit: '10.0000',
          txnCurrency: 'USD',
          txnAmount: '6.12345',
          fxRate: '1.6',
        },
        { account: { id: BANK }, credit: '10.0000' },
      ]),
      'AMOUNT_SCALE',
      1,
    );
    await refusedBeforeSql(
      cmd([
        { account: { role: 'SUSPENSE' }, debit: '10.0000' },
        { account: { id: BANK }, credit: '10.0000', taxAmount: '0.90909' },
      ]),
      'AMOUNT_SCALE',
      2,
    );
  });

  it('AC-1 refuses a rate with more than 8 decimal places [T-0025]', async () => {
    await refusedBeforeSql(
      cmd([
        {
          account: { role: 'SUSPENSE' },
          debit: '15.2300',
          txnCurrency: 'USD',
          txnAmount: '10.0000',
          fxRate: '1.523000001',
        },
        { account: { id: BANK }, credit: '15.2300' },
      ]),
      'RATE_SCALE',
      1,
    );
  });

  it('AC-1 accepts exactly 4 / 8 decimals, and trailing zeros beyond them [T-0025]', () => {
    const c = checkCommand(
      cmd([
        {
          account: { role: 'SUSPENSE' },
          debit: '15.23450000',
          txnCurrency: 'USD',
          txnAmount: '10.0001',
          fxRate: '1.52345678000',
        },
        { account: { id: BANK }, credit: '15.2345' },
      ]),
    );
    expect(c.total).toBe('15.2345');
    expect(c.lines[0]).toMatchObject({
      debit: '15.2345',
      credit: '0.0000',
      txnAmount: '10.0001',
      fxRate: '1.52345678',
    });
  });

  it('AC-1 refuses amounts that are not plain non-negative decimal strings [T-0025]', async () => {
    for (const bad of ['1e3', '-5.0000', ' 5', '5.', '.5', 'NaN', '1000000000000000.0000']) {
      await refusedBeforeSql(
        cmd([
          { account: { role: 'SUSPENSE' }, debit: bad },
          { account: { id: BANK }, credit: '5.0000' },
        ]),
        'INVALID_AMOUNT',
        1,
      );
    }
    // A JS number is never accepted as money (no floating point).
    await refusedBeforeSql(
      cmd([
        { account: { role: 'SUSPENSE' }, debit: 5 as unknown as string },
        { account: { id: BANK }, credit: '5.0000' },
      ]),
      'INVALID_AMOUNT',
      1,
    );
  });

  it('AC-1 refuses zero, negative, non-decimal or too-large rates [T-0025]', async () => {
    for (const bad of ['0', '0.00000000', '-1.5', '1e2', '12345678901.5']) {
      await refusedBeforeSql(
        cmd([
          {
            account: { role: 'SUSPENSE' },
            debit: '1.0000',
            txnCurrency: 'USD',
            txnAmount: '1.0000',
            fxRate: bad,
          },
          { account: { id: BANK }, credit: '1.0000' },
        ]),
        'INVALID_RATE',
        1,
      );
    }
  });
});

describe('SS-PLAT-64 command shape is refused before SQL with a typed error [T-0025]', () => {
  it('SS-PLAT-64 needs at least two lines [T-0025]', async () => {
    await refusedBeforeSql(
      cmd([{ account: { role: 'SUSPENSE' }, debit: '1.0000' }]),
      'TOO_FEW_LINES',
    );
    await refusedBeforeSql(cmd([]), 'TOO_FEW_LINES');
  });

  it('SS-PLAT-64 every line has exactly one side greater than zero [T-0025]', async () => {
    const both = cmd([
      { account: { role: 'SUSPENSE' }, debit: '1.0000', credit: '1.0000' },
      { account: { id: BANK }, credit: '0.0000', debit: '0.0000' },
    ]);
    await refusedBeforeSql(both, 'LINE_SIDE', 1);
    const none = cmd([
      { account: { role: 'SUSPENSE' }, debit: '0.0000' },
      { account: { id: BANK }, credit: '0' },
    ]);
    await refusedBeforeSql(none, 'LINE_SIDE', 1);
    // A zero on the other side is allowed.
    expect(
      checkCommand(
        cmd([
          { account: { role: 'SUSPENSE' }, debit: '1.0000', credit: '0' },
          { account: { id: BANK }, credit: '1.0000', debit: '0.0000' },
        ]),
      ).total,
    ).toBe('1.0000');
  });

  it('SS-PLAT-64 an unbalanced command is refused in memory, naming both totals [T-0025]', async () => {
    const c = cmd([
      { account: { role: 'SUSPENSE' }, debit: '100.0000' },
      { account: { id: BANK }, credit: '99.9999' },
    ]);
    await refusedBeforeSql(c, 'UNBALANCED');
    expect(() => checkCommand(c)).toThrow(/debit 100\.0000.*credit 99\.9999/);
  });

  it('SS-PLAT-64 source types outside the period matrix are refused; reversals are not built yet [T-0025]', async () => {
    await refusedBeforeSql(cmd(ok, { sourceType: 'ar.invoice' }), 'UNKNOWN_SOURCE_TYPE');
    await refusedBeforeSql(cmd(ok, { sourceType: 'made_up' }), 'UNKNOWN_SOURCE_TYPE');
    await refusedBeforeSql(cmd(ok, { sourceType: 'ledger_reversal' }), 'SOURCE_TYPE_NOT_SUPPORTED');
  });

  it('SS-PLAT-64 malformed header fields are refused [T-0025]', async () => {
    await refusedBeforeSql(cmd(ok, { idempotencyKey: '' }), 'INVALID_COMMAND');
    await refusedBeforeSql(cmd(ok, { idempotencyKey: 'k'.repeat(201) }), 'INVALID_COMMAND');
    await refusedBeforeSql(cmd(ok, { entryDate: '2026-02-30' }), 'INVALID_COMMAND');
    await refusedBeforeSql(cmd(ok, { entryDate: '24/10/2026' }), 'INVALID_COMMAND');
    await refusedBeforeSql(cmd(ok, { companyId: 'not-a-uuid' }), 'INVALID_COMMAND');
    await refusedBeforeSql(cmd(ok, { periodOverride: { reason: 'late' } }), 'INVALID_COMMAND');
    await refusedBeforeSql(
      cmd(ok, { createdBy: COMPANY, periodOverride: { reason: '  ' } }),
      'INVALID_COMMAND',
    );
  });

  it('SS-PLAT-64 malformed line fields are refused with the line number [T-0025]', async () => {
    const line2 = (l: Partial<PostingLineInput>) =>
      cmd([ok[0] as PostingLineInput, { account: { id: BANK }, credit: '100.0000', ...l }]);
    await refusedBeforeSql(line2({ account: { id: 'x' } }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(line2({ account: { role: 'ar_control' } }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(
      line2({ txnCurrency: 'usd', txnAmount: '1.0000', fxRate: '1' }),
      'INVALID_COMMAND',
      2,
    );
    await refusedBeforeSql(line2({ txnAmount: '1.0000' }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(line2({ partyId: 'acme' }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(line2({ taxCodeId: 'GST' }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(line2({ dimensions: ['nope'] }), 'INVALID_COMMAND', 2);
    await refusedBeforeSql(line2({ dimensions: [BANK, BANK] }), 'INVALID_DIMENSION', 2);
  });
});

describe('Control accounts accept only their subledger (design §3.2) [T-0025]', () => {
  it('SS-PLAT-64 AR, AP and payroll clearing each accept only their own source types [T-0025]', () => {
    const ar = [
      'ar_invoice',
      'ar_credit_note',
      'ar_receipt',
      'ar_refund',
      'ar_write_off',
      'ar_prepayment',
      'ar_prepayment_application',
      'payments_stripe_charge',
    ];
    const ap = ['ap_bill', 'ap_payment'];
    const payroll = ['payroll_pay_run', 'payroll_net_pay_batch'];
    const others = ['manual_journal', 'payments_stripe_payout', 'ledger_reversal', 'unknown'];
    for (const st of [...ar, ...ap, ...payroll, ...others]) {
      expect(controlAccountAccepts('AR_CONTROL', st), `AR_CONTROL ${st}`).toBe(ar.includes(st));
      expect(controlAccountAccepts('AP_CONTROL', st), `AP_CONTROL ${st}`).toBe(ap.includes(st));
      expect(controlAccountAccepts('PAYROLL_CLEARING', st), `PAYROLL ${st}`).toBe(
        payroll.includes(st),
      );
      expect(controlAccountAccepts('SUSPENSE', st)).toBe(false);
    }
  });
});

describe('Entry numbering series (DL-0135) [T-0025]', () => {
  it('SS-PLAT-65 each source type numbers from its own je_ series [T-0025]', () => {
    expect(entrySeriesFor('manual_journal')).toBe('je_manual_journal');
    expect(entrySeriesFor('payments_stripe_charge')).toBe('je_payments_stripe_charge');
  });
});
