---
id: RQ-NNNN
title: <one-line question>
status: open            # open | resolved | superseded
opened: YYYY-MM-DD
resolved:               # YYYY-MM-DD when status becomes resolved/superseded
opened_by: <claude | codex | human>
linked_tasks: []        # e.g. [T-0042]
linked_adrs: []         # e.g. [ADR-0007]
superseded_by:          # RQ-MMMM, only when status is superseded
---

# RQ-NNNN — <title>

## Question

State the question precisely enough that two researchers would look for the same thing.
Split compound questions into numbered sub-questions (Q1, Q2 …).

## Why it matters

Which task, ADR, use case or design section is blocked or at risk, and what goes wrong if we
guess. Cite the design section (e.g. `solution-design.md §5.3`).

## Sources consulted

One row per source actually opened. Prefer primary sources (vendor docs, legislation, regulator
guidance, source code, an executed experiment) over blogs. Record *how* you accessed it.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://… | YYYY-MM-DD | primary / secondary / experiment / source code | … |

## Findings

Numbered, factual, each one tied to a source id (S1, S2 …). Separate facts from inference;
label inference as such. Where sources disagree, say so and say which one you trust and why.

## Conclusion / decision

What the builders should do, in imperative sentences. Include the minimal code/config/SQL
snippet when it removes ambiguity. If this implies a decision, give the proposed decision-log
entry (and ADR if required by design §10.6).

## Confidence

`high` (primary source or executed experiment), `medium` (consistent secondary sources),
`low` (unverifiable — say how the build must hedge, e.g. make it configurable, add a
contract test, or flag for human review).

## Follow-ups

- Open items, re-check dates (for fast-moving vendor facts), tasks to create.

**Affects:** <task areas / modules / ADRs / design sections>
