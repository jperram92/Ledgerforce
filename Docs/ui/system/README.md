# LedgerForce design system — "Timeline" (v1)

Chosen by the product owner on 2026-10-24 (DL-0070) from the three research directions in
[`../research/`](../research/README.md). This folder is the **canonical starting point for
`apps/web`**. It was promoted (copied, not moved) from the prototype at
[`../research/directions/c-timeline/`](../research/directions/c-timeline/), which stays as research evidence.

## The idea in one paragraph

Everything sits on one date axis: cash in the bank, what customers owe, what you owe, tax,
decisions waiting on someone, month-end close and Salesforce. **Colour encodes time, nothing
else:** settled = solid ink, expected = the same ink dashed or outlined, today = one teal rule and
the decisions due on it. Money direction is shown by position (above the axis = in, below = out),
so no red/green pair is needed. Every document (invoice, bill, payment run) reads as a **life
story** on a vertical spine, with correction paths (credit note, void-by-reversal) branching from
today. Nothing is ever removed from the spine (P5).

## Files

| File | What |
|---|---|
| `tokens.css` | Colour, type, space and shape tokens, light + dark. Overpass (OFL) bundled in `fonts/`. |
| `timeline.css` | Prototype component styles: lanes, axis, spine, decision cards, journal table. |
| `timeline.js` | Prototype helpers (theme toggle, lane layout). Reference only, to be rebuilt as React components. |
| `fonts/` | Overpass 400/600/800 woff2 + `OFL-LICENSE.txt`. |

Reference screens: `../research/directions/c-timeline/home.html` (Your money from 1 Oct to
9 Nov) and `invoice.html` (INV-001061 life story), with screenshots at 1440, 390 and dark.

## Rules for building screens

1. Principles P1–P15 in [`../principles.md`](../principles.md). P13–P15 are new in v1.
2. Score every screen on the genericness checklist G1–G13 (`../research/01-research-report.md`):
   total ≤ 4, no item at 2 (DL-0065). Run the probes in `../research/tools/shot.mjs`.
3. **List-heavy screens** (bank reconciliation, batch billing preview, sync issues, bill
   approval) use Direction A's **turn queue** pattern inside the Timeline shell: turn token, decision
   bar, keyboard triage. See `../research/directions/a-turns/`.
4. **Owner view of a document** may add Direction B's **flow** component ("What it did to your
   books"). See `../research/directions/b-flows/invoice.html`.
5. Fixes owed before build (from the recommendation §2): lane collision handling and "+n more";
   projection labelling rules (P15); aggregation for Quarter and Year scales; the non-timeline list
   layout. Tracked as task T-0106.
6. Any typeface used for money must pass `../research/tools/fonttest.mjs` (DL-0067).
7. Validate with real users when available: the five-per-role test plan in
   `../research/03-recommendation.md` §4.
