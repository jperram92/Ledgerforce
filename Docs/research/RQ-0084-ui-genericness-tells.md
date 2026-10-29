---
id: RQ-0084
title: What makes a UI read as AI-generated or vibe-coded in 2025–2026, and why were v0.1 and v2 rejected?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0084 — What makes a UI read as AI-generated or vibe-coded in 2025–2026, and why were v0.1 and v2 rejected?

## Question

Q1. Which visual and structural tells do people use to call a UI generic or AI-made, ranked by evidence? Q2. Which of them did the rejected v0.1 and v2 show?

## Why it matters

The product owner rejected two directions as "vibe coded" and "another generic type". Without a checklist, a third attempt picked by taste would likely fall into another cluster. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S31 | https://github.com/JCarterJohnson/vibecoded-design-tells (README and comment_tell_counts.csv) | 2026-10-24 | data (read) | 3.2M posts, 3,033 comments: "screams AI" 6.4%, "all looks the same" 6.1%, shadcn/Tailwind defaults 2.5%, AI purple 2.3%, gradients 2.0%, animations 1.1%, rounded/pill 0.8%; bento 0.1% |
| S32 | https://github.com/funboy322/avoid-ai-design (README, references/ai-tells-catalog.md) | 2026-10-24 | catalogue (read) | 67 tells; second-order defaults: cream+terracotta, near-black+acid green, broadsheet cosplay, template chrome (all-caps eyebrows, mono data labels, middle-dot meta strings, arrows); tasteful-font cluster ~15.8% of sites |
| S33 | https://github.com/anthropics/skills/tree/main/skills/frontend-design | 2026-10-24 | primary (read) | Five clusters of generated design incl. broadsheet hairlines with zero radius and template chrome; ground design in the subject matter |
| S40 | https://adriankrebs.ch/blog/design-slop/ | 2026-10-24 | secondary (search summary) | 500 Show HN pages scored on 15 patterns |
| S41 | https://www.saasframe.io/blog/designing-bento-grids-that-actually-work-a-2026-practical-guide | 2026-10-24 | secondary (search summary) | KPI row + big chart + widgets is the standard dashboard |

## Findings

1. People mostly recognise sameness itself; among features, shadcn/Tailwind defaults and purple lead (S31).
2. v0.1 = first-order baseline (sidebar, KPI tiles, rounded cards, indigo, pills). Observation of `Docs/ui/screenshots`.
3. v2 = second-order defaults: broadsheet hairlines and zero radius, tracked all-caps condensed labels, mono figures, costume (stamps, margin line) (S32, S33). Observation of `Docs/ui/v2`.
4. Remedy across sources: derive the direction from the product's own structures, then review the plan against the defaults (S32, S33).

## Conclusion / decision

- Use checklist G1–G13 (`Docs/ui/research/01-research-report.md` §D2) on every new screen; pass = total ≤ 4 with no item scored 2.
- Keep the automated probes in `Docs/ui/research/tools/shot.mjs` (shadows, radius, all-caps tracking, middle dots, arrows, purple) in the `apps/web` Playwright suite.

## Confidence

`medium-high`: two primary catalogues read in full plus a reproducible data set; the topic is opinion-heavy by nature.

## Follow-ups

- Add the probes to the `ui-screen` skill checks when T-0009 is accepted.

**Affects:** All UI; Docs/ui/principles.md; ui-screen skill
