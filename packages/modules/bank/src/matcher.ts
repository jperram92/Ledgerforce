/**
 * Bank matching — the pure matcher (T-0060, UC-08 steps 2–3, RQ-0108, DL-0291).
 *
 * Two outcomes, never mixed up:
 * - **auto**: an exact match — the statement line and a book transaction (customer receipt,
 *   confirmed supplier payment batch) have the same signed amount, the transaction's reference
 *   appears in the line as a whole token, the dates are at most MATCH_WINDOW_DAYS apart, and the
 *   pairing is unique both ways (one candidate for the line, one line for the candidate). This
 *   mirrors NetSuite's system rules (exact number + amount, no auto-match when two candidates
 *   qualify) — RQ-0108.
 * - **suggestions**: everything else that looks right — ambiguous exact candidates, and the first
 *   matching bank rule by priority. A suggestion is never applied without a person (UC-08 step 3,
 *   SS-UC08-04), as Xero bank rules only propose a coding until the user clicks OK.
 *
 * Bank rules are data (design principle 3): a declarative definition — conditions on the line's
 * description, reference or both ("text") with contains / equals / starts_with, combined by
 * all/any, plus an optional direction and absolute amount bounds. Comparison is case-insensitive.
 * No expression language is needed for this shape, so no CEL runtime dependency (DL-0291).
 *
 * Money stays decimal (Money/decimal.js); no floating point (AGENTS.md §4).
 */
import { Money } from '@ledgerforce/shared/money';

/** Max days between the book transaction's date and the line's posting date for an exact match. */
export const MATCH_WINDOW_DAYS = 14;
/** References shorter than this (after normalising) are too weak to match on. */
export const MIN_REFERENCE_LENGTH = 4;

export interface MatchLine {
  readonly id: string;
  /** Signed decimal string: + money in, − money out. */
  readonly amount: string;
  readonly description: string;
  readonly reference: string | null;
  /** YYYY-MM-DD. */
  readonly postedOn: string;
}

export type CandidateKind = 'customer_receipt' | 'supplier_payment';

export interface MatchCandidate {
  readonly kind: CandidateKind;
  /** The source document (receipt id, payment batch id). */
  readonly id: string;
  /** Its posted journal entry. */
  readonly entryId: string;
  /** Signed as the bank sees it: + money in, − money out. */
  readonly amount: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  /** References the bank line may carry (receipt reference / number, batch number / bank ref). */
  readonly references: readonly string[];
}

export type RuleField = 'description' | 'reference' | 'text';
export type RuleOperator = 'contains' | 'equals' | 'starts_with';
export type RuleDirection = 'in' | 'out' | 'any';

export interface RuleCondition {
  readonly field: RuleField;
  readonly op: RuleOperator;
  readonly value: string;
}

/** The stored, validated rule definition (app.bank_match_rule.definition). */
export interface MatchRuleDefinition {
  readonly match: 'all' | 'any';
  readonly conditions: readonly RuleCondition[];
  readonly direction: RuleDirection;
  /** Absolute amount bounds, inclusive, decimal strings; null = unbounded. */
  readonly amountMin: string | null;
  readonly amountMax: string | null;
}

export interface MatchRule extends MatchRuleDefinition {
  readonly id: string;
  readonly name: string;
  /** Lower runs first. */
  readonly priority: number;
  /** The GL account the rule suggests for the counter line. */
  readonly accountId: string;
}

export type MatchSuggestion =
  | { readonly lineId: string; readonly kind: 'candidate'; readonly candidate: MatchCandidate }
  | {
      readonly lineId: string;
      readonly kind: 'rule';
      readonly ruleId: string;
      readonly accountId: string;
    };

export interface MatchPlan {
  readonly auto: readonly { readonly lineId: string; readonly candidate: MatchCandidate }[];
  readonly suggestions: readonly MatchSuggestion[];
}

export class MatchRuleError extends Error {
  readonly code = 'INVALID_MATCH_RULE';
  constructor(message: string) {
    super(message);
    this.name = 'MatchRuleError';
  }
}

const FIELDS: readonly RuleField[] = ['description', 'reference', 'text'];
const OPS: readonly RuleOperator[] = ['contains', 'equals', 'starts_with'];
const DIRECTIONS: readonly RuleDirection[] = ['in', 'out', 'any'];
const AMOUNT_RE = /^\d{1,15}(\.\d{1,4})?$/;
const MAX_CONDITIONS = 10;
const MAX_VALUE = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function amountOrNull(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !AMOUNT_RE.test(v)) {
    throw new MatchRuleError(`${name} must be a plain non-negative decimal string`);
  }
  return v;
}

