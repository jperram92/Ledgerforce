---
id: RQ-0081
title: What do SMB owners, bookkeepers and accountants value and complain about in accounting UIs?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0081 — What do SMB owners, bookkeepers and accountants value and complain about in accounting UIs?

## Question

Q1. What are the recurring complaints about the UIs of Xero, QuickBooks Online, MYOB, NetSuite, Business Central, Sage Intacct and FreshBooks?
Q2. What do the four LedgerForce user types (owner, AR/AP clerk, accountant/approver, sales rep) need first from a screen?

## Why it matters

Design §1 targets non-accountant owners plus bookkeepers on the same screens; `Docs/ui/principles.md` P11 and P12 make assumptions about both. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://www.accountingweb.co.uk/node/222644 ; https://productideas.xero.com/forums/939198-for-small-businesses/suggestions/47714132 | 2026-10-24 | forum (search summary) | Xero new invoicing: more clicks and steps, lost classic features, slower routine work |
| S2 | https://quickbooks.intuit.com/community/account-management-35/new-interface-is-terrible-and-not-an-improvement-stop-messing-with-it-101366 | 2026-10-24 | forum (search summary) | QBO users forced onto new UI by Sept 2025, no way back; "New" menu hard to find; no dark mode |
| S3 | https://quickbooks.intuit.com/learn-support/en-us/other-questions/wasted-space-in-the-ui/00/1359195 | 2026-10-24 | forum (search summary) | "less than 5% of the page is actually dedicated to showing me the information"; only fix is a Compact density toggle |
| S4 | https://productideas.xero.com/forums/967139-purchase-orders-bills-inventory/suggestions/47184851 ; https://blog.xero.com/product-updates/retiring-classic-invoicing/ | 2026-10-24 | forum, vendor (search summary) | Requests for cursor-key entry and Alt shortcuts; classic invoicing retired 2025 |
| S5 | https://www.g2.com/products/netsuite/reviews_and_filters | 2026-10-24 | reviews (search summary) | "so many menus, sub-tabs, and fields crammed onto one page"; "interface outdated" tag on 335 reviews |
| S7 | https://www.getapp.com/finance-accounting-software/a/intacct-accounting-and-financial-management/reviews/ | 2026-10-24 | reviews (search summary) | Drill-down to the transaction praised for audit; criticised when it lands on a group |
| S9 | https://marcandrews.com/xero-bank-reconciliation-tutorial-uk-step-by-step-guide/ ; https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/44988634 | 2026-10-24 | secondary, forum (search summary) | Two-column reconcile is clear; per-line OK causes repetitive strain |
| S20 | https://www.xero.com/au/media-releases/new-xero-research-reveals-over-half-australians-fear-making-mistake-on-tax-return/ | 2026-10-24 | survey (search summary) | 71% of AU SMB leaders find tax time stressful, 83% overwhelming |
| S22 | https://www.waveapps.com/blog/cash-flow-for-small-businesses | 2026-10-24 | secondary (search summary) | $20,000 profit can be $8,000 cash: owners confuse profit and cash |
| S23 | https://www.scalexp.com/?p=140843 | 2026-10-24 | vendor (search summary) | Without write-back, reps keep asking finance whether invoices are paid |

## Findings

1. Both market leaders reduced density and added clicks in 2024–25 redesigns, and professional users objected (S1–S4). Fact.
2. NetSuite shows density without hierarchy also fails (S5). Fact.
3. Accountants' trust depends on drilling to the original transaction (S7). Fact (review summaries).
4. Owners' worries are time- and tax-bound and they confuse profit with cash (S20, S22). Fact (vendor survey, secondary).
5. Inference: owners and operators need different first screens over the same data.

## Conclusion / decision

- Treat density as a requirement for clerk and accountant screens; default them to compact (proposed P11 change).
- Every amount must open its source documents and journal in place.
- Owner screens answer time-bound questions (cash on the date obligations fall due) in sentences.
- Resulting insights: INS-01, INS-02, INS-03, INS-09 in the report.

## Confidence

`medium`: consistent across several independent forums and vendors, but read through search summaries; no interviews. Hedge: the user test in `Docs/ui/research/03-recommendation.md` §4.

## Follow-ups

- Read the primary forum threads in full when access allows.
- Run the 20-person test plan before `apps/web` screens are ported.

**Affects:** Docs/ui/principles.md P11, P12; UC-03, UC-04, UC-10; home and list screens
