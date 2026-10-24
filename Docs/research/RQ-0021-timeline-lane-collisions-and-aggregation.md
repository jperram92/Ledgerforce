---
id: RQ-0021
title: How do Timeline lanes lay out colliding events, and how do Quarter and Year scales aggregate (incl. projections, P15)?
status: resolved
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0106]
linked_adrs: []
superseded_by:
---

# RQ-0021 — Timeline lane collisions and Quarter/Year aggregation

## Question

Q1. When several events fall on the same day (or close enough that their labels touch) in one
lane, what stacking rule places them, and when does the lane show "+n more" instead? The rule must
be deterministic, never overlap, and have a threshold per scale (Week, 5 weeks, Quarter, Year).

Q2. At the Quarter and Year scales a day-per-event drawing is unreadable. What are the buckets,
how are amounts summed, and how are projections (expected receipts and payments) summarised so
that expected is never shown as actual (P15)?

## Why it matters

The recommendation lists both as "owed before build" (`Docs/ui/research/03-recommendation.md` §2,
`Docs/ui/system/README.md` rule 5). The prototype (`Docs/ui/system/timeline.js`) places items with
a hand-set `level` per item, so real data would overprint labels. It also does money in JS floats
(`toLocaleString` on numbers), which AGENTS.md §4 bans. T-0106 builds the components that every
`apps/web` screen will use (T-0081 onward), so the rule set here is a contract (P14).

## Sources consulted

