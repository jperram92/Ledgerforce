---
adr: 0056
title: "HTTP routes to reopen a hard-locked period: request, approve, list"
status: Accepted
date: 2026-11-13
author: claude
category: architecture
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0056: HTTP routes to reopen a hard-locked period

## Status
Proposed. It becomes Accepted on green CI plus cross-review by codex. The category is
architecture, a public API change. It adds no permission, table, migration or dependency, so it
has no human gate.

## Context and problem statement
Design §3.5 says a hard-locked period is changed by nobody, and reopening it needs two approvers
and an audit reason. §6.2 requires step-up re-authentication to reopen a locked period, and §6.5
rule 6 requires two approvers plus a written reason. Migration 0018 already enforces this in the
database (`app.period_reopen_request` and `app.period_reopen_approve`, SECURITY DEFINER), and
`@ledgerforce/ledger` wraps it (`requestReopen` and `approveReopen`, SS-PLAT-56). The HTTP layer
did not exist yet (T-0079).

## Decision
Add `PeriodReopenController` with three routes:

| Route | Access | Body / answer |
|---|---|---|
| `POST /periods/:periodId/reopen-requests` | `period.reopen` + step-up 300 s + SoD step `period_reopen_request.request` | `{to_status, reason}`. `to_status` is one of open, ar_locked, ap_locked or soft_closed, and `reason` is a trimmed string of 1–2000 characters. Answers 201 with the request view. |
| `POST /periods/reopen-requests/:requestId/approve` | `period.reopen` + step-up 300 s + SoD step `period_reopen_request.approve` (rule `SOD_PERIOD_REOPEN_SELF_APPROVAL`, never excepted) | Answers 200 with the request view, which now shows `status: approved` and the new `period_status`. |
| `GET /periods/:periodId/reopen-requests` | `reports.run` | `{period_id, period_status, requests[]}` |

The request view contains `id`, `period_id`, `company_id`, `to_status`, `reason`, `status`,
`requested_by`, `requested_at`, `approved_by`, `approved_at` and `period_status`.

Errors:

| HTTP | Body | When |
|---|---|---|
| 400 | `reason_required` | The reason is missing or blank. |
| 400 | `invalid_reopen_request` | `to_status` is invalid, or the id is not a uuid. |
| 400 | `invalid_sod_subject` | The approve id is not a uuid. |
| 401 | `step_up_required` | The caller has not stepped up recently enough. |
| 403 | `forbidden` / `sod_violation` | The caller lacks the permission, or would approve their own request. |
| 404 | — | The period or request is unknown, including another tenant's. |
| 409 | `reopen_request_pending` | Another request for the period is already pending. |
| 409 | `period_not_hard_locked` | The period is not hard-locked. |
| 409 | `reopen_request_not_pending` | The request was already approved by someone else. |
| 409 | `reopen_refused` | Any other refusal from the database function. |

Every mutation is audited twice:

- the database functions write `period.reopen_requested`, `period.reopen_approved` and `period.status_changed`;
- the interceptor writes one HTTP row with the described before and after values.

The step-up and SoD refusals are audited by the interceptor.

**Idempotency.** The apps/api rule says every mutating route takes an idempotency key. But
`app.period_reopen_request` has no key column, and this round may not add migrations (DL-0409).
So replays are recognised by state, as payment-batch release and bank-detail verify already do:

- The same requester, target and reason while the request is pending gets 200 with the same request.
- The same approver of an approved request gets 200 with the same result.
- Anyone else gets 409.

An `Idempotency-Key` header that the server could not store would only look like a guarantee, so
the routes do not take one. If a key column is wanted, it is a follow-up migration for the lead.

**SoD subject of the request step.** The database function chooses the request id. So the route
names a placeholder id before the handler runs, and the handler sets the real id on the same
subject object. The interceptor then records `period_reopen_request.request` against the real id
after the handler succeeds. The request step has no rule of its own, so the check itself does not
change.

## Consequences
- The web close screen can drive the reopen flow. Approvers see pending requests through the GET route.
- A reopened period cannot rerun the T-0078 close checklist: `app.close_checklist_step` has
  primary key (tenant, period, step) and is insert-only. Supporting a second checklist round needs
  schema work, for example a round or reopen-request column and a new key. It is reported as a
  follow-up (DL-0421) and not done here.
- No OpenAPI file exists in the repository yet, so this ADR records the contract.

## Alternatives considered
- **Accept an `Idempotency-Key` header without storing it.** Rejected, because it would be a
  guarantee the server does not keep.
- **Use the period id as the SoD subject.** Rejected, because a person who requested an earlier
  reopen of the same period could never approve a later one.
- **Read the request list with `period.reopen`.** Rejected, because that permission is in
  STEP_UP_PERMISSIONS, so a plain read would demand step-up.
