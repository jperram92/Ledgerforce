---
id: RQ-0095
title: How do the Australian Accounting Standards and ATO GST rules apply to LedgerForce's standard postings and reports?
status: resolved
opened: 2026-11-01
resolved: 2026-11-01
opened_by: claude
linked_tasks: [T-0115, T-0007]
linked_adrs: []
superseded_by:
---

# RQ-0095 — How do the Australian Accounting Standards and ATO GST rules apply to LedgerForce's standard postings and reports?

## Question
Q1. Which AASB standards (15, 9, 116, 138, 16, 119, 137, 101/18, 107, 108, 121, 1060, Interpretation 1031) and ATO GST rules govern the standard postings in design §3.8 and the draft golden postings GP-001…GP-019?
Q2. Where do the design and drafts comply, where are the gaps, and what changes are recommended (MVP / Phase 1 / later; owner decision or agent)?
Q3. What do the findings imply for open questions Q1–Q11 in Docs/accounting/postings.md?

## Why it matters
Owner request (2026-11-01). Golden postings (T-0007) gate the accounting backlog; approving them on non-compliant treatments would bake errors into the engine (design §11.1 top risk).

## Sources consulted
Four research streams; every source with access method is listed in the notes:
- [Revenue and receivables (AASB 15, AASB 9)](research_notes/AASB%20alignment%20of%20LedgerForce%20postings/revenue_and_receivables.md)
- [GST accounting (Int 1031, GST Act, ATO)](research_notes/AASB%20alignment%20of%20LedgerForce%20postings/gst_accounting.md)
- [Assets, employees, leases (AASB 116, 138, 16, 119, 137, 102; Payday Super)](research_notes/AASB%20alignment%20of%20LedgerForce%20postings/assets_employees_leases.md)
- [Reporting framework (AASB 1060, 101/18, 107, 108, 121; Corporations Act thresholds)](research_notes/AASB%20alignment%20of%20LedgerForce%20postings/reporting_framework.md)

**Access limitation:** aasb.gov.au, standards.aasb.gov.au, ato.gov.au, legislation.gov.au and asic.gov.au (and several Big-4 hosts) could not be fetched from the agent environment; findings rest on search-result text and secondary sources. Unverified items are marked in the notes and the report.

## Findings
See the synthesis report: [AASB alignment of LedgerForce postings](reports/AASB%20alignment%20of%20LedgerForce%20postings.md) — verdict per golden posting, per open question, and 25 prioritised changes.

## Conclusion / decision
- All draft postings balance and follow Interpretation 1031; 11 of 19 can be approved essentially as drafted.
- Not compliant as drafted: GP-007 (needs an AASB 9 ECL allowance), GP-012 Option A (GST attributable on receipt), GP-018a (matches neither ATO rounding rule), GP-014/GP-016 (receivable before performance only when non-cancellable), GP-008 (capitalises without depreciation in MVP).
- Design gaps: period-end journals (accruals/prepayments, depreciation, ECL, leave), AASB 108 prior-period adjustments, Payday Super super payments, AASB 18 account attributes, AASB 121 scope, AASB 16 manual path.
- Recorded in solution design §3.10 (proposals) and as open-question notes in Docs/accounting/postings.md. Every posting change is a human gate (golden_postings / accounting ADR); nothing approved by agents.

## Confidence
medium — consistent secondary sources and search-result extracts of primary sources; low for items marked unverified (Int 1031 status after 1 Jan 2027, Div 156 whole-supply attribution, Payday Super extended period, instant asset write-off permanence, bad-debt adjustment-note requirement, Stripe fee/GST split).

## Follow-ups
- Re-verify unverified items against primary text when ato.gov.au, standards.aasb.gov.au, legislation.gov.au and asic.gov.au are reachable.
- Owner decisions listed in design §11.2; then supersede draft golden postings per Docs/accounting/AGENTS.md.

**Affects:** T-0007 golden postings, design §3, §8.1, §11; future tasks for period-end journals, ECL, depreciation, Payday Super, AASB 18 reporting.
