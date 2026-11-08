---
id: RQ-0089
title: What accessibility, colour-blind-safe status and dark-mode rules should LedgerForce follow?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0089 — What accessibility, colour-blind-safe status and dark-mode rules should LedgerForce follow?

## Question

Q1. Which WCAG 2.2 AA criteria change the design? Q2. Which colour pairs are safe for money and status? Q3. Should finance screens default to dark?

## Why it matters

Principles P2, P3 and the baseline checks; owners and clerks read small figures for long periods. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S37 | https://dequeuniversity.com/resources/wcag-2.2 ; https://www.powermapper.com/blog/wcag-2.2-released/ | 2026-10-24 | secondary (search summary) | 2.5.8 target size ≥ 24×24; 2.4.11 focus not obscured; 3.3.7 redundant entry; 3.3.8 accessible authentication |
| S38 | https://zipbooks.com/blog/color-accessibility-mode/ ; https://roadmap.copilot.money/feature-requests/p/accessibility-for-color-blind ; https://www.audioeye.com/post/colorblind-friendly-palettes/ | 2026-10-24 | vendor (search summary) | Blue/orange safe for protanopia/deuteranopia; Okabe-Ito palette; finance apps added blue/orange modes and +/− signs |
| S39 | https://www.nngroup.com/articles/dark-mode/ ; https://hrcak.srce.hr/en/341630 | 2026-10-24 | research (search summary) | No fatigue difference; light mode better for proofreading, more so at small sizes; #121212 dark ground reduced reading errors |
| E2 | AXE_PATH=<axe-core 4.14.0> node Docs/ui/research/tools/shot.mjs | 2026-10-24 | experiment | All 16 prototype captures: zero axe WCAG 2.0/2.1/2.2 A/AA violations; all text ≥ 4.5:1 |

## Findings

1. Status must not rely on colour (WCAG 1.4.1) and red/green is the worst pair for common CVD (S38).
2. Light mode is better for small-text accuracy (S39); dark is a preference, not a default.
3. The three directions pass axe WCAG 2.2 AA in light and designed dark themes (E2).

## Conclusion / decision

- Status = word + shape + colour; each direction gives colour one meaning only.
- Use blue/orange (or position, as in direction C) rather than red/green for in/out and good/bad.
- Light theme by default; design dark separately where long sessions justify it, on a #121212-class ground.
- Keep axe WCAG 2.2 AA (`wcag22aa` tag) in the Playwright suite.

## Confidence

`medium-high`: standards plus an executed audit; reading studies are general, not finance-specific.

## Follow-ups

- Add the `wcag22aa` tag to the apps/web axe run if not already present.

**Affects:** P2, P3, baseline checks; tokens; dark theme
