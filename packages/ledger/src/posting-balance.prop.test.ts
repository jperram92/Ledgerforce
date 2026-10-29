/**
 * INV-balance at the command boundary (T-0025, Docs/process/tdd.md §4): any random balanced
 * command passes the in-memory check with Σdebit = Σcredit; any unbalanced one is refused with
 * UNBALANCED before a single SQL statement. Amounts are generated as integer ten-thousandths
 * (bigint) and formatted as decimal strings — never floats. Default numRuns.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PostingError, checkCommand, type PostingLineInput } from './posting-command.ts';
import { post } from './posting-engine.ts';
import { untouchableTrx } from './testing/untouchable-trx.ts';

const COMPANY = '01900000-0000-7000-8000-00000000c002';
const ACCOUNTS = [
  '01900000-0000-7000-8000-00000000a001',
  '01900000-0000-7000-8000-00000000a002',
  '01900000-0000-7000-8000-00000000a003',
];

/** bigint ten-thousandths → "123.4567". */
const fmt = (u: bigint): string =>
  `${(u / 10_000n).toString()}.${(u % 10_000n).toString().padStart(4, '0')}`;
const units = fc.bigInt({ min: 1n, max: 10n ** 13n });

/** Random debits and credits plus one balancing line on the short side. */
const balancedLines = fc
  .record({
    debits: fc.array(units, { minLength: 1, maxLength: 6 }),
    credits: fc.array(units, { minLength: 1, maxLength: 6 }),
    accountIdx: fc.array(fc.nat({ max: ACCOUNTS.length - 1 }), { minLength: 13, maxLength: 13 }),
  })
  .map(({ debits, credits, accountIdx }) => {
    const d = debits.reduce((a, b) => a + b, 0n);
    const c = credits.reduce((a, b) => a + b, 0n);
    const sides: { side: 'debit' | 'credit'; u: bigint }[] = [
      ...debits.map((u) => ({ side: 'debit' as const, u })),
      ...credits.map((u) => ({ side: 'credit' as const, u })),
    ];
    if (d > c) sides.push({ side: 'credit', u: d - c });
    if (c > d) sides.push({ side: 'debit', u: c - d });
    const lines: PostingLineInput[] = sides.map((s, i) => ({
      account: { id: ACCOUNTS[accountIdx[i] ?? 0] ?? '' },
      [s.side]: fmt(s.u),
    }));
    return { lines, total: d > c ? d : c };
  });

const command = (lines: PostingLineInput[]) => ({
  companyId: COMPANY,
  idempotencyKey: 'prop',
  entryDate: '2026-10-24',
  sourceType: 'manual_journal',
  lines,
});

describe('INV-balance posting commands [T-0025]', () => {
  it('INV-balance any random balanced command passes the in-memory check with equal totals [T-0025]', () => {
    fc.assert(
      fc.property(balancedLines, ({ lines, total }) => {
        const checked = checkCommand(command(lines));
        expect(checked.total).toBe(fmt(total));
        expect(checked.lines).toHaveLength(lines.length);
      }),
    );
  });

  it('INV-balance any unbalanced command is refused before SQL [T-0025]', async () => {
    await fc.assert(
      fc.asyncProperty(
        balancedLines,
        fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }).filter((x) => x !== 0n),
        fc.nat(),
        async ({ lines }, delta, pick) => {
          // Move one line's amount by a non-zero delta (keeping it positive).
          const i = pick % lines.length;
          const l = lines[i] as PostingLineInput;
          const side = l.debit !== undefined ? 'debit' : 'credit';
          const [whole = '0', frac = '0'] = (l[side] ?? '0').split('.');
          let u = BigInt(whole) * 10_000n + BigInt(frac) + delta;
          if (u <= 0n) u = BigInt(whole) * 10_000n + BigInt(frac) + (delta < 0n ? -delta : delta);
          const broken = lines.map((x, j) =>
            j === i ? { account: x.account, [side]: fmt(u) } : x,
          );
          const { trx, touched } = untouchableTrx();
          const err = await post(trx, command(broken)).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(PostingError);
          expect((err as PostingError).code).toBe('UNBALANCED');
          expect(touched).toEqual([]);
        },
      ),
    );
  });
});
