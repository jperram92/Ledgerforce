---
id: RQ-0003
title: CEL implementation for TypeScript rule expressions, with safe decimal money arithmetic
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: []
linked_adrs: []
---

# RQ-0003 — CEL in JavaScript/TypeScript and decimal money

## Question

Which maintained JS/TS CEL library should `packages/rules` use for sandboxed, user-written rule
expressions (design §4.5, §7.1), and how do we evaluate money in CEL without floating point
(AGENTS.md §4: floats on money are banned)?

## Why it matters

Custom journal rules (`let: base: opportunity.Amount * opportunity.Deposit_Percent__c / 100`)
compute posted amounts. Standard CEL has `int` (int64), `uint` and `double` only — no decimal.
`0.1 + 0.2` in a double-based evaluator produces a wrong ledger amount.

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `npm view` for `@marcbachmann/cel-js`, `cel-js`, `@bufbuild/cel`, `cel-javascript` (registry.npmjs.org) | 2026-10-24 | primary (registry) | marcbachmann 8.0.0 (2026-07-07, MIT, zero deps, steady releases 7.5→8.0 in 2026); `cel-js` (ChromeGG) 0.8.2 last modified 2025-07-11, deps chevrotain+ramda; `@bufbuild/cel` 0.6.1 (2026-09-16, Apache-2.0, pre-1.0, needs `@bufbuild/protobuf`); `cel-javascript` 0.0.19, 2024, UNLICENSED. |
| S2 | `@marcbachmann/cel-js@8.0.0` README (from the installed package) | 2026-10-24 | primary | "Most of the CEL Spec — macros, custom functions and types, optional chaining"; `Environment` with `registerType`, `registerFunction`, `registerOperator`, `registerVariable`, `check()`; parse limits `maxAstNodes`, `maxDepth`, `maxListElements`, `maxMapEntries`, `maxCallArguments`; ints are `BigInt`; ~10× faster than `cel-js`. |
| S3 | `@bufbuild/cel@0.6.1` README | 2026-10-24 | primary | CEL evaluator for ECMAScript from Buf (cel-es); protobuf-centric type mapping; `number` → `double`. |
| S4 | Experiment `scripts/cel-decimal.mjs` (scratchpad) against `@marcbachmann/cel-js@8.0.0` + `decimal.js` | 2026-10-24 | experiment | Results below. |
| S5 | https://github.com/google/cel-spec (referenced by both READMEs) | 2026-10-24 | primary (by reference) | CEL numeric types are int64, uint64, double; no decimal type. |

## Findings

1. **Library landscape (S1–S3).** `@marcbachmann/cel-js` is the most actively maintained, has no
   runtime dependencies, typed `Environment`, custom types **and custom operator overloads**,
   and parse-time structural limits. `cel-js` (ChromeGG) is slower and less active.
   `@bufbuild/cel` is backed by a company and aims at spec conformance but is pre-1.0 and
   protobuf-oriented (drags in `@bufbuild/protobuf`), with no documented operator overloading for
   custom types.
2. **Experiment (S4), @marcbachmann/cel-js 8.0.0:**
   - `0.1 + 0.2` → `0.30000000000000004` (plain double — the hazard is real).
   - Integer literals evaluate to `bigint`; `9223372036854775807 + 1` → `integer overflow` error.
   - `1 + 0.5` → `no such overload: int + double` (CEL does not silently mix int/double).
   - After `registerType('decimal', {ctor: Decimal})` + `registerFunction('dec(string): decimal')`
     + `registerOperator('decimal + decimal' | '-' | '*' | '/' | '<' | '>' | '==')`:
     `dec("0.1") + dec("0.2")` → `0.3`; `round2(amount * pct / 100)` with amount
     `1234.5678`, pct `12.5` → `154.32`; `amount > dec("1000")` → `true`.
   - `amount + 0.1` (decimal + double) → **rejected** `no such overload: decimal + double`;
     `env.check('amount + 0.1')` → `valid:false` — the type checker catches it before evaluation.
   - `limits: {maxDepth: 5}` rejects a deeper expression at parse time.
3. CEL itself is non-Turing-complete and side-effect free; the library evaluates an AST (no
   `eval`/`Function`), so the "sandbox" requirement is met as long as registered functions are
   pure (design §4.5).
4. Salesforce numeric/currency fields arrive as JSON numbers; if passed straight in they become
   CEL `double`. They must be converted to `decimal` at the binding layer from the **string**
   representation (or from the Avro/JSON source text), never via `Number`.

## Conclusion / decision

- Use **`@marcbachmann/cel-js`** (pin exact version, currently 8.0.0) behind a thin
  `packages/rules` facade. New runtime dependency ⇒ ADR required (design §10.6).
- Register a `decimal` custom type backed by **decimal.js** (already the money library) with
  operators `+ - * /`, comparisons, and functions `dec(string)`, `round(decimal, int, mode)`,
  `gross(decimal, taxcode)`, `tax(decimal, taxcode)`. Money and rate variables are declared as
  `decimal`; percentages too.
- **Ban `double` in rules**: run `env.check()` at rule save/activation and additionally walk the
  AST to reject double literals and the `double()` conversion; reject any expression whose result
  type for an amount field is not `decimal`. Activation already requires balanced test cases
  (design §4.5).
- Set parse limits (e.g. `maxAstNodes: 2000, maxDepth: 50`) and evaluate with a wall-clock
  guard in the worker.
- Fallback if the library is abandoned: `@bufbuild/cel` with money as scaled `int`
  (1/10000 units, matches NUMERIC(19,4)) — keep the facade so the swap is local.

## Confidence

High for the arithmetic behaviour (executed). Medium for long-term maintenance (single
maintainer; mitigated by facade + conformance tests from cel-spec run in our CI).

## Follow-ups

- ADR: "CEL via @marcbachmann/cel-js with decimal custom type" (architecture; auto-accept path).
- Test-author: property test that every rule fixture evaluates identically with
  decimal.js reference arithmetic.

**Affects:** `packages/rules`, Rules Studio (Phase 1), posting engine preview, design §4.5, §7.1, ADR-0005.
