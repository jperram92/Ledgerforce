/**
 * Segregation of duties (design §6.4–6.5, ADR-0026, T-0015): the rules as data.
 *
 * A rule guards one step on a subject (`bill.approve`) against earlier steps on the *same
 * subject* by the *same person* (`bill.enter`), under a condition. RBAC (catalogue.ts) answers
 * "may this role ever do it"; these rules answer "may this person do it to this item".
 * The evaluator is in evaluate.ts; the API checks routes declared with `@SoD(step, …)`.
 *
 * Thresholds are tenant settings (app.sod_settings, migration 0021). The defaults below are the
 * placeholders of design §6.5; SoD thresholds are an open product-owner decision (§11.2).
 */

/** Subjects and their steps. A step id is `<subject>.<step>`. */
export const SOD_SUBJECT_STEPS = {
  bill: ['enter', 'approve'],
  credit_note: ['create', 'approve'],
  payment_batch: ['create', 'approve', 'release'],
  net_pay_batch: ['create', 'release'],
  bank_detail_change: ['request', 'verify'],
  manual_journal: ['post', 'approve'],
  posting_rule: ['author', 'activate'],
  tax_code: ['author', 'activate'],
  period_reopen_request: ['request', 'approve'],
} as const;

export type SodSubjectType = keyof typeof SOD_SUBJECT_STEPS;
export type SodStep = {
  [S in SodSubjectType]: `${S}.${(typeof SOD_SUBJECT_STEPS)[S][number]}`;
}[SodSubjectType];

export const SOD_STEPS: readonly SodStep[] = Object.freeze(
  (Object.keys(SOD_SUBJECT_STEPS) as SodSubjectType[]).flatMap((s) =>
    SOD_SUBJECT_STEPS[s].map((st) => `${s}.${st}` as SodStep),
  ),
);

export function isSodStep(s: string): s is SodStep {
  return (SOD_STEPS as readonly string[]).includes(s);
}

export function subjectTypeOf(step: SodStep): SodSubjectType {
  return step.slice(0, step.indexOf('.')) as SodSubjectType;
}

export type SodThreshold =
  'bill_self_approval' | 'credit_note_self_approval' | 'journal_approval' | 'batch_two_releasers';

export const SOD_THRESHOLDS: readonly SodThreshold[] = Object.freeze([
  'bill_self_approval',
  'credit_note_self_approval',
  'journal_approval',
  'batch_two_releasers',
]);

export interface SodSettings {
  /** Design §6.5 small-team mode (one or two users); off by default. */
  smallTeamMode: boolean;
  /** Amounts as decimal strings with 4 places (`NUMERIC(19,4)`); "above" means strictly greater. */
  thresholds: Readonly<Record<SodThreshold, string>>;
  /** IANA time zone in which the weekly exception report's Monday-to-Monday week is cut. */
  reportTimezone: string;
}

/**
 * PLACEHOLDERS (design §6.5 defaults; open decision §11.2 — DL-0131). The credit-note value is
 * not in the design (§6.4 says only "above threshold") and was set equal to bills. Must equal the
 * column defaults of app.sod_settings (migration 0021; proven by sod.db.test.ts).
 */
export const DEFAULT_SOD_SETTINGS: SodSettings = Object.freeze({
  smallTeamMode: false,
  thresholds: Object.freeze({
    bill_self_approval: '1000.0000',
    credit_note_self_approval: '1000.0000',
    journal_approval: '5000.0000',
    batch_two_releasers: '10000.0000',
  }),
  reportTimezone: 'Australia/Sydney',
});

export type SodCondition =
  | { kind: 'always' }
  | { kind: 'above_threshold'; threshold: SodThreshold }
  | { kind: 'journal_approval_required' };

export type SodRuleId =
  | 'SOD_BATCH_SELF_RELEASE'
  | 'SOD_BATCH_SAME_RELEASER'
  | 'SOD_BATCH_SELF_APPROVAL'
  | 'SOD_NET_PAY_SELF_RELEASE'
  | 'SOD_BANK_DETAIL_SELF_VERIFY'
  | 'SOD_BILL_SELF_APPROVAL'
  | 'SOD_JOURNAL_SELF_APPROVAL'
  | 'SOD_RULE_SELF_ACTIVATION'
  | 'SOD_TAX_CODE_SELF_ACTIVATION'
  | 'SOD_PERIOD_REOPEN_SELF_APPROVAL'
  | 'SOD_CREDIT_NOTE_SELF_APPROVAL';

