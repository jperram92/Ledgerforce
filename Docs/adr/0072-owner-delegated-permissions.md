---
adr: 0072
title: "New permissions for invoice approval, customer refunds and the setup wizard"
status: Accepted
date: 2026-11-14
author: claude
category: security
human_gate: yes
supersedes: none
superseded_by: none
---

# ADR-0072: New permissions for invoice approval, customer refunds and the setup wizard

## Status
Accepted under the product owner's delegation of 2026-11-13: "Yes you are authorised to make all these decisions based off best practices" (DL-0477). Category: security.

## Context and problem statement
Three cards were blocked on permissions that the RBAC catalogue (ADR-0023) lacked:
- T-0132: approving one invoice over HTTP.
- T-0152: customer refunds.
- T-0157: the setup wizard routes.

Adding a permission or changing a role template is a security decision (AGENTS.md §6). The owner delegated it.

## Decision drivers
- Least privilege (OWASP ASVS V4 access control).
- Maker-checker for money that leaves the business or becomes revenue (COSO; design §6.5).
- Consistency with the existing templates (ADR-0023).

## Considered options
1. **Reuse existing permissions.** For example, `ar.invoice.create` would also approve, `ar.credit_note.*` would cover refunds, and `settings.chart.manage` would cover the wizard. This was rejected: a creator could approve their own work, and setup changes far more than the chart.
2. **Dedicated permissions with maker-checker role grants.** Chosen.

## Decision outcome
Four new permissions, all of kind write:

| Permission | Holders | Note |
|---|---|---|
| `ar.invoice.approve` | Owner, Finance Admin, Approver | Same holders as `ar.batch.approve`. SoD: the draft's creator may not approve it, except in small-team mode (T-0132 implements this). |
| `ar.refund.create` | Owner, Finance Admin, AR Clerk | Creates, never approves. |
| `ar.refund.approve` | Owner, Finance Admin, Approver | SoD: the refund's creator may not approve it. Bank refunds are paid only through the AP payment batch and its release rules; Stripe refunds are sent only after approval (T-0152). |
| `settings.setup.manage` | Owner, Finance Admin | Setup wizard routes (T-0157). |

None of the four is on the API-token deny-list, consistent with `ar.credit_note.approve`.

Migration 0068 widens `app.permission_known`. The catalogue in `packages/shared/src/rbac/catalogue.ts` holds the role templates.

## Consequences
- The RBAC matrix test lists the exact holders of each permission. The DB mirror test proves migration 0068 matches the catalogue.
- Each implementing card writes its SoD rule test-first.