/** Validate a rule definition from user input; returns the normalised stored form. */
export function validateMatchRule(input: unknown): MatchRuleDefinition {
  if (!isRecord(input)) throw new MatchRuleError('a rule definition must be an object');
  const match = input['match'] ?? 'all';
  if (match !== 'all' && match !== 'any') throw new MatchRuleError('match must be all or any');
  const raw = input['conditions'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CONDITIONS) {
    throw new MatchRuleError(`a rule needs 1 to ${String(MAX_CONDITIONS)} conditions`);
  }
  const conditions = raw.map((c: unknown, i): RuleCondition => {
    if (!isRecord(c)) throw new MatchRuleError(`condition ${String(i + 1)} must be an object`);
    const { field, op, value } = c;
    if (!FIELDS.includes(field as RuleField)) {
      throw new MatchRuleError(`condition ${String(i + 1)}: field must be ${FIELDS.join(', ')}`);
    }
    if (!OPS.includes(op as RuleOperator)) {
      throw new MatchRuleError(`condition ${String(i + 1)}: op must be ${OPS.join(', ')}`);
    }
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_VALUE) {
      throw new MatchRuleError(
        `condition ${String(i + 1)}: value must be 1 to ${String(MAX_VALUE)} characters`,
      );
    }
    return { field: field as RuleField, op: op as RuleOperator, value: value.trim() };
  });
  const direction = input['direction'] ?? 'any';
  if (!DIRECTIONS.includes(direction as RuleDirection)) {
    throw new MatchRuleError(`direction must be ${DIRECTIONS.join(', ')}`);
  }
  const amountMin = amountOrNull(input['amountMin'], 'amountMin');
  const amountMax = amountOrNull(input['amountMax'], 'amountMax');
  if (
    amountMin !== null &&
    amountMax !== null &&
    Money.of(amountMin, 'AUD').compare(Money.of(amountMax, 'AUD')) > 0
  ) {
    throw new MatchRuleError('amountMin must not exceed amountMax');
  }
  return { match, conditions, direction: direction as RuleDirection, amountMin, amountMax };
}

const lower = (s: string | null): string => (s ?? '').toLowerCase().trim();

function conditionHolds(c: RuleCondition, line: MatchLine): boolean {
  const v = c.value.toLowerCase();
  const fields =
    c.field === 'text'
      ? [lower(line.description), lower(line.reference)]
      : [lower(c.field === 'description' ? line.description : line.reference)];
  return fields.some((f) =>
    c.op === 'contains' ? f.includes(v) : c.op === 'equals' ? f === v : f.startsWith(v),
  );
}

// Currency is irrelevant to comparisons of plain decimals; AUD gives Money its 4-dp scale.
const money = (s: string): Money => Money.of(s, 'AUD');

/** Whether a rule's direction, amount bounds and conditions all accept the line. */
export function ruleMatches(rule: MatchRuleDefinition, line: MatchLine): boolean {
  const amount = money(line.amount);
  if (rule.direction === 'in' && !amount.isPositive()) return false;
  if (rule.direction === 'out' && !amount.isNegative()) return false;
  const abs = amount.abs();
  if (rule.amountMin !== null && abs.compare(money(rule.amountMin)) < 0) return false;
  if (rule.amountMax !== null && abs.compare(money(rule.amountMax)) > 0) return false;
  return rule.match === 'all'
    ? rule.conditions.every((c) => conditionHolds(c, line))
    : rule.conditions.some((c) => conditionHolds(c, line));
}

/** Upper-case alphanumeric tokens: "inv-000123," → "INV 000123". */
const tokens = (s: string | null): string =>
  (s ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, ' ')
    .trim();

/** Whether a book reference appears in the line's reference or description as whole tokens. */
export function referenceFound(reference: string, line: MatchLine): boolean {
  const ref = tokens(reference);
  if (ref.replace(/ /g, '').length < MIN_REFERENCE_LENGTH) return false;
  return [line.reference, line.description].some((field) =>
    ` ${tokens(field)} `.includes(` ${ref} `),
  );
}

const dayNo = (iso: string): number =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

function isExact(line: MatchLine, c: MatchCandidate): boolean {
  return (
    money(line.amount).equals(money(c.amount)) &&
    Math.abs(dayNo(line.postedOn) - dayNo(c.date)) <= MATCH_WINDOW_DAYS &&
    c.references.some((r) => referenceFound(r, line))
  );
}

/**
 * Plan matches for unmatched lines against unmatched candidates and active rules. Pure and
 * deterministic: lines keep their order, rules run by (priority, name, id).
 */
export function planMatches(
  lines: readonly MatchLine[],
  candidates: readonly MatchCandidate[],
  rules: readonly MatchRule[],
): MatchPlan {
  const exact = new Map(lines.map((l) => [l.id, candidates.filter((c) => isExact(l, c))]));
  const linesPerCandidate = new Map<string, number>();
  for (const found of exact.values()) {
    for (const c of found) {
      const key = `${c.kind}:${c.id}`;
      linesPerCandidate.set(key, (linesPerCandidate.get(key) ?? 0) + 1);
    }
  }
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const auto: { lineId: string; candidate: MatchCandidate }[] = [];
  const suggestions: MatchSuggestion[] = [];
  for (const line of lines) {
    const found = exact.get(line.id) ?? [];
    const only = found.length === 1 ? found[0] : undefined;
    if (only && linesPerCandidate.get(`${only.kind}:${only.id}`) === 1) {
      auto.push({ lineId: line.id, candidate: only });
      continue;
    }
    for (const candidate of found)
      suggestions.push({ lineId: line.id, kind: 'candidate', candidate });
    const rule = ordered.find((r) => ruleMatches(r, line));
    if (rule) {
      suggestions.push({
        lineId: line.id,
        kind: 'rule',
        ruleId: rule.id,
        accountId: rule.accountId,
      });
    }
  }
  return { auto, suggestions };
}
