---
adr: 0015
title: "Playwright screenshot evidence for every UI and report success scenario"
status: Accepted
date: 2026-10-24
author: claude
category: process
human_gate: no
supersedes: none
superseded_by: none
---

# ADR-0015: Playwright screenshot evidence for every UI and report success scenario

## Status

Accepted — 2026-10-24 (process/tooling). Product-owner directive "prove it with evidence"
(AGENTS.md §0.8). Playwright is already the design's E2E tool (§7.1).

## Context and problem statement

Use cases are the acceptance backbone (§8.2) and many outcomes are visual: a batch billing
preview (UC-02), a reconciliation report showing statement balance = book balance (UC-08), the
close checklist (UC-10), the Salesforce Lightning component (UC-12), invoice PDFs. A passing
unit test does not show the human that the screen or report is right, and agents can claim
success without having looked. The product owner wants evidence a non-developer can review
in the PR and that persists in the repository (a CI artefact expires).

## Decision drivers

- Human-reviewable proof per success scenario, stored in the repo.
- Same tool for E2E assertions and screenshots (no extra dependency).
- Works headless in agent sandboxes (Chromium + Playwright are available).
- Deterministic enough to be repeatable (fixed data, fixed viewport, fixed clock).

## Considered options

1. **Playwright tests that assert the scenario and save named screenshots (and, for reports,
   the rendered PDF/HTML) into `.agent/evidence/<task-id>/`, linked from the task card and the
   success-scenario register.**
2. **Manual screenshots by the human during acceptance.**
3. **Visual-regression snapshot service (hosted, e.g. Percy/Chromatic).**
4. **No screenshots; rely on assertions only.**

### Option 1
- Good: evidence produced by the same test that asserts behaviour; in the repo; reviewable in PRs.
- Bad: binary files grow the repo (mitigate: PNG, fixed viewport, only success scenarios,
  never deleted per ADR-0014).

### Option 2
- Good: human sees the real thing. Bad: slow, not repeatable, human bottleneck.

### Option 3
- Good: pixel diffing and review UI. Bad: external service, account/secrets, costs; evidence not
  in the repo.

### Option 4
- Good: cheapest. Bad: no human-visible proof; violates the directive.

## Decision outcome

Chosen option: **Option 1**.

1. Every success scenario with a UI or report has a Playwright test that asserts the outcome
   (not only takes a picture) and saves screenshots to
   `.agent/evidence/<T-NNNN>/<scenario-id>-<step>.png` (skill `evidence`).
2. Screenshots use seeded fixture data, a fixed viewport, a frozen clock and no real customer data
   or secrets.
3. The task card and `Docs/specs/success-scenarios.md` link the evidence; the PR template has an
   Evidence section.
4. Reports (TB, P&L, ageing, reconciliation) additionally save the rendered output (HTML/PDF).
5. Evidence is never deleted; re-runs add new files or overwrite only within the same task
   branch before merge.

## Consequences

### Good
- The human can accept scenarios by looking, not by running code.

### Bad / accepted trade-offs
- Repo size grows; evidence for later-changed screens becomes historical (kept, by design).

## Compliance and verification

| Check | Where | Gate |
|---|---|---|
| Evidence harness self-test renders a fixture page and writes a PNG into `.agent/evidence/<task>/` | `packages/testing` evidence harness test | §10.8 gate 2 |
| verify.sh: a task card with `ui: true` (or linked UI/report scenarios) has ≥ 1 evidence file per scenario | verify.sh evidence check (backlog) | verify.sh |
| PR template Evidence section filled | `.github/pull_request_template.md`, cross-review | gate 8 |

## Links

- Design: §7.1 (Playwright), §8.2 use cases, §10.8
- Related ADRs: ADR-0012, ADR-0014
- External: Playwright screenshots — https://playwright.dev/docs/screenshots