export interface SodRule {
  /** Also the error code returned to the client and written to the audit log. */
  id: SodRuleId;
  designRef: string;
  description: string;
  /** The guarded step. */
  step: SodStep;
  /** Earlier steps on the same subject that, done by the same person, conflict with `step`. */
  conflictsWith: readonly SodStep[];
  condition: SodCondition;
  /** Whether small-team mode may allow the conflict as a recorded exception. */
  smallTeamException: boolean;
}

const rule = (r: SodRule): SodRule =>
  Object.freeze({ ...r, conflictsWith: Object.freeze([...r.conflictsWith]) });

export const SOD_RULES: readonly SodRule[] = Object.freeze([
  rule({
    id: 'SOD_BATCH_SELF_RELEASE',
    designRef: '§6.5 rule 1',
    description: 'Payment batches: creator ≠ releaser, always (also the Owner, §6.4).',
    step: 'payment_batch.release',
    conflictsWith: ['payment_batch.create'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_BATCH_SAME_RELEASER',
    designRef: '§6.5 rule 1',
    description:
      'Batches above the two-releaser threshold need two different releasers: nobody releases twice.',
    step: 'payment_batch.release',
    conflictsWith: ['payment_batch.release'],
    condition: { kind: 'above_threshold', threshold: 'batch_two_releasers' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_BATCH_SELF_APPROVAL',
    designRef: '§6.4 Approver',
    description: 'Approvers cannot approve the payment batches they created.',
    step: 'payment_batch.approve',
    conflictsWith: ['payment_batch.create'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_NET_PAY_SELF_RELEASE',
    designRef: '§6.4 Payroll Officer',
    description: 'A net-pay batch is not released by the person who created it.',
    step: 'net_pay_batch.release',
    conflictsWith: ['net_pay_batch.create'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_BANK_DETAIL_SELF_VERIFY',
    designRef: '§6.5 rule 2',
    description: 'Supplier and employee bank details: requester ≠ verifier.',
    step: 'bank_detail_change.verify',
    conflictsWith: ['bank_detail_change.request'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_BILL_SELF_APPROVAL',
    designRef: '§6.5 rule 3',
    description: 'Bills: entered-by ≠ approved-by above the bill threshold.',
    step: 'bill.approve',
    conflictsWith: ['bill.enter'],
    condition: { kind: 'above_threshold', threshold: 'bill_self_approval' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_JOURNAL_SELF_APPROVAL',
    designRef: '§6.5 rule 4',
    description:
      'Manual journals needing approval (above the journal threshold, or on a control, tax or equity account) are not approved by their poster.',
    step: 'manual_journal.approve',
    conflictsWith: ['manual_journal.post'],
    condition: { kind: 'journal_approval_required' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_RULE_SELF_ACTIVATION',
    designRef: '§6.5 rule 5',
    description: 'Posting rules: author ≠ activator (Finance Admin, §6.4).',
    step: 'posting_rule.activate',
    conflictsWith: ['posting_rule.author'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_TAX_CODE_SELF_ACTIVATION',
    designRef: '§6.5 rule 5',
    description: 'Tax codes: author ≠ activator.',
    step: 'tax_code.activate',
    conflictsWith: ['tax_code.author'],
    condition: { kind: 'always' },
    smallTeamException: true,
  }),
  rule({
    id: 'SOD_PERIOD_REOPEN_SELF_APPROVAL',
    designRef: '§6.5 rule 6',
    description:
      'Period reopen from hard lock: two approvers (requester ≠ approver) plus a reason; never excepted (migration 0018 enforces it too).',
    step: 'period_reopen_request.approve',
    conflictsWith: ['period_reopen_request.request'],
    condition: { kind: 'always' },
    smallTeamException: false,
  }),
  rule({
    id: 'SOD_CREDIT_NOTE_SELF_APPROVAL',
    designRef: '§6.4 AR Clerk',
    description: 'Credit notes above the credit-note threshold are not approved by their creator.',
    step: 'credit_note.approve',
    conflictsWith: ['credit_note.create'],
    condition: { kind: 'above_threshold', threshold: 'credit_note_self_approval' },
    smallTeamException: true,
  }),
]);

/** The rules guarding `step` (empty for steps that are only recorded, e.g. `bill.enter`). */
export function rulesForStep(step: SodStep): readonly SodRule[] {
  if (!isSodStep(step)) throw new Error(`unknown SoD step ${String(step)}`);
  return SOD_RULES.filter((r) => r.step === step);
}
