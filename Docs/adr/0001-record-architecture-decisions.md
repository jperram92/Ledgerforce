---
adr: 0001
title: "Record architecture decisions as MADR files in Docs/adr"
status: Accepted
date: 2026-10-24
author: claude
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0001: Record architecture decisions as MADR files in `Docs/adr`

## Status

Accepted — 2026-10-24. Design-committed (design §10.6 seed ADR table); process category, no
human gate. Accepted with the Sprint 0 framework.

## Context and problem statement

LedgerForce is built by AI agents from two providers (claude and codex) that hand work to each
other through the repository alone (design §10, decision D6). Neither provider can see the
other's chat history, and any session may end abruptly on a credit or quota error (§10.4). A
decision that exists only in a chat transcript is therefore lost the moment the session ends,
and the next agent may silently re-decide it differently.

The design requires an ADR for "any change to the data model, accounting treatment, security
model, public API, integration contract, or a new runtime dependency" (§10.6), and requires
that the human owns accounting and security judgement (§10.1 principle 6). We need a durable,
reviewable, diff-able record of significant decisions, a clear lifecycle, and a way to change a
decision without erasing its history (product-owner directive: never delete anything, DL-0004).

Small decisions are already captured chronologically in
[`Docs/decisions/decision-log.md`](../decisions/decision-log.md); this ADR is about the
significant ones.

## Decision drivers

- Repository is the only memory (AGENTS.md §0.1, design §10.1 principle 1).
- Both providers must read and write the same format with no tooling beyond a text editor.
- Accounting and security decisions need a human acceptance step that is visible in Git/GitHub.
- No deletion: decisions are superseded, never rewritten.
- Reviewers (human and cross-provider) must be able to see the decision in the same PR as the
  code that implements it.

## Considered options

1. **MADR-style Markdown files in `Docs/adr/`, one per decision, numbered, with YAML front matter.**
2. **Wiki / external tool (GitHub Wiki, Notion, Confluence).**
3. **Decisions only in the chronological decision log, no separate ADRs.**
4. **Decisions in PR descriptions / issue threads only.**

### Option 1 — MADR files in the repo

- Good, because they are versioned with the code, reviewed in the same PR and available in any
  checkout (offline, any provider).
- Good, because MADR is a widely used, lightweight template (context, drivers, options,
  outcome, consequences) that both model families already know.
- Good, because front matter (`status`, `category`, `human_gate`) is machine-checkable, so the
  conductor and `verify.sh` can block merges of unaccepted accounting/security ADRs.
- Bad, because it is one more file to maintain per decision and the index can drift (mitigated
  by an index check, see verification).

### Option 2 — External wiki / tool

- Good, because nicer editing and search.
- Bad, because it is not in the checkout: a codex session resuming a task cannot read it
  without extra credentials; it violates "repository is the only memory".
- Bad, because history and review are decoupled from the code change.

### Option 3 — Decision log only

- Good, because one place, minimal overhead.
- Bad, because a one-paragraph log entry cannot carry options, trade-offs and verification for
  decisions like tenancy or ledger immutability; reviewers need the reasoning.

### Option 4 — PR descriptions only

- Good, because zero extra files.
- Bad, because PR text lives on GitHub, not in the repo; it is hard to find later and is not
  superseded explicitly.

## Decision outcome

Chosen option: **Option 1 — MADR-style files in `Docs/adr/`**, complemented by the
chronological decision log (two-tier system, see
[`Docs/decisions/README.md`](../decisions/README.md)).

Rules:

1. One file per decision: `Docs/adr/NNNN-<kebab-slug>.md`, four-digit number, never reused.
   Start from [`0000-template.md`](0000-template.md).
2. Statuses: `Proposed`, `Accepted`, `Rejected`, `Superseded by ADR-NNNN`.
3. Categories: architecture, accounting, security, integration, data, process, tooling.
   `accounting` and `security` (and anything touching a design §11.2 open decision) set
   `human_gate: yes` and stay `Proposed` until the product owner accepts via the PR label
   `adr:accounting` / `adr:security`.
4. Other categories are accepted when CI is green and the cross-provider reviewer approves.
5. An accepted ADR is never deleted or rewritten. To change it, write a new ADR that
   supersedes it; the old file changes only its `status` / `superseded_by` lines (forward link).
6. Every ADR has a matching decision-log entry, and the index in [`README.md`](README.md) is
   updated in the same PR.
7. The `docs/adr` path in the design maps to `Docs/adr` (DL-0003).

## Consequences

### Good

- Any agent can reconstruct *why* the system is the way it is from a checkout.
- Human gates are explicit and auditable (labels, status in front matter).
- Decision drift between providers is caught in review.

### Bad / accepted trade-offs

- Overhead of writing an ADR for each significant change; mitigated by the `write-adr` skill
  and the template.
- Index in README can fall out of date; mitigated by a CI check (follow-up).

### Follow-ups

- Backlog task: `scripts/agent/check-adrs` (or a `verify.sh` step) that validates front matter,
  unique numbering, index completeness, and that no `Accepted` ADR file has been modified
  except for its status/superseded_by lines.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Every `Docs/adr/NNNN-*.md` has valid front matter (status, category, human_gate) and appears in the README index | ADR lint step (follow-up task) run by `scripts/agent/verify.sh` | verify.sh — docs gate |
| A PR that adds/changes an ADR with `human_gate: yes` cannot merge without the `adr:accounting` or `adr:security` label applied by the human | Branch protection + PR template "Human gates touched" section; cross-reviewer checklist | design §10.8 gate 8 (review) |
| No ADR file is deleted | `git diff --diff-filter=D` check on `Docs/` in verify.sh (no-delete gate, ADR-0014) | verify.sh |

## Links

- Design: §10.1, §10.2, §10.6
- Decision log: DL-0002, DL-0003, DL-0004
- Related ADRs: ADR-0011 (repo-resident agent state), ADR-0014 (no-delete policy)
- External: MADR — https://adr.github.io/madr/ ; Michael Nygard, "Documenting Architecture
  Decisions" (2011) — https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
