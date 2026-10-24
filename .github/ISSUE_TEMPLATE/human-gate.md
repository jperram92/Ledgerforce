---
name: Human gate decision
about: Ask the product owner for a decision that agents may not take (accounting/security ADR, golden postings, release/phase gate, design §11.2 open decision, out of scope)
title: "[human-gate] <short question>"
labels: ["human-gate"]
assignees: []
---

## Gate type

- [ ] ADR acceptance — accounting (`adr:accounting`)
- [ ] ADR acceptance — security (`adr:security`)
- [ ] Golden postings — new or changed expectation (`golden_postings`)
- [ ] Release / phase gate (design §9)
- [ ] Open decision from design §11.2 (name it: …)
- [ ] Outside the scope of the solution design

## Question for the product owner

<One clear question that can be answered with a choice. No more than a few sentences.>

## Context

- Task: `T-NNNN` · Branch / PR: #…
- Design section(s): §…
- ADR / research: ADR-NNNN · RQ-NNNN
- Raised by: <claude | codex> on YYYY-MM-DD

## Options

| Option | Pros | Cons |
|---|---|---|
| A — … | … | … |
| B — … | … | … |

**Agent recommendation:** <option and one-line reason>

## What is blocked until this is decided

<Tasks / PRs that cannot merge. What agents will keep working on meanwhile.>

## Decision (filled in by the product owner)

- Decision: …
- Date: …
- Follow-up: agent records it as `DL-NNNN` (By: human) and updates ADR status / golden file status.
