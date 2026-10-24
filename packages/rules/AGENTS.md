# packages/rules — CEL evaluator and rule tester

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
Custom journal rules (design §4.5): the CEL expression evaluator, the YAML rule schema, the rule
tester and rule versioning.

## Local rules
- Expressions run in a **sandbox**: CEL only, no I/O, no network, no clock or randomness except
  through explicit inputs, bounded execution time and size.
- Money in expressions is evaluated with `decimal.js` semantics; no float conversion.
- The engine **refuses to activate** a rule whose test cases don't balance; rules are versioned
  and effective-dated; the **creator cannot activate their own rule** (second person required).
- Rules never write the ledger: a rule produces a proposed entry that goes through the posting
  engine's full pipeline; control accounts stay protected from rule-generated manual lines
  unless posted via their subledger.
- Every posted entry records the rule id and version that produced it.
- Choice of CEL implementation is a runtime dependency → ADR.

## Tests
`packages/rules/src/**/*.test.ts` (evaluation, schema validation),
`packages/rules/src/**/*.prop.test.ts` (activated rules always produce balanced entries;
sandbox cannot reach I/O).