Direct page fetches were not attempted for the course PDFs; "search summary" means the search
engine's extract was used.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://courses.cs.washington.edu/courses/cse417/09wi/slides/04greed.pdf (Kleinberg–Tardos ch. 4 slides, "Interval partitioning") | 2026-10-24 | secondary (textbook slides), search summary | Sort intervals by start; put each in any compatible row, open a new row only when none fits. "Theorem. Greedy algorithm is optimal": the number of rows equals the depth (max intervals over any point). |
| S2 | https://salil.seas.harvard.edu/resource/cs120-fall2021-lec14pdf | 2026-10-24 | secondary, search summary | Interval scheduling/partitioning as interval-graph colouring; interval graphs are the easy special case. |
| S3 | https://fullcalendar.io/docs/dayMaxEvents and https://fullcalendar.io/docs/eventMaxStack | 2026-10-24 | primary (library docs), search summary | `dayMaxEvents`: max events per day "not counting the +more link. The rest will show up in a popover". `eventMaxStack` is the same for timeline views; clicking the more-link shows the hidden events. |
| S4 | https://unpkg.com/vis-timeline@5.1.0/examples/timeline/groups/subgroups.html | 2026-10-24 | primary (library example), search summary | vis-timeline's `stack` option stacks items "on top of each other such that they do not overlap"; stacking is per group/subgroup. |
| S5 | ISO 8601 week date (summaries at https://pkg.robjhyndman.com/calcal/reference/iso.html and https://learn.microsoft.com/windows/win32/intl/locale-ifirstweekofyear) | 2026-10-24 | secondary on a primary standard | ISO weeks start on Monday; week 1 contains 4 January; a year has 52 or 53 weeks. |
| S6 | https://www.numeric.io/template/13-week-cash-flow-template ; https://blog.coupler.io/13-week-cash-flow-model/ ; https://centime.com/posts/13-week-cash-flow-forecast-mistakes | 2026-10-24 | secondary (vendor), search summary | The treasury "13-week cash flow" uses weekly buckets because a monthly total hides an intra-month shortfall (e.g. a payroll crunch); it is a direct receipts/disbursements view; the lowest weekly balance is the number lenders look at. Monthly buckets suit 12-month horizons. |
| S7 | https://intercom.help/floatapp/en/articles/10091722-weekly-forecast ; https://floatapp.com/blog/xero-data-cash-flow-forecast | 2026-10-24 | secondary (vendor docs), search summary | Weekly view shows the lowest projected balance and its week. Xero only projects an overdue invoice when it has an expected date; Float assumes overdue is paid today and flags it. Both treat overdue specially. |
| S8 | https://webspace.science.uu.nl/~telea001/uploads/VACourse/Shneiderman96.pdf (Shneiderman 1996, "The Eyes Have It") | 2026-10-24 | primary (paper), search summary | "Overview first, zoom and filter, then details-on-demand"; temporal data is one of the seven data types. |
| S9 | `Docs/ui/principles.md` P3, P13, P14, P15; `Docs/ui/system/timeline.js`; `Docs/ui/research/directions/c-timeline/home.html` | 2026-10-24 | primary (repo) | P15: projections dashed, labelled "expected", say what they leave out; actuals stop at the last statement date. The prototype's 5-week lane holds at most two label rows (`level` 0/1) in a 70 px lane, and the legend says overdue is "not counted in the expected balance". |

## Findings

1. Placing labelled events in a lane is interval partitioning: each event occupies a horizontal
   *footprint* (its date or span, widened to the width its label needs); two events collide when
   footprints overlap. Greedy first-fit in start order uses the minimum possible number of rows,
   equal to the depth of the footprints (S1, S2). So a cap of *R* rows hides nothing whenever the
   depth is ≤ *R*. *Inference:* with a total order on ties (start, then priority, then id) the
   result is fully deterministic and independent of input order.
2. Calendar and timeline libraries solve the same problem with a per-view cap plus a "+n more"
   link that reveals the hidden events on demand (S3), and stack within a group, never across
   groups (S4). This matches Shneiderman's overview → details-on-demand (S8).
3. A pixel-free footprint is needed for determinism and testability (no text measuring). The
   prototype's 5-week scale at 1440 px gives ≈ 31 px per day for a 39-day span; the longest lane
   labels ("Suppliers 22,415.00") are ≈ 120 px wide, i.e. ≈ 4 days. At Quarter (≈ 13 weekly
   buckets) one bucket is ≈ 95 px; at Year (12 monthly buckets) ≈ 100 px (S9; inference from the
   prototype's geometry).
4. For Quarter, weekly buckets are the established practice for cash (the 13-week cash flow),
   because monthly totals hide intra-month troughs; the lowest balance and its week are the key
   figure (S6, S7). Weeks start on Monday (ISO 8601, also the AU business convention) (S5).
   For Year, monthly buckets are the norm for 12-month horizons (S6).
5. Products treat overdue receivables specially in projections: Xero leaves them out unless an
   expected date is set; Float assumes "today" and flags it (S7). The prototype already chose
   "not counted in the expected balance" and says so in the legend (S9), which satisfies P15's
   "say what they leave out".
6. A bucket that straddles today (or the last statement date) holds both actual and expected
   amounts. Summing them into one figure would show expected as actual — exactly what P15 bans.

## Conclusion / decision

**Q1 — Lane collision rule (implemented in `packages/ui/src/layout/lane-layout.ts`):**

- Time is measured in whole days (`dayNumber` from an ISO date, UTC). Each item's footprint is
  `[start, max(end + 1, start + footprint))` where `footprint` is set per scale:
  Week 1 day, 5 weeks 4 days, Quarter 14 days (2 weekly buckets), Year 31 days (1 monthly bucket).
- Sort by start, then priority (`now` items before others), then id. Assign each item to the
  lowest row whose last footprint ends at or before the item's start (greedy first-fit).
- Rows per lane are capped per scale: Week 3, 5 weeks 2 (the prototype's two levels), Quarter 2,
  Year 1. An item that finds no free row is hidden.
- Hidden items are gathered into "+n more" markers on an overflow strip under the lane. A marker
  starts at its first hidden item and absorbs every following hidden item whose start is inside
  its footprint, so markers never overlap. A marker that hides a `now` item is drawn in the now
  colour and its accessible name says "including 1 due now", so a decision is never silently
  buried (P13). Activating a marker shows the hidden items (details on demand).
- Invariants to test (fast-check): no two items in one row overlap; visible + hidden = all items,
  each item in exactly one place; markers never overlap; the layout is independent of input order;
  nothing is hidden when the depth is ≤ the row cap.

**Q2 — Aggregation (implemented in `packages/ui/src/aggregate/aggregate.ts`):**

- Buckets: Week and 5 weeks = day; Quarter = ISO week (Monday start); Year = calendar month.
- Per lane and bucket, sum amounts exactly with `Money` from `@ledgerforce/shared/money`
  (decimal strings in, decimal strings out; no JS numbers). Keep **actual** and **expected** as
  two separate totals with their own counts. A bucket that straddles the last statement date
  therefore renders as two marks: a solid actual mark and a dashed "expected" mark.
- Overdue items (past due, unpaid) are **not** added to expected. Their total and count are
  reported per lane as `leftOut`, and the expected mark's label says "overdue not counted".
- Cash balance per bucket: closing balance (last step in the bucket). For expected buckets also
  report the lowest point inside the bucket and its date, so the weekly/monthly view never hides
  the trough (Finding 4). The actual series ends at the last statement date, which the component
  shows (`data-last-statement`).
- Labels for aggregated marks name the state and the count in words, e.g. "Expected 21,560.00"
  with "5 items, overdue not counted", never a middle-dot meta string (G10).

## Confidence

`medium` — the stacking algorithm's optimality is a textbook result (high); the per-scale
footprints and row caps are derived from the prototype's geometry and must be re-checked with
real data and the user test in `03-recommendation.md` §4. They are constants in one table
(`SCALES`) so they can be tuned without changing the rule.

## Follow-ups

- Validate thresholds and labels in the moderated user test (`03-recommendation.md` §4, T1).
- T-0081 (web shell) consumes these components; any change to the rule changes a P14 contract
  and needs a release note.

**Affects:** packages/ui (T-0106), apps/web timeline screens (T-0081+), principles P13–P15.
