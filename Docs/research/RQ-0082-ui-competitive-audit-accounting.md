---
id: RQ-0082
title: Where have established accounting UIs converged, and what do they do well or badly?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0082 — Where have established accounting UIs converged, and what do they do well or badly?

## Question

Q1. What layout, colour, type and component patterns do Xero, QBO, MYOB, NetSuite, Business Central, Sage Intacct and FreshBooks share? Q2. Which of their patterns are worth keeping?

## Why it matters

Design §2 already copies BC posting logic, NetSuite staged close and Xero lock dates; the UI must not copy the generic shell that the product owner rejected. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S8 | https://learn.microsoft.com/en-us/dynamics365/business-central/ui-how-preview-post-results | 2026-10-24 | primary (search summary) | Preview Posting shows G/L and VAT entries before posting; hierarchical grouping; built because accountants want postings right beforehand |
| S6 | https://www.techradar.com/reviews/myob-essentials ; https://cfotech.com.au/story/myob-updates-platform-for-easier-smb-user-experience | 2026-10-24 | review, news (search summary) | MYOB: easy but shallow drill-down; 2024 refresh used plainer terms |
| S10 | https://g2.com/products/freshbooks/reviews | 2026-10-24 | reviews (search summary) | "non-accountant friendly design"; accountants find it shallow |
| S9 | https://marcandrews.com/xero-bank-reconciliation-tutorial-uk-step-by-step-guide/ | 2026-10-24 | secondary (search summary) | Xero reconcile: statement line left, suggested match right, balance gap shown |
| S2, S5, S7 | see RQ-0081 | 2026-10-24 |  |  |
| E0 | Rejected mockups in Docs/ui/mockups and Docs/ui/v2 (read in repo) | 2026-10-24 | source | v0.1 matches the converged shell; v2 matches second-order defaults (see RQ-0084) |

## Findings

1. Converged baseline: icon sidebar plus top bar with search/bell/avatar, greeting, 3–4 KPI tiles, white rounded cards, one blue/green/indigo accent, Inter-style sans, pill status chips, ledger detail hidden behind reports. (Inference from S2, S5, S6, S10 and product knowledge; screens could not be captured.)
2. Keep: BC Preview Posting (S8), Xero's side-by-side reconcile with balance gap (S9), FreshBooks' plain language for owners (S10).
3. Avoid: forced redesigns (S2), tabs-in-tabs density without hierarchy (S5), hiding the ledger from owners entirely (S10).

## Conclusion / decision

- Do not use the converged shell (sidebar + KPI tiles + rounded cards) for LedgerForce.
- Keep a posting preview on every postable document; show it to owners in plain words as well.
- White space to occupy: responsibility (whose turn), the journal in owner words, time as primary axis, per-record sync honesty, stability.

## Confidence

`medium`: patterns from documentation and reviews; no trial-account screenshots in this session.

## Follow-ups

- Capture trial-account screenshots of Xero, MYOB, QBO and BC and re-check the audit.

**Affects:** Docs/ui/research/02-directions.md; all screens
