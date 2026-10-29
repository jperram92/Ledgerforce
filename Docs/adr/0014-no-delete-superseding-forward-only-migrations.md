---
adr: 0014
title: "No-delete policy: superseding instead of deletion; forward-only additive migrations"
status: Accepted
date: 2026-10-24
author: human
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0014: No-delete policy — superseding instead of deletion; forward-only additive migrations

## Status

Accepted — 2026-10-24. Product-owner directive (DL-0004), recorded as an ADR by claude because
it constrains the data model and migrations (a §10.6 trigger).

## Context and problem statement

The product owner directed: "never delete anything". For an accounting system this matches
design principle 2 (nothing posted is ever edited or deleted) and the 5–7-year record-retention
obligations (§6.8). In an agent-driven build, deletions are also the hardest mistakes to detect
and recover: an agent "cleaning up" a failing test, an ADR, a run log or a database column
destroys evidence and can break other tenants' data. Migrations must apply forward on a copy of
the previous release's schema (§10.8 gate 6), so destructive migrations are also an upgrade risk
for self-hosters.

## Decision drivers

- Audit trail and evidence must be complete (decisions, research, runs, screenshots).
- Accounting history is immutable (ADR-0004).
- Safe upgrades for self-hosted installs (no data loss on `migrate`).
- Easy to check mechanically in CI.

## Considered options

1. **No deletion at all; supersede with forward links; forward-only additive migrations
   (expand → backfill → deprecate; never drop/rename in place).**
2. **Deletion allowed with human approval.**
3. **Normal practice: delete freely; rely on Git history and reversible (up/down) migrations.**

### Option 1
- Good: nothing is ever lost; history readable in place (not only in `git log`).
- Good: simple CI rule (no `D` entries in diffs of tracked files; no `DROP`/`RENAME` in migrations).
- Bad: dead files and deprecated columns accumulate; schema carries legacy columns.

### Option 2
- Good: flexibility. Bad: adds human-gate load for trivial cleanups; easy to rubber-stamp.

### Option 3
- Good: tidy repo. Bad: Git history is not where agents look; down-migrations that drop columns
  destroy data; contradicts the directive.

## Decision outcome

Chosen option: **Option 1**.

1. No `rm` of tracked files, no `git rm`, no history rewrite (force-push, rebase of shared
   branches). Untracked build output (`node_modules/`, `dist/`, `coverage/`) may be regenerated.
2. Tasks, ADRs, decision-log entries, research records, run logs and evidence are never deleted
   or rewritten after merge; they are **superseded**: the old item gets a status/forward link
   only, the new item references what it supersedes.
3. Users are disabled, never deleted (§6.3 leaver); modules disabled per tenant keep history (§4.6).
4. Migrations are forward-only and additive: no `DROP TABLE/COLUMN`, no `RENAME`, no type
   narrowing in place. To change a structure: add new → backfill → switch reads/writes → mark
   old deprecated (SQL `COMMENT ON` + ADR). No down-migrations that destroy data.
5. Personal-data erasure requests (e.g. GDPR, §6.10) are a future, explicitly-designed
   exception via anonymisation, decided by its own ADR — not ad-hoc deletes.

## Consequences

### Good
- Complete, reviewable history; upgrades never lose data.

### Bad / accepted trade-offs
- Repository and schema grow; deprecated artefacts need clear marking.
- Some refactorings take three migrations instead of one.

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| `git diff --name-status --diff-filter=DR <base>...HEAD` lists no deleted/renamed tracked files (outside regenerable build output) | `scripts/agent/verify.sh` no-delete step | verify.sh |
| Migration lint: no `DROP TABLE`, `DROP COLUMN`, `RENAME`, `TRUNCATE`, `ALTER … TYPE` narrowing | migration check script (backlog) | §10.8 gate 6 |
| Migrations apply forward on previous release's schema | migration upgrade test | gate 6 |
| PR template checklist: "No files deleted" | `.github/pull_request_template.md` | review gate 8 |

## Links

- Design: principle 2, §4.6, §6.3, §6.8, §10.8 gate 6
- Decision log: DL-0004
- Related ADRs: ADR-0001, ADR-0004, ADR-0013
