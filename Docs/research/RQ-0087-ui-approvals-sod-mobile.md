---
id: RQ-0087
title: How should approvals, segregation of duties and mobile approval be presented?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0087 — How should approvals, segregation of duties and mobile approval be presented?

## Question

Q1. What must an approval screen show so checkers check rather than rubber-stamp? Q2. What makes mobile approval work?

## Why it matters

Design §6.5 enforces SoD rules (two releasers over $10,000, author ≠ activator, small-team mode); principles P6–P8. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S16 | https://blog.xtrm.com/posts/maker-checker-workflows-mistakes ; https://rootstack.com/en/learning/maker-checker-module-approval-system-mifos ; https://docs.sumsub.com/docs/4-eyes-review ; https://docs.ripple.com/products/custody/governance/users | 2026-10-24 | vendor docs (search summary) | Record maker, checker, date, evidence; one user cannot approve twice; checker inbox with details and before/after compare; under volume checkers confirm entry not correctness; too many steps cause bottlenecks |
| S17 | https://approvalmax.com/mobile-approvals ; https://apps.xero.com/uk/search/app/approvalmax | 2026-10-24 | vendor (search summary) | One-tap decisions with comments and document; 4.8/5 from 603 Xero users |
| S27b | https://ones.com/blog/?p=1123684 | 2026-10-24 | secondary (search summary) | Approve/reject targets ≥ 48px, in thumb reach |
| S37 | https://dequeuniversity.com/resources/wcag-2.2 | 2026-10-24 | secondary (search summary) | WCAG 2.2 2.5.8 targets ≥ 24×24 CSS px |

## Findings

1. Approval screens must show the chain of named people, roles, times and state, plus the evidence and what will post (S16).
2. Rubber-stamping is a known failure; showing what changes and what it costs to wait counters it (S16, inference).
3. Mobile approval succeeds as one contextual decision (S17) with large targets (S27b, S37).

## Conclusion / decision

- Every open item names whose turn it is (proposed P13); approval screens show the people chain and the rule in one sentence, before the action.
- Show the posting preview and the consequence of waiting ("11 suppliers are paid a day late").
- Mobile: one decision per screen, primary target ≥ 48px.

## Confidence

`medium`: vendor documentation and one strong marketplace signal; no LedgerForce-specific testing.

## Follow-ups

- Test T7 (who can release PB-0087) in the user test plan.

**Affects:** P6, P7, P8; payment batch, bill, journal and credit-note approval screens; mobile approvals
