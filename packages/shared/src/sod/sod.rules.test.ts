/**
 * SS-PLAT-16 — SoD rules 1–6 evaluated as configured (T-0015, ADR-0026, design §6.4–6.5).
 * Table-driven: actor / step / subject history / settings / small-team cases → expected decision.
 * Plus a fast-check property: no sequence of steps lets one person both enter and approve the
 * same bill above the threshold (or create and release the same batch) unless that very step is
 * a small-team exception (small-team mode on, nobody else eligible, a reason given).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOD_SETTINGS,
  evaluateSod,
  journalApprovalRequired,
  releasersRequired,
  rulesForStep,
  SOD_RULES,
  type SodDecision,
  type SodInput,
  type SodSettings,
  type SodStep,
} from './index.ts';

const A = 'user-a';
const B = 'user-b';
const R = 'user-reviewer';

const smallTeam: SodSettings = { ...DEFAULT_SOD_SETTINGS, smallTeamMode: true };
const raised: SodSettings = {
  ...DEFAULT_SOD_SETTINGS,
  thresholds: { ...DEFAULT_SOD_SETTINGS.thresholds, bill_self_approval: '5000.0000' },
};

const h = (step: SodStep, actorId: string) => ({ step, actorId });

interface Case {
  name: string;
  input: Partial<SodInput> & Pick<SodInput, 'step'>;
  expected: SodDecision;
}

const ALLOW: SodDecision = { outcome: 'allow' };
const deny = (rule: string, smallTeamExceptionRequired = false): SodDecision =>
  ({ outcome: 'deny', rule, smallTeamExceptionRequired }) as SodDecision;
const excepted = (rules: string[], kind: 'external_reviewer' | 'recorded_exception'): SodDecision =>
  ({ outcome: 'allow_with_exception', rules, kind }) as SodDecision;

const CASES: Case[] = [
  // Rule 1 — payment batches: creator ≠ releaser, always; two releasers above $10,000.
  {
    name: 'rule 1: creator releases own batch (any amount) → deny',
    input: {
      step: 'payment_batch.release',
      subject: { amount: '10.0000' },
      history: [h('payment_batch.create', A)],
    },
    expected: deny('SOD_BATCH_SELF_RELEASE'),
  },
  {
    name: 'rule 1: another user releases → allow',
    input: {
      step: 'payment_batch.release',
      actorId: B,
      subject: { amount: '10.0000' },
      history: [h('payment_batch.create', A)],
    },
    expected: ALLOW,
  },
  {
    name: 'rule 1: above $10,000 the same releaser cannot release twice → deny',
    input: {
      step: 'payment_batch.release',
      actorId: B,
      subject: { amount: '10000.0001' },
      history: [h('payment_batch.create', A), h('payment_batch.release', B)],
    },
    expected: deny('SOD_BATCH_SAME_RELEASER'),
  },
  {
    name: 'rule 1: above $10,000 a second, different releaser → allow',
    input: {
      step: 'payment_batch.release',
      actorId: R,
      subject: { amount: '25000.0000' },
      history: [h('payment_batch.create', A), h('payment_batch.release', B)],
    },
    expected: ALLOW,
  },
  {
    name: '§6.4 Approver: creator approves own batch → deny',
    input: { step: 'payment_batch.approve', history: [h('payment_batch.create', A)] },
    expected: deny('SOD_BATCH_SELF_APPROVAL'),
  },
  {
    name: '§6.4 Payroll Officer: creator releases own net-pay batch → deny',
    input: { step: 'net_pay_batch.release', history: [h('net_pay_batch.create', A)] },
    expected: deny('SOD_NET_PAY_SELF_RELEASE'),
  },
  // Rule 2 — bank details: requester ≠ verifier.
  {
    name: 'rule 2: requester verifies own bank-detail change → deny',
    input: { step: 'bank_detail_change.verify', history: [h('bank_detail_change.request', A)] },
    expected: deny('SOD_BANK_DETAIL_SELF_VERIFY'),
  },
  {
    name: 'rule 2: a different verifier → allow',
    input: {
      step: 'bank_detail_change.verify',
      actorId: B,
      history: [h('bank_detail_change.request', A)],
    },
    expected: ALLOW,
  },
  // Rule 3 — bills: entered-by ≠ approved-by above $1,000.
  {
    name: 'rule 3: enterer approves own $2,750 bill → deny',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
    },
    expected: deny('SOD_BILL_SELF_APPROVAL'),
  },
  {
    name: 'rule 3: enterer approves own $1,000.00 bill (not above) → allow',
    input: {
      step: 'bill.approve',
      subject: { amount: '1000.0000' },
      history: [h('bill.enter', A)],
    },
    expected: ALLOW,
  },
  {
    name: 'rule 3: $1,000.0001 is above the threshold → deny',
    input: {
      step: 'bill.approve',
      subject: { amount: '1000.0001' },
      history: [h('bill.enter', A)],
    },
    expected: deny('SOD_BILL_SELF_APPROVAL'),
  },
  {
    name: 'rule 3: configured threshold 5,000 → $2,750 self-approval allowed',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: raised,
    },
    expected: ALLOW,
  },
  {
    name: 'rule 3: unknown amount fails closed → deny',
    input: { step: 'bill.approve', subject: {}, history: [h('bill.enter', A)] },
    expected: deny('SOD_BILL_SELF_APPROVAL'),
  },
  {
    name: 'rule 3: someone else entered it → allow',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', B)],
    },
    expected: ALLOW,
  },
  // Rule 4 — manual journals: approval required above $5,000 or on control/tax/equity accounts.
  {
    name: 'rule 4: poster approves own $6,000 journal → deny',
    input: {
      step: 'manual_journal.approve',
      subject: { amount: '6000.0000' },
      history: [h('manual_journal.post', A)],
    },
    expected: deny('SOD_JOURNAL_SELF_APPROVAL'),
  },
  {
    name: 'rule 4: poster approves own $100 journal on a tax account → deny',
    input: {
      step: 'manual_journal.approve',
      subject: { amount: '100.0000', controlTaxOrEquity: true },
      history: [h('manual_journal.post', A)],
    },
    expected: deny('SOD_JOURNAL_SELF_APPROVAL'),
  },
  {
    name: 'rule 4: poster approves own $100 ordinary journal (no approval required) → allow',
    input: {
      step: 'manual_journal.approve',
      subject: { amount: '100.0000', controlTaxOrEquity: false },
      history: [h('manual_journal.post', A)],
    },
    expected: ALLOW,
  },
  // Rule 5 — posting rules and tax codes: author ≠ activator.
  {
    name: 'rule 5: author activates own posting rule → deny',
    input: { step: 'posting_rule.activate', history: [h('posting_rule.author', A)] },
    expected: deny('SOD_RULE_SELF_ACTIVATION'),
  },
  {
    name: 'rule 5: author activates own tax code → deny',
    input: { step: 'tax_code.activate', history: [h('tax_code.author', A)] },
    expected: deny('SOD_TAX_CODE_SELF_ACTIVATION'),
  },
  {
    name: 'rule 5: co-author activates (A authored, B edited, B activates) → deny',
    input: {
      step: 'posting_rule.activate',
      actorId: B,
      history: [h('posting_rule.author', A), h('posting_rule.author', B)],
    },
    expected: deny('SOD_RULE_SELF_ACTIVATION'),
  },
  // Rule 6 — period reopen from hard lock: two approvers.
  {
    name: 'rule 6: requester approves own reopen → deny',
    input: {
      step: 'period_reopen_request.approve',
      history: [h('period_reopen_request.request', A)],
    },
    expected: deny('SOD_PERIOD_REOPEN_SELF_APPROVAL'),
  },
  // §6.4 AR Clerk — credit notes above threshold.
  {
    name: '§6.4: creator approves own credit note above threshold → deny',
    input: {
      step: 'credit_note.approve',
      subject: { amount: '1500.0000' },
      history: [h('credit_note.create', A)],
    },
    expected: deny('SOD_CREDIT_NOTE_SELF_APPROVAL'),
  },
  {
    name: '§6.4: creator approves own credit note at/below threshold → allow',
    input: {
      step: 'credit_note.approve',
      subject: { amount: '200.0000' },
      history: [h('credit_note.create', A)],
    },
    expected: ALLOW,
  },
  // Steps with no rule (recording only) are allowed.
  {
    name: 'recording step bill.enter → allow',
    input: { step: 'bill.enter', subject: { amount: '2750.0000' } },
    expected: ALLOW,
  },
  // Small-team mode.
  {
    name: 'small team off: own bill, exception offered → still deny',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      otherEligible: 0,
      exception: { reason: 'only person in the business' },
    },
    expected: deny('SOD_BILL_SELF_APPROVAL'),
  },
  {
    name: 'small team on, nobody else eligible, no exception → deny, exception required',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: smallTeam,
      otherEligible: 0,
    },
    expected: deny('SOD_BILL_SELF_APPROVAL', true),
  },
  {
    name: 'small team on, nobody else eligible, recorded exception → allow_with_exception',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: smallTeam,
      otherEligible: 0,
      exception: { reason: 'sole trader; reviewed at month end' },
    },
    expected: excepted(['SOD_BILL_SELF_APPROVAL'], 'recorded_exception'),
  },
  {
    name: 'small team on, nobody else eligible, external reviewer → allow_with_exception',
    input: {
      step: 'payment_batch.release',
      subject: { amount: '900.0000' },
      history: [h('payment_batch.create', A)],
      settings: smallTeam,
      otherEligible: 0,
      exception: { reason: 'outside accountant reviews', reviewerId: R },
    },
    expected: excepted(['SOD_BATCH_SELF_RELEASE'], 'external_reviewer'),
  },
  {
    name: 'small team on, but another eligible person exists → deny (control can be satisfied)',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: smallTeam,
      otherEligible: 1,
      exception: { reason: 'in a hurry' },
    },
    expected: deny('SOD_BILL_SELF_APPROVAL'),
  },
  {
    name: 'small team on: blank reason is no exception → deny, exception required',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: smallTeam,
      otherEligible: 0,
      exception: { reason: '   ' },
    },
    expected: deny('SOD_BILL_SELF_APPROVAL', true),
  },
  {
    name: 'small team on: the actor cannot be their own external reviewer → deny',
    input: {
      step: 'bill.approve',
      subject: { amount: '2750.0000' },
      history: [h('bill.enter', A)],
      settings: smallTeam,
      otherEligible: 0,
      exception: { reason: 'me', reviewerId: A },
    },
    expected: deny('SOD_BILL_SELF_APPROVAL', true),
  },
  {
    name: 'small team on: period reopen allows no exception (rule 6, as migration 0018) → deny',
    input: {
      step: 'period_reopen_request.approve',
      history: [h('period_reopen_request.request', A)],
      settings: smallTeam,
      otherEligible: 0,
      exception: { reason: 'sole director' },
    },
    expected: deny('SOD_PERIOD_REOPEN_SELF_APPROVAL'),
  },
];

const run = (c: Case['input']): SodDecision =>
  evaluateSod({
    actorId: A,
    subject: {},
    history: [],
    settings: DEFAULT_SOD_SETTINGS,
    otherEligible: 3,
    exception: null,
    ...c,
  });

describe('SS-PLAT-16: SoD rules 1–6 evaluated as configured', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(run(c.input)).toEqual(c.expected);
  });

  it('every rule of §6.5 (1–6) and the §6.4 SoD cells is in the table, each with a design reference', () => {
    expect(SOD_RULES.map((r) => r.id).sort()).toEqual(
      [
        'SOD_BANK_DETAIL_SELF_VERIFY',
        'SOD_BATCH_SAME_RELEASER',
        'SOD_BATCH_SELF_APPROVAL',
        'SOD_BATCH_SELF_RELEASE',
        'SOD_BILL_SELF_APPROVAL',
        'SOD_CREDIT_NOTE_SELF_APPROVAL',
        'SOD_JOURNAL_SELF_APPROVAL',
        'SOD_NET_PAY_SELF_RELEASE',
        'SOD_PERIOD_REOPEN_SELF_APPROVAL',
        'SOD_RULE_SELF_ACTIVATION',
        'SOD_TAX_CODE_SELF_ACTIVATION',
      ].sort(),
    );
    const refs = new Set(SOD_RULES.map((r) => r.designRef));
    for (const n of [1, 2, 3, 4, 5, 6]) expect(refs.has(`§6.5 rule ${String(n)}`)).toBe(true);
    // every case-table rule appears in a denial case (the table is not vacuous)
    const denied = new Set(
      CASES.flatMap((c) => (c.expected.outcome === 'deny' ? [c.expected.rule] : [])),
    );
    for (const r of SOD_RULES) expect(denied.has(r.id), r.id).toBe(true);
  });

  it('placeholder defaults are those of design §6.5 (open decision §11.2) and small-team mode is off', () => {
    expect(DEFAULT_SOD_SETTINGS).toEqual({
      smallTeamMode: false,
      thresholds: {
        bill_self_approval: '1000.0000',
        credit_note_self_approval: '1000.0000',
        journal_approval: '5000.0000',
        batch_two_releasers: '10000.0000',
      },
      reportTimezone: 'Australia/Sydney',
    });
    expect(Object.isFrozen(DEFAULT_SOD_SETTINGS)).toBe(true);
    expect(Object.isFrozen(SOD_RULES)).toBe(true);
  });

  it('two releasers above the threshold; journal approval above $5,000 or on sensitive accounts', () => {
    expect(releasersRequired('10000.0000', DEFAULT_SOD_SETTINGS)).toBe(1);
    expect(releasersRequired('10000.0001', DEFAULT_SOD_SETTINGS)).toBe(2);
    expect(releasersRequired(null, DEFAULT_SOD_SETTINGS)).toBe(2); // unknown amount: fail closed
    expect(journalApprovalRequired({ amount: '5000.0000' }, DEFAULT_SOD_SETTINGS)).toBe(false);
    expect(journalApprovalRequired({ amount: '5000.0001' }, DEFAULT_SOD_SETTINGS)).toBe(true);
    expect(
      journalApprovalRequired({ amount: '1.0000', controlTaxOrEquity: true }, DEFAULT_SOD_SETTINGS),
    ).toBe(true);
  });

  it('rulesForStep finds the rules of a step; an unknown step is a programming error', () => {
    expect(rulesForStep('bill.approve').map((r) => r.id)).toEqual(['SOD_BILL_SELF_APPROVAL']);
    expect(rulesForStep('bill.enter')).toEqual([]);
    expect(() => run({ step: 'bill.pay' as SodStep })).toThrow(/unknown SoD step/);
  });

  it('property: no sequence lets one person approve a bill above the threshold they entered, or release a batch they created, except as a recorded small-team exception', () => {
    const actors = ['p1', 'p2', 'p3'];
    const steps: SodStep[] = [
      'bill.enter',
      'bill.approve',
      'payment_batch.create',
      'payment_batch.release',
    ];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            actor: fc.constantFrom(...actors),
            step: fc.constantFrom(...steps),
            exception: fc.option(fc.constantFrom('reason', ' '), { nil: null }),
          }),
          { maxLength: 25 },
        ),
        fc.boolean(),
        fc.integer({ min: 0, max: 2 }),
        fc.constantFrom('500.0000', '2750.0000', '20000.0000'),
        (seq, smallTeamMode, otherEligible, amount) => {
          const settings = { ...DEFAULT_SOD_SETTINGS, smallTeamMode };
          const history: { step: SodStep; actorId: string }[] = [];
          for (const s of seq) {
            const d = evaluateSod({
              step: s.step,
              actorId: s.actor,
              subject: { amount },
              history,
              settings,
              otherEligible,
              exception: s.exception === null ? null : { reason: s.exception },
            });
            const enteredBefore = history.some(
              (x) => x.actorId === s.actor && x.step === 'bill.enter',
            );
            const createdBefore = history.some(
              (x) => x.actorId === s.actor && x.step === 'payment_batch.create',
            );
            const conflict =
              (s.step === 'bill.approve' && enteredBefore && amount !== '500.0000') ||
              (s.step === 'payment_batch.release' && createdBefore);
            if (conflict) {
              // allowed only as a visible small-team exception, with a real reason
              const mayExcept = smallTeamMode && otherEligible === 0 && s.exception === 'reason';
              expect(d.outcome).toBe(mayExcept ? 'allow_with_exception' : 'deny');
            } else if (s.step !== 'payment_batch.release') {
              expect(d.outcome).toBe('allow');
            }
            if (d.outcome !== 'deny') history.push({ step: s.step, actorId: s.actor });
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
