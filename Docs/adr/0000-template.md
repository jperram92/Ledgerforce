---
adr: NNNN
title: "<short imperative title of the decision>"
status: Proposed            # Proposed | Accepted | Rejected | Superseded by ADR-NNNN
date: YYYY-MM-DD            # date of the latest status change
author: <human | claude | codex>
category: architecture      # architecture | accounting | security | integration | data | process | tooling
human_gate: no              # yes for accounting and security (and anything in design §11.2); status stays Proposed until the product owner accepts
supersedes: none            # ADR-NNNN if this replaces an earlier ADR
superseded_by: none         # filled in (only this line) when a later ADR supersedes this one
---

# ADR-NNNN: <title>

> Copy this file to `Docs/adr/NNNN-<kebab-slug>.md` (next free number, never reuse one),
> fill every section, add a row to the index in [`README.md`](README.md) and a decision-log
> entry that links back here. Delete nothing from this template's structure — write "n/a"
> with a reason if a section genuinely does not apply.

## Status

<Proposed | Accepted | Rejected | Superseded by [ADR-NNNN](NNNN-....md)> — <one line: who
accepted it and how, e.g. "Accepted 2026-11-02 by product owner via PR #12 label adr:accounting"
or "Accepted on green CI + cross-review by codex, PR #14">.

## Context and problem statement

<What is the situation and the forces at play? Quote the design section, the use cases, the
research records (RQ-NNNN) and any external facts — with sources. Write it so that an agent
that has never seen the chat history understands why a decision is needed now.>

## Decision drivers

- <driver 1 — e.g. design principle, regulatory requirement, operational constraint>
- <driver 2>
- <driver 3>

## Considered options

1. **<Option A>** — <one-line summary>
2. **<Option B>** — <one-line summary>
3. **<Option C>** — <one-line summary>

### Option A — <name>

- Good, because <…>
- Good, because <…>
- Bad, because <…>

### Option B — <name>

- Good, because <…>
- Bad, because <…>

### Option C — <name>

- Good, because <…>
- Bad, because <…>

## Decision outcome

Chosen option: **<Option X>**, because <justification that ties back to the drivers>.

<Precise statement of the rule(s) this ADR imposes — written so a reviewer can check code
against it.>

## Consequences

### Good

- <…>

### Bad / accepted trade-offs

- <…>

### Follow-ups

- <tasks (T-NNNN), research (RQ-NNNN) or later ADRs this creates>

## Compliance and verification

How do tests and CI prove the decision is being followed? Name the concrete test, lint rule
or `verify.sh` gate (design §10.8), and what a failure looks like.

| Check | Where | Gate |
|---|---|---|
| <e.g. "UPDATE on posted journal_line raises"> | <e.g. `packages/ledger/test/immutability.spec.ts`> | <e.g. verify.sh gate 2> |

## Links

- Design: <§ references in `Docs/solution-design/solution-design.md`>
- Research: <RQ-NNNN>
- Decision log: <DL-NNNN>
- Related ADRs: <ADR-NNNN>
- External sources: <URLs, with retrieval date>
