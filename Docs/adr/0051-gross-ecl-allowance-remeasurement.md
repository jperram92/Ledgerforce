---
adr: 0051
title: "Measure the ECL scenario on gross receivables and remeasure after GST relief"
status: Accepted
date: 2026-11-10
author: codex
category: accounting
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0051 — Gross ECL allowance and subsequent remeasurement

## Status

Accepted under the standing accounting delegation in AGENTS.md section 6; research RQ-0133 and decision DL-0316. Implementation review remains independent.

## Context and problem statement

Source 872c4fa GP-007-A measures an allowance of 1,375.00 before GST relief, writes off net loss of 1,250.00 against it and later releases 125.00. Canonical GP-024/025 describe the starting allowance as ex GST. Both have the same write-off journal. Canonical IDs and accounts must survive the selective port (DL-0310).

## Decision drivers

- Preserve approved historical expectations and source provenance.
- Distinguish contractual receivable losses from statutory GST adjustments.
- Avoid releasing allowance attributable to other customers.

## Considered options

1. Keep only the ex-GST scenario: simple, but does not represent the source gross-loss assumption.
2. Add a gross-allowance lifecycle with explicit later remeasurement: chosen; adds the missing scenario without replacing working write-off code.
3. Automatically release the company's residual allowance on each write-off: rejected; collective allowances may cover other debts.

## Decision outcome

GP-038 adds a gross-loss scenario for an entity with a 2026 calendar reporting year. Recognise 1,375.00 expected credit loss before statutory relief arises. On write-off, debit allowance 1,250.00 and GST collected 125.00, credit AR 1,375.00. At subsequent reporting-date assessment, release only the 125.00 no longer required, through impairment profit/loss. Keep canonical account bindings and GST-ADJ.

The new entry supersedes only blanket ex-GST measurement wording in GP-024/025; original entries are untouched and remain replayable. Partial-loss estimates remain estimates. This does not change direct-write-off elections or security approval requirements.

## Consequences

### Good

Source gross allowance and subsequent release become testable in canonical code. No new dependency, migration or ledger bypass.

### Bad / accepted trade-offs

The portfolio reassessment is an explicit authorised journal, not automatic per-invoice clearing. No new estimation UI is introduced.

### Follow-ups

Complete other source gaps separately, especially single-supply deposits.

## Compliance and verification

| Check | Where | Gate |
| --- | --- | --- |
| All three journals replay line for line | ledger golden unit/DB runners | 2, 4 |
| Real write-off, residual allowance, release and basis-specific BAS | ar/src/gross-allowance.db.test.ts | 2b |
| Existing expectations byte-preserved | diff against parent before append | 4, 11 |

## Links

Implementation addendum (DL-0317): GP-039 supersedes GP-038's incorrect source-to-canonical party/tax attribution. Keep historical GP-038 unchanged; use GP-039 for the module lifecycle. This does not alter the accounting amounts or remeasurement decision.

- Design sections 3.8 and 3.10.
- RQ-0133 (primary sources and inference limits).
- DL-0310 (canonical lineage), DL-0316 (adoption and mapping).
- Source: 872c4fa, GP-007-A A1/A2/A4; no source approval is applied to unrelated canonical IDs.
