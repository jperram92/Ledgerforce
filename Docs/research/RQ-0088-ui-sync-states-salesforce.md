---
id: RQ-0088
title: How should Salesforce sync state and errors be shown in LedgerForce and in Salesforce?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0088 — How should Salesforce sync state and errors be shown in LedgerForce and in Salesforce?

## Question

Q1. How do users experience integration sync errors in accounting tools? Q2. What constrains LedgerForce UI inside Salesforce (UC-12)?

## Why it matters

Design §5.6 rules 2 and 4 and principle P9; sales reps only see status in Salesforce. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S18 | https://features.formitize.com/p/dedicated-page-for-integrationxero-errors ; https://workshopsoftware.com/knowledge-base/accounting-integrations/why-is-my-invoice-not-syncing-to-xero/ | 2026-10-24 | forum, vendor (search summary) | Errors "can be easily dismissed and lost"; users ask for a dedicated error page and event log; locked records and missing mappings are common causes |
| S23 | https://tray.ai/connectors/sage-intacct-salesforce-integrations.md ; https://www.scalexp.com/?p=140843 | 2026-10-24 | vendor (search summary) | Reps close deals on accounts with unpaid invoices; keep asking finance |
| S30 | https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-custom-properties | 2026-10-24 | primary (search summary) | SLDS 2 global styling hooks; component-level hooks not supported |

## Findings

1. Dismissible sync errors get lost (S18). Fact (forum).
2. The value of write-back is that reps see paid status without asking (S23).
3. Inside Salesforce, styling must come from SLDS 2 hooks (S30).

## Conclusion / decision

- Sync state is a record: on each document (fields written, when), in history (failures and retries as events) and in a persistent issues list; never a toast only.
- Name the Salesforce error in plain words with its code (e.g. UNABLE_TO_LOCK_ROW) and say that accounting did not wait.
- UC-12 component uses SLDS 2 hooks only.

## Confidence

`medium`.

## Follow-ups

- Verify SLDS 2 hook support at build time.

**Affects:** P9; sync issues inbox; UC-12 LWC; document pages
