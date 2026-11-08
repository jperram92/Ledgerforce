---
id: RQ-0085
title: Which open-licence typefaces set money correctly, and which avoid the generic clusters?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0009]
linked_adrs: []
superseded_by:
---

# RQ-0085 — Which open-licence typefaces set money correctly, and which avoid the generic clusters?

## Question

Q1. Which candidate typefaces have working tabular figures and clear 0/O, 1/l/I? Q2. Which are free of the AI-default and tasteful-font clusters?

## Why it matters

Principle P3 requires tabular figures; v2 used IBM Plex (now associated with the rejected look); clerks key thousands of figures. The product owner rejected two UI directions as generic (DL-0051, DL-0052); the next
direction must trace each decision to evidence. Full write-up: [`Docs/ui/research/01-research-report.md`](../../Docs/ui/research/01-research-report.md).

## Sources consulted

Direct page fetches to most sites were blocked by the session's egress proxy (HTTP 403 at CONNECT);
"search summary" means the search engine's extract was used, "read" means the full text was read.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S34 | https://developer.mozilla.org/docs/Web/CSS/font-variant-numeric ; https://tailwindcss.com/docs/font-variant-numeric | 2026-10-24 | primary (search summary) | tabular-nums needs the font to have tnum; many fonts silently ignore it |
| S42 | https://fonts.adobe.com/fonts/atkinson-hyperlegible-next | 2026-10-24 | primary (search summary) | Atkinson Hyperlegible Next (2025): differentiates characters for low-vision readers; 7 weights; mono variant |
| S43 | https://fontsource.org/fonts/b612/about | 2026-10-24 | primary (search summary) | B612: Airbus/ENAC cockpit-display face for legibility under degraded conditions |
| S32 | https://github.com/funboy322/avoid-ai-design | 2026-10-24 | catalogue (read) | Inter/Geist and Space Grotesk, Syne, Sora, Instrument Serif, Fraunces, Cal Sans flagged as defaults |
| E1 | node Docs/ui/research/tools/fonttest.mjs <19 fontsource packages> <out> | 2026-10-24 | experiment | Measured width of 1111111111 vs 0000000000 with and without tnum; compared zero glyph with and without zero feature |

## Findings

1. E1 result: tnum works in Atkinson Hyperlegible Next and Mono, B612, Source Sans 3, Source Serif 4, Overpass, Public Sans, Newsreader, Literata, Hanken Grotesk, Instrument Sans, Red Hat Text, Schibsted Grotesk, IBM Plex. **Does not work in Lexend or Libre Franklin.** Experiment.
2. Atkinson Hyperlegible Next draws a slashed zero and distinct I/l/1 by default (specimen `Docs/ui/research/evidence/typeface-specimen.png`). Experiment.
3. B612 draws parentheses like square brackets, so (914.50) reads as [914.50]: unsuitable for accounting negatives. Experiment.
4. None of Atkinson, Source Serif/Sans or Overpass is in the generic clusters (S32).

## Conclusion / decision

- Direction A: Atkinson Hyperlegible Next. Direction B: Source Serif 4 (sentences) + Source Sans 3 (UI, numbers). Direction C (recommended): Overpass.
- Never choose a face for money without running `fonttest.mjs` on it. Do not use Lexend, Libre Franklin or B612 for amounts.
- Bundle woff2 + OFL licence; no CDN (baseline check 2).

## Confidence

`high` for the tnum and glyph findings (executed experiment); `medium` for legibility claims (vendor and project descriptions).

## Follow-ups

- Decision-log entry for the chosen face once a direction is accepted (dev-only asset, OFL).

**Affects:** Docs/ui/tokens.css successor; P3; apps/web fonts
