# LedgerForce visual identity v2: "Columnar"

Supersedes the v0.1 look in `Docs/ui/mockups` (indigo accent, rounded cards, soft shadows, sidebar),
which the product owner rejected as generic template UI. Decision: DL-0051. The 12 UI principles in
`Docs/ui/principles.md` still apply unchanged. This file defines how they look.

## The idea

LedgerForce borrows its look from the bookkeeper's own tools, not from a SaaS template.
Every visual device below is a real accounting convention, so it carries meaning rather than decoration.

| Device | Where it comes from | What it means in the UI |
|---|---|---|
| **The ruled sheet** | Green-ruled analysis pad / columnar book | Content sits on one bordered sheet on a desk-coloured page. Rows are separated by faint green rules. There are no floating cards. |
| **The red margin line** | Ledger paper's double red margin | Left of the line is the *margin*: line numbers, audit ticks (✓), flags (!), queries (?). Right of it is the entry. |
| **Index tabs** | Binder dividers | The primary navigation is a row of tabs that join the sheet. The active tab has a ledger-green top edge. There is no sidebar. |
| **Inks** | The inks accountants actually use | Green-black for entries; **red** for negatives, overdue and rejected; **green** for ticks, reconciled and paid; **blue-black** for approvals and posted; amber for awaiting. |
| **Rubber stamps** | Posted / Paid / Void stamps | Document state is a stamp: uppercase condensed word with a border style (solid, dashed, double, struck through). It is never colour alone. One large rotated stamp is allowed per document view. |
| **Total rules** | Accounting typography | A single rule above a total and a double rule under a grand total. |
| **The T** | The T-account | Journal previews are Dr \| Cr tables with a heavy vertical T rule. Credits are indented, as a journal is hand-written. The proof line underneath reads `Dr − Cr = 0.00 · balanced`. |
| **Signature lines** | Sign-off on a voucher | Two-person controls show names written on signature lines, with role and time underneath. The current user's line is ledger green. |
| **Printed-form boxes** | Paper forms with a legend in the border | Control explanations, inputs and warnings sit in boxes whose label sits in the border. Inputs are underlines, not boxes. |
| **Statement strip** | The head of a bank statement | Key figures run as one ruled strip divided by vertical rules, not as rounded KPI tiles. |
| **Tally boxes** | Tally marks | Progress is shown as a row of filled squares (e.g. 6 of 7), not a smooth bar. |
| **Hatching** | Red-hatched overdue columns | Overdue amounts in charts are hatched red: pattern *and* ink. |

## Type

- **IBM Plex Sans**: body text and controls.
- **IBM Plex Sans Condensed**, uppercase and letter-spaced: column headings, section heads, labels and stamps (the printed-form voice).
- **IBM Plex Mono**: every figure, date, reference and timestamp, like an adding-machine tape. Amounts are always right-aligned in their own ruled column.
- Fonts are bundled in `Docs/ui/v2/fonts` (SIL OFL, licence included), so screenshots are deterministic and need no network.

## Banned in LedgerForce UI

These are the marks of template UI. Reviewers reject them:

- Rounded-corner cards with drop shadows; any `box-shadow` used for elevation.
- Pill-shaped chips and badges, gradient fills, glassmorphism.
- Left icon sidebars, and an icon on every button. Icons appear only where a word alone would be ambiguous.
- Purple, indigo or violet as a brand colour; emoji; big hero numbers in rounded tiles.
- Status shown by colour alone.

## Shape and space

- Corner radius is 2px.
- Spacing is on a 4px grid.
- There are two densities, Comfortable (40px rows) and Compact (30px rows). Only spacing changes between them, never the columns.
- At 900px and below, the margin narrows to 26px, the tabs scroll inside their own strip and grids stack. The page never scrolls sideways; wide tables scroll inside `.scroll`.

## Dark mode, "carbon copy"

The same sheet printed as a dark carbon: green-black paper with lifted inks. It is designed separately, not inverted. All tokens are in `tokens.css` under `prefers-color-scheme: dark` and `[data-theme="dark"]`.

## Files

| File | Purpose |
|---|---|
| `tokens.css` | All colour, type, space and shape tokens, light and dark |
| `shell.css` | Components: masthead, tabs, sheet, ledger tables, T table, stamps, statement strip, form boxes, signature lines, log, ageing bars, tallies |
| `shell.js` | Renders masthead, tabs and sub-nav from `<body data-*>`, and expands `data-stamp` |
| `mockups/03-invoice-detail.html` | **Reference screen.** Every other screen follows its patterns |
| `tools/` | Screenshot, page checks and token contrast checks for v2 |
