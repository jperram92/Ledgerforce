---
adr: 0067
title: "Persist only the setup wizard's completion record; derive step status and validate from module state"
status: Accepted
date: 2026-11-13
author: claude
category: data
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0067: Persist only the setup wizard's completion record; derive step status and validate from module state

## Status

Accepted 2026-11-13 by claude under design §10.6 (category data, no human gate); subject to
cross-provider review of T-0123.

## Context and problem statement

Design §4.1 defines a ten-step setup wizard; T-0123 makes it persisted per company: each step is
not started, in progress or complete, steps unlock in order, and a step completes only when its
validator passes. The card requires that validators "read the owning module's state and never
duplicate it". RQ-0149 mapped every step to the module that already owns its state and found
that only two things belong to the wizard itself: *that* a step was completed (by whom, when)
and, for step 9 only, the declaration that a new business has no history to convert.

A new tenant-owned table is a data-model change (design §10.6), hence this ADR.

## Decision drivers

- One source of truth per setting (design principle 3, configuration as data in its module).
- Steps unlock in order; completion is a fact with an actor (audit, design §6.8).
- Forward-only additive migrations; tenant isolation with RLS ENABLE + FORCE (AGENTS.md §4).
- Step 9's "no history" outcome needs a reason that survives (card *Context*).

## Considered options

1. **Completion record only** — one row per company and completed step; status derived.
2. **Full state row per step** — ten rows created up front with a mutable status column.
3. **Wizard-owned settings document** — a JSON column holding each step's answers.

### Option 1 — completion record only

- Good, because nothing a module owns is copied; validators always see live state.
- Good, because rows are written once; no status transitions to guard.
- Bad, because "in progress" is derived (the first incomplete step), not stored.

### Option 2 — full state row per step

- Good, because status is a plain read.
- Bad, because rows must be seeded per company and kept consistent with the unlock order.

### Option 3 — wizard-owned settings document

- Bad, because it duplicates module settings (forbidden by the card) and drifts.

## Decision outcome

Chosen option: **Option 1**, because it satisfies the no-duplication rule with the smallest
schema and no update path.

Rules:

1. Table `app.setup_wizard_step` (migration 0065, owner `@ledgerforce/setup`): `tenant_id`,
   `company_id`, `step` 1–10, `outcome` `validated` | `no_history`, `reason`, `completed_by`,
   `completed_at`; primary key `(tenant_id, company_id, step)`. `no_history` is allowed for step 9
   only and requires a reason of 1–500 characters; `validated` carries no reason.
2. RLS ENABLE + FORCE, `tenant_isolation` policy; `lf_app` SELECT, INSERT, UPDATE (DL-0473
   default), no DELETE. The module never updates a row; completion is `INSERT … ON CONFLICT DO
   NOTHING` so a repeat is idempotent.
3. Step status is derived: `complete` (row exists), `in_progress` (first step without a row; it
   is the only unlocked incomplete step), `not_started` (locked). The wizard is complete when all
   ten rows exist.
4. A step is completed only if every earlier step is complete and its validator returns no
   missing items (step 9 may instead record `no_history`). Validators live in
   `@ledgerforce/setup` and call or read the owning module (RQ-0149 table).
5. Completing step 1 seeds the default overdue-reminder schedule (`seedReminderSchedule`, ar) in
   the same transaction (card AC-6, UC-04 precondition).
6. The HTTP contract (`GET /setup/wizard`, `POST /setup/wizard/steps/:n/complete`) is built in
   T-0157 on top of this module API; it returns the derived view and never accepts a status.

## Consequences

### Good

- A completed wizard can never disagree with module state without showing it (`valid: false`
  on a regressed step).
- No UPDATE/DELETE path in the module.

### Bad / accepted trade-offs

- No "reopen step" in the MVP; a regressed step is visible but stays complete.
- Each wizard read runs ten validators (cheap single-company queries; the gap check is the
  largest).

### Follow-ups

- T-0157 API routes; T-0158 module-owned settings for steps 3, 8, 10 (RQ-0149 Q2).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Unlock order, validators, refusal lists missing items, step 9 no-history, AC-6 seed | `packages/modules/setup/src/wizard.flow.db.test.ts` | `pnpm test:db` (verify.sh) |
| CHECK constraints refuse bad outcomes/reasons/steps; lf_app cannot DELETE | `packages/modules/setup/src/wizard.flow.db.test.ts` | `pnpm test:db` |
| RLS ENABLE + FORCE, policy, grants, cross-tenant isolation | `packages/db/src/rls.db.test.ts` (auto-discovers the table) | `pnpm test:db` |

## Links

- Design: §4.1, §4.4, §5, §6.4–6.5, §10.6
- Research: RQ-0149
- Decision log: DL-0520, DL-0521, DL-0522
- Related ADRs: ADR-0061 (system-role bindings)
- External sources: https://learn.microsoft.com/en-gb/dynamics365/business-central/ui-get-ready-business (2026-11-13)
