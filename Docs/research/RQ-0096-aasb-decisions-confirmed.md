---
id: RQ-0096
title: Are the AASB/GST decisions in RQ-0095 confirmed by legislation, ATO rulings and established AU accounting software?
status: resolved
opened: 2026-11-01
resolved: 2026-11-01
opened_by: claude
linked_tasks: [T-0115, T-0007]
linked_adrs: []
superseded_by:
---

# RQ-0096 — Are the AASB/GST decisions in RQ-0095 confirmed by legislation, ATO rulings and established AU accounting software?

## Question
For each open decision from RQ-0095 (Q7, Q8, Q4, Q2/Q3, ECL, deposits before performance, credit-note reasons, presentation, depreciation, accruals, Payday Super, leave and leases, reporting framework): what do the law, rulings, standards and Xero/MYOB/QuickBooks AU/Employment Hero say, and what is the confirmed recommendation?

## Why it matters
Owner asked (2026-11-01) to confirm the decisions using legislation and how other accounting systems work, before approving golden postings (T-0007).

## Sources consulted
Second-round notes (sources and access method per finding):
- [GST decisions](research_notes/AASB%20decisions%20confirmed%20by%20law/gst_decisions.md)
- [Receivables decisions](research_notes/AASB%20decisions%20confirmed%20by%20law/receivables_decisions.md)
- [Period-end and payroll decisions](research_notes/AASB%20decisions%20confirmed%20by%20law/period_end_payroll_decisions.md)
- [Presentation decisions](research_notes/AASB%20decisions%20confirmed%20by%20law/presentation_decisions.md)

**Access limitation:** official hosts (ato.gov.au, legislation.gov.au, aasb.gov.au, asic.gov.au) and several vendor help sites were not reachable; findings rest on search-result text, secondary sources and vendor community posts.

## Findings
See [AASB decisions confirmed by law](reports/AASB%20decisions%20confirmed%20by%20law.md) — one table per decision (rule, software practice, recommendation, change vs round 1, confidence, design/GP change) and the golden-posting change list.

## Conclusion / decision
All structural fixes from RQ-0095 upheld. Changes: Q7 stricter (supply type decides whole-supply vs per-receipt GST); Q4 default reversed to the software-compatible net presentation with the strict ATO form as a setting; Q8 adds a per-line 2 dp opt-in; Stripe clearing shown as a receivable by default with a cash-equivalent option; LSL split by vesting; Payday Super confirmed as law (Act No. 57 of 2025). Recorded in design §3.10.1. Golden postings and accounting ADRs remain owner approvals.

## Confidence
Medium-high overall; per-decision ratings and unverified items in the report.

## Follow-ups
- Verify unverified items against primary text once the official hosts are reachable.
- Owner approves or amends the golden-posting change list; then draft superseding GP entries per Docs/accounting/AGENTS.md.

**Affects:** T-0007, design §3.4, §3.6, §3.8, §3.10, golden postings GP-004/005/007/012/013/018/019 and proposed GP-020…029.
