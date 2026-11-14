---
adr: 0075
title: "HTTP routes for the setup wizard: read the steps, complete a step"
status: Proposed
date: 2026-11-14
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0075: HTTP routes for the setup wizard

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. The category is
architecture, a public API change. It adds no permission (ADR-0072 already added
`settings.setup.manage`), no table, no migration and no dependency, so it has no human gate.

## Context and problem statement
ADR-0067 persists the setup wizard (design §4.1) as a completion record per company and step;
status, lock and what is missing are derived by `wizardOf` and `completeWizardStep` in
`@ledgerforce/setup` (T-0123). ADR-0067 rule 6 leaves the HTTP contract to T-0157. The wizard
screen (T-0091) reads and completes steps only through these routes. DL-0477 item 4 and ADR-0072
gave the routes their own permission, `settings.setup.manage` (Owner, Finance Admin).

## Decision drivers
- Thin controller over the module API; the server derives status and never accepts one
  (ADR-0067 rule 6).
- apps/api rules: idempotency key on every mutation, audit every mutation, tenant transaction.
- Least privilege (ADR-0072) without needing a new "any of" permission mechanism.

## Considered options
1. **Reading needs `settings.setup.manage` too.** Rejected: an Accountant or Auditor could not
   see how far setup has got, and the view changes nothing.
2. **Reading needs `settings.read` (chosen, DL-0590).** Every holder of `settings.setup.manage`
   (Owner, Finance Admin) also holds `settings.read`, so one permission covers both, and the
   permission decorator stays single-valued. The Auditor and Accountant may read.
3. **An "any of" permission decorator.** Rejected: a security-model change for no extra reach,
   since option 2 already admits every setup manager.

## Decision outcome

| Route | Access | Body / answer |
|---|---|---|
| `GET /setup/wizard?company_id=&as_of=` | `settings.read` | `{company_id, as_of, complete, steps[]}` |
| `POST /setup/wizard/steps/:n/complete` | `settings.setup.manage`, `Idempotency-Key` | body `{company_id, as_of?, no_history_reason?}`; answers the step view plus `replayed` |

A step view is `{step, title, status, locked, valid, missing[], outcome, reason, completed_at,
completed_by}`; `status` is `not_started`, `in_progress` or `complete`; `outcome` is `validated`,
`no_history` or null.

`as_of` (YYYY-MM-DD) is the date the validators check (tax codes in force, posting-profile gaps).
It defaults to today in the tenant's report time zone (`app.sod_report_timezone()`, ADR-0026).

| HTTP | Body `error` | When |
|---|---|---|
| 201 | — | The step was completed now; audited (`setup_wizard_step`, id `<company>:<step>`). |
| 200 | — | Replay: the step was already complete; nothing is written, `replayed: true`. |
| 400 | `idempotency_key_required` | No `Idempotency-Key` header (or longer than 200). |
| 400 | `invalid_request` | `company_id` not a uuid, `as_of` not a date, step not 1–10, bad reason. |
| 403 | `forbidden` | The caller lacks the route's permission. |
| 404 | `UNKNOWN_COMPANY` | The company is unknown, including another tenant's (RLS). |
| 409 | `STEP_LOCKED` | An earlier step is not complete. |
| 422 | `STEP_INVALID` + `missing[]` | The step's validator lists what is missing. |
| 422 | `NO_HISTORY_NOT_ALLOWED` | A no-history reason on a step other than 9, or with an opening balance. |

**Idempotency.** The completion record's primary key (tenant, company, step) is the replay
record, as for the close checklist and period reopen (DL-0420): a repeat of a completed
step answers 200 with the stored record, whoever sends it, because completing a step is a fact
about the company and the repeat changes nothing. The key header is still required so every
client of a mutating route behaves the same way (apps/api rule); no key column is added (no
migrations in this round, DL-0560).

## Consequences
- The T-0091 screen can render the steps and drive completion.
- No OpenAPI file exists in the repository yet, so this ADR records the contract.
- No reopen route (ADR-0067: no reopen in the MVP).
