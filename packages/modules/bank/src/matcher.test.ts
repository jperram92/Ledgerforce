/**
 * Bank matching — the pure matcher (T-0060, UC-08 steps 2–3, RQ-0108, DL-0291).
 *
 * SS-UC08-04: a rule match is only ever a suggestion; exact (amount + reference) matches are the
 * only automatic ones, and only when the pairing is unique both ways.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MatchRuleError,
  planMatches,
  referenceFound,
  ruleMatches,
  validateMatchRule,
  type MatchCandidate,
  type MatchLine,
  type MatchRule,
} from './matcher.ts';

const line = (over: Partial<MatchLine> = {}): MatchLine => ({
  id: 'L1',
  amount: '1375.0000',
  description: 'Direct credit Acme Pty Ltd',
  reference: 'INV-000123',
  postedOn: '2026-11-02',
  ...over,
});

const receipt = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'customer_receipt',
  id: 'R1',
  entryId: 'E1',
  amount: '1375.00',
  date: '2026-11-02',
  references: ['INV-000123', 'RCT-000001'],
  ...over,
});

const stripeRule: MatchRule = {
  id: 'rule-stripe',
  name: 'Stripe payouts',
  priority: 10,
  accountId: 'acct-1210',
  ...validateMatchRule({
    match: 'all',
    conditions: [{ field: 'description', op: 'contains', value: 'STRIPE' }],
    direction: 'in',
  }),
};

describe('SS-UC08-04: Rule match is suggested, not applied', () => {
  it('SS-UC08-04 a "description contains STRIPE → Stripe clearing" rule creates a suggestion and nothing is auto-confirmed', () => {
    const payout = line({
      id: 'L6',
      amount: '550.5500',
      description: 'Stripe payout',
      reference: 'po_1Q2w3E',
      postedOn: '2026-11-10',
    });
    const plan = planMatches([payout], [], [stripeRule]);
    expect(plan.auto).toEqual([]);
    expect(plan.suggestions).toEqual([
      { lineId: 'L6', kind: 'rule', ruleId: 'rule-stripe', accountId: 'acct-1210' },
    ]);
  });

  it('a rule never turns into an automatic match, even when it is the only possible outcome', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cents: fc.integer({ min: -10_000_000, max: 10_000_000 }).filter((n) => n !== 0),
            text: fc.string({ maxLength: 30 }),
          }),
          { maxLength: 20 },
        ),
        (rows) => {
          const lines = rows.map((r, i) =>
            line({
              id: `L${String(i)}`,
              amount: (r.cents < 0 ? '-' : '') + centsText(Math.abs(r.cents)),
              description: `STRIPE ${r.text}`,
              reference: null,
            }),
          );
          const plan = planMatches(lines, [], [{ ...stripeRule, direction: 'any' }]);
          expect(plan.auto).toEqual([]);
          expect(plan.suggestions.every((s) => s.kind === 'rule')).toBe(true);
          expect(plan.suggestions).toHaveLength(lines.length);
        },
      ),
    );
  });

  it('only the first matching rule by priority suggests; direction and amount bounds apply', () => {
    const low: MatchRule = { ...stripeRule, id: 'rule-low', priority: 50, accountId: 'acct-x' };
    const fee: MatchRule = {
      id: 'rule-fee',
      name: 'Account fee',
      priority: 1,
      accountId: 'acct-6110',
      ...validateMatchRule({
        match: 'all',
        conditions: [{ field: 'description', op: 'starts_with', value: 'account fee' }],
        direction: 'out',
        amountMax: '50.00',
      }),
    };
    const fees = line({ id: 'F', amount: '-10.0000', description: 'Account fee', reference: null });
    const big = line({ id: 'B', amount: '-60.0000', description: 'Account fee', reference: null });
    const inbound = line({
      id: 'I',
      amount: '10.0000',
      description: 'Account fee',
      reference: null,
    });
    const payout = line({
      id: 'P',
      amount: '1.0000',
      description: 'stripe payout',
      reference: null,
    });
    const plan = planMatches([fees, big, inbound, payout], [], [low, fee, stripeRule]);
    expect(plan.suggestions).toEqual([
      { lineId: 'F', kind: 'rule', ruleId: 'rule-fee', accountId: 'acct-6110' },
      { lineId: 'P', kind: 'rule', ruleId: 'rule-stripe', accountId: 'acct-1210' },
    ]);
  });

  it('"any" rules need one condition; "all" rules need every condition; equals is whole-field', () => {
    const def = validateMatchRule({
      match: 'any',
      conditions: [
        { field: 'reference', op: 'equals', value: 'tls-889' },
        { field: 'text', op: 'contains', value: 'telstra' },
      ],
    });
    const r: MatchRule = { id: 'r', name: 'Telstra', priority: 1, accountId: 'a', ...def };
    expect(ruleMatches(r, line({ reference: 'TLS-889', description: 'x' }))).toBe(true);
    expect(ruleMatches(r, line({ reference: 'TLS-8890', description: 'Telstra dd' }))).toBe(true);
    expect(
      ruleMatches({ ...r, match: 'all' }, line({ reference: 'TLS-8890', description: 'Telstra' })),
    ).toBe(false);
  });

  it('refuses malformed rule definitions', () => {
    for (const bad of [
      {},
      { match: 'all', conditions: [] },
      { match: 'all', conditions: [{ field: 'memo', op: 'contains', value: 'x' }] },
      { match: 'all', conditions: [{ field: 'text', op: 'regex', value: 'x' }] },
      { match: 'all', conditions: [{ field: 'text', op: 'contains', value: '  ' }] },
      {
        match: 'all',
        conditions: [{ field: 'text', op: 'contains', value: 'x' }],
        direction: 'up',
      },
      {
        match: 'all',
        conditions: [{ field: 'text', op: 'contains', value: 'x' }],
        amountMin: '1.5e2',
      },
      {
        match: 'all',
        conditions: [{ field: 'text', op: 'contains', value: 'x' }],
        amountMin: '20',
        amountMax: '10',
      },
    ]) {
      expect(() => validateMatchRule(bad), JSON.stringify(bad)).toThrow(MatchRuleError);
    }
  });
});

describe('exact matching (SS-UC08-03, pure half)', () => {
  it('amount + reference on a unique pair auto-matches; rules are not consulted for that line', () => {
    const plan = planMatches([line()], [receipt()], [stripeRule]);
    expect(plan.auto).toEqual([{ lineId: 'L1', candidate: receipt() }]);
    expect(plan.suggestions).toEqual([]);
  });

  it('a different amount, a missing reference, the wrong direction or a far date never auto-matches', () => {
    for (const [l, c] of [
      [line({ amount: '1375.0100' }), receipt()],
      [line({ reference: 'INV-000124', description: 'Direct credit' }), receipt()],
      [line({ amount: '-1375.0000' }), receipt()],
      [line({ postedOn: '2027-01-15' }), receipt()],
    ] as const) {
      expect(planMatches([l], [c], []).auto).toEqual([]);
    }
  });

  it('two exact candidates for one line (or two lines for one candidate) become suggestions', () => {
    const twin = receipt({ id: 'R2', entryId: 'E2' });
    const plan = planMatches([line()], [receipt(), twin], []);
    expect(plan.auto).toEqual([]);
    expect(plan.suggestions).toEqual([
      { lineId: 'L1', kind: 'candidate', candidate: receipt() },
      { lineId: 'L1', kind: 'candidate', candidate: twin },
    ]);
    const plan2 = planMatches([line(), line({ id: 'L2' })], [receipt()], []);
    expect(plan2.auto).toEqual([]);
    expect(plan2.suggestions.map((s) => s.lineId)).toEqual(['L1', 'L2']);
  });

  it('supplier payments match money out against the batch reference found in the description', () => {
    const batch: MatchCandidate = {
      kind: 'supplier_payment',
      id: 'B1',
      entryId: 'E9',
      amount: '-2200.00',
      date: '2026-11-05',
      references: ['PB-000001'],
    };
    const l = line({ amount: '-2200.0000', description: 'DE PB-000001 Harbour', reference: null });
    expect(planMatches([l], [batch], []).auto).toEqual([{ lineId: 'L1', candidate: batch }]);
  });

  it('a reference is found as a whole token, case- and punctuation-insensitive', () => {
    expect(
      referenceFound('INV-000123', line({ reference: null, description: 'pay inv 000123 thanks' })),
    ).toBe(true);
    expect(referenceFound('INV-000123', line({ reference: 'inv-000123' }))).toBe(true);
    expect(referenceFound('INV-000123', line({ reference: 'INV-0001234', description: '' }))).toBe(
      false,
    );
    expect(referenceFound('12', line({ reference: '12', description: '' }))).toBe(false); // too short to be safe
  });
});

function centsText(n: number): string {
  const s = String(n).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
