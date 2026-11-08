---
id: RQ-0083
title: What can newer finance products and density analogues teach, and where are they converging?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0083 — What can newer finance products and density analogues teach, and where are they converging?

## Question

Q1. What do Digits, Puzzle, Rillet, Campfire, Ramp, Brex, Mercury and Stripe do in their UIs? Q2. What do Linear, Bloomberg Terminal and Salesforce Lightning teach about density, keyboard use and living next to Salesforce?

## Why it matters

LedgerForce competes for the same owners as fintech tools and lives next to Salesforce (design §5). The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S12 | https://beancount.io/blog/2025/08/05/digits-ai-accountant-balancing-brilliant-dashboards-with-the-need-for-human-trust | 2026-10-24 | secondary (search summary) | Digits: exceptions inbox; praised for polish, questioned on transparency |
| S13 | https://puzzle.io/llms.txt | 2026-10-24 | vendor (search summary) | Cash and accrual ledgers from the same data with one toggle |
| S14 | https://info.rillet.com/rillet-for-accountants | 2026-10-24 | vendor (search summary) | Prepare, review, post approval chain |
| S26 | https://blakecrosley.com/guides/design/mercury ; https://www.shadcn.io/design/mercury | 2026-10-24 | secondary (search summary) | Mercury: custom Arcadia face, cinematic dark, violet-tinted near-black, indigo CTA |
| S27 | https://tessl.io/registry/skills/github/ihlamury/design-skills/ramp-ui-skills | 2026-10-24 | secondary (search summary) | Reverse-engineered Ramp kit: Inter, yellow accent |
| S28 | https://blakecrosley.com/zh-Hans/guides/design/stripe | 2026-10-24 | secondary (search summary) | Stripe payment detail as a timeline of events |
| S29 | https://robinrendle.com/notes/keyboard-first-apps/ ; https://brainy.ink/paper/glossary/keyboard-first | 2026-10-24 | secondary (search summary) | Linear: keyboard-first from first release, Cmd-K plus mnemonic keys |
| S15 | https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity | 2026-10-24 | primary (search summary) | "a font change or the relocation of a button can be disruptive"; "balance innovation with familiarity" |
| S30 | https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-custom-properties | 2026-10-24 | primary (search summary) | SLDS 2 uses global styling hooks; component-level hooks unsupported; follow org theme |

## Findings

1. Premium fintech is converging on dark, violet-tinted, Inter (S26, S27). Fact (secondary).
2. Exception inboxes and event timelines are the strongest newer patterns (S12, S28).
3. Pros accept density when hierarchy is stable and learned (S15); keyboard-first must be the default path, not a palette bolted on (S29).
4. Inside Salesforce, components must inherit SLDS 2 hooks (S30).

## Conclusion / decision

- Take patterns (exception queue, event timeline, keyboard model), not looks.
- Treat layout stability as a feature (proposed P14).
- UC-12 component: SLDS 2 global hooks only, no LedgerForce tokens; the LedgerForce app looks clearly separate from Lightning.

## Confidence

`medium`: secondary sources; vendor sites unreachable for screenshots.

## Follow-ups

- Re-check SLDS 2 hook names against Salesforce release notes at build time (fast-moving).

**Affects:** UC-12 component; list screens; Docs/ui/research/02-directions.md
