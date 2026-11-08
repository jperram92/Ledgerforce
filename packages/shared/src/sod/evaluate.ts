import { Decimal } from 'decimal.js';
import {
  rulesForStep,
  type SodRule,
  type SodRuleId,
  type SodSettings,
  type SodStep,
} from './rules.ts';

/** What the evaluator knows about the subject. Amounts are decimal strings, never numbers. */
export interface SodSubjectFacts {
  amount?: string | null;
  /** Manual journals: touches a control, tax or equity account (design §6.5 rule 4). */
  controlTaxOrEquity?: boolean;
}

export interface SodExceptionRequest {
  reason: string;
  /** An external reviewer (another active user of the tenant); absent = recorded exception. */
  reviewerId?: string | null;
}

export interface SodInput {
  step: SodStep;
  actorId: string;
  subject: SodSubjectFacts;
  /** Steps already recorded on this subject (app.sod_action), oldest first. */
  history: readonly { step: string; actorId: string }[];
  settings: SodSettings;
  /** Other active users of the tenant who hold the route's permission. */
  otherEligible: number;
  exception?: SodExceptionRequest | null;
}

export type SodDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; rule: SodRuleId; smallTeamExceptionRequired: boolean }
  | {
      outcome: 'allow_with_exception';
      rules: SodRuleId[];
      kind: 'external_reviewer' | 'recorded_exception';
    };

const MAX_REASON = 2000;

/** "Above" is strictly greater; an unknown amount is treated as above (fail closed). */
function above(amount: string | null | undefined, threshold: string): boolean {
  if (amount === null || amount === undefined) return true;
  return new Decimal(amount).gt(new Decimal(threshold));
}

/** Design §6.5 rule 1: batches above the threshold need two different releasers. */
export function releasersRequired(amount: string | null, settings: SodSettings): number {
  return above(amount, settings.thresholds.batch_two_releasers) ? 2 : 1;
}

/** Design §6.5 rule 4: approval required above the journal threshold or on sensitive accounts. */
export function journalApprovalRequired(s: SodSubjectFacts, settings: SodSettings): boolean {
  return s.controlTaxOrEquity === true || above(s.amount, settings.thresholds.journal_approval);
}

function conditionHolds(r: SodRule, input: SodInput): boolean {
  switch (r.condition.kind) {
    case 'always':
      return true;
    case 'above_threshold':
      return above(input.subject.amount, input.settings.thresholds[r.condition.threshold]);
    case 'journal_approval_required':
      return journalApprovalRequired(input.subject, input.settings);
  }
}

function usableException(input: SodInput): SodExceptionRequest | null {
  const e = input.exception;
  if (!e) return null;
  const reason = e.reason.trim();
  if (reason === '' || reason.length > MAX_REASON) return null;
  const reviewer = e.reviewerId ?? null;
  if (reviewer !== null && (reviewer === '' || reviewer === input.actorId)) return null;
  return e;
}

/**
 * Evaluates every rule guarding `input.step` (ADR-0026). A rule is violated when the actor did
 * one of its conflicting steps on this subject before and its condition holds. Any violation
 * denies, unless every violated rule may be excepted, small-team mode is on, nobody else is
 * eligible, and the request carries a usable exception (reason; reviewer ≠ actor).
 */
export function evaluateSod(input: SodInput): SodDecision {
  const violated = rulesForStep(input.step).filter(
    (r) =>
      input.history.some(
        (h) =>
          h.actorId === input.actorId && (r.conflictsWith as readonly string[]).includes(h.step),
      ) && conditionHolds(r, input),
  );
  const first = violated[0];
  if (!first) return { outcome: 'allow' };
  const excusable =
    input.settings.smallTeamMode &&
    input.otherEligible === 0 &&
    violated.every((r) => r.smallTeamException);
  if (!excusable) return { outcome: 'deny', rule: first.id, smallTeamExceptionRequired: false };
  const e = usableException(input);
  if (!e) return { outcome: 'deny', rule: first.id, smallTeamExceptionRequired: true };
  return {
    outcome: 'allow_with_exception',
    rules: violated.map((r) => r.id),
    kind: e.reviewerId ? 'external_reviewer' : 'recorded_exception',
  };
}
