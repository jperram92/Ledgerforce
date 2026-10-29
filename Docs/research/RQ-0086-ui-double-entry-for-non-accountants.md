---
id: RQ-0086
title: How should the journal behind a document be shown so owners understand it and accountants trust it?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0086 — How should the journal behind a document be shown so owners understand it and accountants trust it?

## Question

Q1. What framing makes double entry understandable to non-accountants? Q2. How do professional tools show postings before and after posting?

## Why it matters

Principles P1 and P4 require the journal on every document; owners are non-accountants (design §1). The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S35 | https://www.systemdesignsandbox.com/learn/double-entry ; https://finkpr.com/blog/double-entry-in-five-minutes | 2026-10-24 | secondary (search summary) | "Single-entry tells you what happened. Double-entry tells you where the money went"; drop the word "credit"; every transaction touches two places |
| S36 | https://www.brex.com/spend-trends/accounting/t-accounts ; https://news.ycombinator.com/item?id=39988993 | 2026-10-24 | secondary (search summary) | T-accounts help explain impact to non-finance colleagues; double entry as a directed graph |
| S8 | https://learn.microsoft.com/en-us/dynamics365/business-central/ui-how-preview-post-results | 2026-10-24 | primary (search summary) | Preview Posting with grouped G/L and VAT entries |
| S10 | https://g2.com/products/freshbooks/reviews | 2026-10-24 | reviews (search summary) | Hiding accounting concepts wins owners but loses accountants |

## Findings

1. Movement framing (from where, to where) is the common plain-language explanation (S35, S36).
2. Accountants expect Dr/Cr with account codes, previewed before posting (S8).
3. Hiding the ledger loses professional trust (S10). Inference: show both forms from one data source.

## Conclusion / decision

- Show the same journal twice: a plain movement view for owners (flow or glossed lines) and the Dr/Cr table with codes for accountants, both from the posting-engine preview or posted journal.
- Gloss each account in owner words ("what you owe suppliers", "held for the ATO") next to its name.
- Show GST as money that isn't the business's (held for the ATO).

## Confidence

`medium`: consistent secondary sources and a primary vendor pattern; untested with LedgerForce users (test T3 and T6 in the plan).

## Follow-ups

- Usability test T3/T6 before build.

**Affects:** P1, P4, P12; document pages; posting preview UI
