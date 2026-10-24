# LedgerForce design tokens

Status: v0.1 (Sprint 0) · Source of truth: [`tokens.css`](tokens.css) · Verified by
[`tools/contrast.mjs`](tools/contrast.mjs) · Principles: [`principles.md`](principles.md)

All colours, type, spacing, radii, elevation and density values live as CSS custom properties in
`tokens.css`. Components never use raw hex values. `apps/web` maps them into Tailwind's theme and
into the shadcn/ui variable names (`--background`, `--primary`, `--ring` …) via the bridge block at
the end of `tokens.css`, so shadcn components pick them up without overrides.

## Themes

- **Light** is the default (`:root`).
- **Dark** follows the OS (`prefers-color-scheme: dark`) unless the user forced light
  (`:root:not([data-theme="light"])`), and can be forced with `<html data-theme="dark">`.
- Dark is a separately chosen palette (not an automatic inversion); every pair below is verified
  in both themes.

## Colour

| Group | Tokens | Light | Dark | Use |
|---|---|---|---|---|
| Canvas & surfaces | `--lf-bg`, `--lf-surface`, `--lf-surface-2`, `--lf-surface-hover`, `--lf-surface-selected` | #f5f6f8 · #ffffff · #f9fafb · #f1f3f6 · #eef0fe | #0c111d · #151a24 · #1b212d · #222937 · #23284a | Page, cards, table headers, row hover, selected row |
| Borders | `--lf-border`, `--lf-border-strong` | #e3e6eb · #858e9e | #2a3140 · #6f7a8e | Dividers (decorative); input/checkbox borders (≥ 3:1) |
| Text | `--lf-text`, `--lf-text-muted`, `--lf-text-subtle` | #101828 · #475467 · #5d6779 | #f2f4f7 · #c6cbd4 · #9aa3b2 | Primary, labels, captions — all ≥ 4.5:1 on every surface |
| Accent (one brand colour) | `--lf-accent`, `--lf-accent-hover`, `--lf-accent-fg`, `--lf-accent-soft`, `--lf-accent-text`, `--lf-focus` | #4f46e5 indigo | #8b93f8 | Primary button, links, focus ring, "Posted" |
| Success | `--lf-success-fg/bg/border/solid` | #067647 on #ecfdf3 | #6ce9a6 on #0b2a1c | Paid, matched, balanced |
| Warning | `--lf-warning-fg/bg/border/solid` | #a43e05 on #fffaeb | #fdb022 on #2e1f05 | Awaiting, due soon, cooling-off |
| Danger | `--lf-danger-fg/bg/border/solid` | #b42318 on #fef3f2 | #fda29b on #33130f | Overdue, failed, gaps |
| Info | `--lf-info-fg/bg/border/solid` | #175cd3 on #eff8ff | #84caff on #0b2342 | Approved, rule match, queued |

Why indigo: it is distinct from Salesforce's blue (so LedgerForce screens never look like a
Salesforce page and the UC-12 component inside Salesforce never looks foreign), and distinct from
all four semantic hues, so "accent" can never be mistaken for "status".

### Document status palette

Always rendered as a chip with **icon + word + colour** (principle P2).

| Status | Token pair | Icon | Light | Dark |
|---|---|---|---|---|
| Draft | `--lf-status-draft-fg/bg` | dashed circle | #475467 / #f2f4f7 | #cecfd2 / #262c38 |
| Awaiting approval | `--lf-status-awaiting-*` | clock | #a43e05 / #fffaeb | #fdb022 / #2e1f05 |
| Approved | `--lf-status-approved-*` | check | #175cd3 / #eff8ff | #84caff / #0b2342 |
| Posted | `--lf-status-posted-*` | book | #4338ca / #eef0fe | #b4b9fb / #23284a |
| Part paid | `--lf-status-partpaid-*` | pie | #0e6a83 / #ecfdff | #67e3f9 / #082a33 |
| Paid | `--lf-status-paid-*` | check-circle | #067647 / #ecfdf3 | #6ce9a6 / #0b2a1c |
| Overdue | `--lf-status-overdue-*` | warning triangle | #b42318 / #fef3f2 | #fda29b / #33130f |
| Void | `--lf-status-void-*` + dashed `--lf-status-void-border` | ban | #344054 / #ffffff | #cecfd2 / #151a24 |
| Reversed | `--lf-status-reversed-*` | undo | #6431b8 / #f4f3ff | #c8b6fd / #2a1d4d |
| Locked | `--lf-status-locked-*` (solid) | lock | #ffffff / #344054 | #0c111d / #cecfd2 |

## Typography

- **Family:** `--lf-font-sans` = Inter, then the system UI stack (`ui-sans-serif, system-ui,
  -apple-system, "Segoe UI", Roboto …`). `apps/web` bundles Inter (OFL) locally — no font CDN.
  `--lf-font-mono` for account codes, payloads and YAML.
- **Numbers:** `--lf-numeric: tabular-nums lining-nums` on every money and quantity cell.
- **Scale:** 12 (meta, chips) · 13 (compact table, helper) · **14 (body, default table)** · 16
  (inputs on mobile) · 18 (card title) · 20 · 24 (page h1) · 30 (KPI figures).
- **Weights:** 400 regular, 500 medium (labels, buttons), 600 semibold (headings, totals). No bold
  700 in product UI.
- **Line height:** 1.5 body, 1.25 headings.

## Spacing, radius, elevation

| Scale | Tokens |
|---|---|
| Spacing (4px base) | `--lf-space-0-5` 2 · `-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8` 32 · `-10` 40 · `-12` 48 · `-16` 64 |
| Radius | `--lf-radius-sm` 4 (tags, kbd) · `-md` 6 (buttons, inputs) · `-lg` 8 (cards) · `-xl` 12 (dialogs) · `-full` (chips, avatars) |
| Elevation | `--lf-shadow-xs` resting cards · `-sm` pressed segment · `-md` hover · `-lg` side panels, sticky action bars · `-overlay` dialogs; `--lf-scrim` behind modals |
| Layout | `--lf-nav-w` 232px · `--lf-topbar-h` 56px · `--lf-content-max` 1360px; mobile gutter 16px |

## Density

| Token | Comfortable (default) | Compact (`[data-density="compact"]`) |
|---|---|---|
| `--lf-row-h` | 44px | 32px |
| `--lf-cell-py` / `--lf-cell-px` | 10 / 12px | 6 / 8px |
| `--lf-control-h` | 36px | 28px |
| `--lf-table-font` | 14px | 13px |
| `--lf-card-pad` | 20px | 14px |

Mobile (< 900px) hides the side navigation and uses 44–48px touch targets regardless of density.

## Contrast (WCAG 2.2 AA) — computed, not eyeballed

Command: `node Docs/ui/tools/contrast.mjs --md` (exit code 1 on any failure). Text pairs need
4.5:1 (1.4.3); UI component boundaries, focus rings and meaningful icons need 3:1 (1.4.11).
Result on 2026-10-24: **90 checks, 0 failures.** Lowest text pair 5.27:1 (light
`text-subtle` on `bg`); lowest non-text pair 3.05:1 (light input border on canvas).

| Pair (fg on bg) | Purpose | Min | Light | Dark |
|---|---|---|---|---|
| `text` on `surface` | Body text on card | 4.5:1 | 17.75:1 pass (#101828 / #ffffff) | 15.81:1 pass (#f2f4f7 / #151a24) |
| `text` on `bg` | Body text on canvas | 4.5:1 | 16.41:1 pass (#101828 / #f5f6f8) | 17.12:1 pass (#f2f4f7 / #0c111d) |
| `text-muted` on `surface` | Labels on card | 4.5:1 | 7.69:1 pass (#475467 / #ffffff) | 10.70:1 pass (#c6cbd4 / #151a24) |
| `text-muted` on `surface-2` | Table header text | 4.5:1 | 7.36:1 pass (#475467 / #f9fafb) | 9.90:1 pass (#c6cbd4 / #1b212d) |
| `text-muted` on `surface-hover` | Muted text on hovered row | 4.5:1 | 6.92:1 pass (#475467 / #f1f3f6) | 8.95:1 pass (#c6cbd4 / #222937) |
| `text-subtle` on `surface` | Captions on card | 4.5:1 | 5.70:1 pass (#5d6779 / #ffffff) | 6.85:1 pass (#9aa3b2 / #151a24) |
| `text-subtle` on `bg` | Captions on canvas | 4.5:1 | 5.27:1 pass (#5d6779 / #f5f6f8) | 7.41:1 pass (#9aa3b2 / #0c111d) |
| `text-subtle` on `surface-2` | Captions in sunken well | 4.5:1 | 5.46:1 pass (#5d6779 / #f9fafb) | 6.34:1 pass (#9aa3b2 / #1b212d) |
| `text` on `surface-selected` | Text on selected row | 4.5:1 | 15.66:1 pass (#101828 / #eef0fe) | 12.93:1 pass (#f2f4f7 / #23284a) |
| `accent-text` on `surface` | Links on card | 4.5:1 | 7.90:1 pass (#4338ca / #ffffff) | 8.12:1 pass (#a4abfa / #151a24) |
| `accent-text` on `accent-soft` | Accent text on tint | 4.5:1 | 6.97:1 pass (#4338ca / #eef0fe) | 6.64:1 pass (#a4abfa / #23284a) |
| `accent-fg` on `accent` | Primary button label | 4.5:1 | 6.29:1 pass (#ffffff / #4f46e5) | 6.85:1 pass (#0c111d / #8b93f8) |
| `accent-fg` on `accent-hover` | Primary button label (hover) | 4.5:1 | 7.90:1 pass (#ffffff / #4338ca) | 8.79:1 pass (#0c111d / #a4abfa) |
| `text-inverse` on `danger-solid` | Destructive button label | 4.5:1 | 5.75:1 pass (#ffffff / #c4271c) | 6.77:1 pass (#0c111d / #f97066) |
| `text-inverse` on `success-solid` | Success button label | 4.5:1 | 5.69:1 pass (#ffffff / #067647) | 9.31:1 pass (#0c111d / #47cd89) |
| `nav-fg` on `nav-bg` | Navigation item | 4.5:1 | 10.46:1 pass (#344054 / #ffffff) | 11.13:1 pass (#c6cbd4 / #11161f) |
| `nav-active-fg` on `nav-active-bg` | Navigation item (active) | 4.5:1 | 8.77:1 pass (#3730a3 / #eef0fe) | 9.08:1 pass (#c7cbfc / #23284a) |
| `success-fg` on `success-bg` | Success banner text | 4.5:1 | 5.40:1 pass (#067647 / #ecfdf3) | 10.16:1 pass (#6ce9a6 / #0b2a1c) |
| `warning-fg` on `warning-bg` | Warning banner text | 4.5:1 | 6.16:1 pass (#a43e05 / #fffaeb) | 8.68:1 pass (#fdb022 / #2e1f05) |
| `danger-fg` on `danger-bg` | Danger banner text | 4.5:1 | 6.05:1 pass (#b42318 / #fef3f2) | 8.72:1 pass (#fda29b / #33130f) |
| `info-fg` on `info-bg` | Info banner text | 4.5:1 | 5.57:1 pass (#175cd3 / #eff8ff) | 8.91:1 pass (#84caff / #0b2342) |
| `success-fg` on `surface` | Success text on card | 4.5:1 | 5.69:1 pass (#067647 / #ffffff) | 11.49:1 pass (#6ce9a6 / #151a24) |
| `warning-fg` on `surface` | Warning text on card | 4.5:1 | 6.42:1 pass (#a43e05 / #ffffff) | 9.47:1 pass (#fdb022 / #151a24) |
| `danger-fg` on `surface` | Danger text on card | 4.5:1 | 6.57:1 pass (#b42318 / #ffffff) | 8.98:1 pass (#fda29b / #151a24) |
| `info-fg` on `surface` | Info text on card | 4.5:1 | 5.99:1 pass (#175cd3 / #ffffff) | 9.85:1 pass (#84caff / #151a24) |
| `status-draft-fg` on `status-draft-bg` | Status chip: draft | 4.5:1 | 6.98:1 pass (#475467 / #f2f4f7) | 8.99:1 pass (#cecfd2 / #262c38) |
| `status-awaiting-fg` on `status-awaiting-bg` | Status chip: awaiting | 4.5:1 | 6.16:1 pass (#a43e05 / #fffaeb) | 8.68:1 pass (#fdb022 / #2e1f05) |
| `status-approved-fg` on `status-approved-bg` | Status chip: approved | 4.5:1 | 5.57:1 pass (#175cd3 / #eff8ff) | 8.91:1 pass (#84caff / #0b2342) |
| `status-posted-fg` on `status-posted-bg` | Status chip: posted | 4.5:1 | 6.97:1 pass (#4338ca / #eef0fe) | 7.65:1 pass (#b4b9fb / #23284a) |
| `status-partpaid-fg` on `status-partpaid-bg` | Status chip: partpaid | 4.5:1 | 5.89:1 pass (#0e6a83 / #ecfdff) | 10.03:1 pass (#67e3f9 / #082a33) |
| `status-paid-fg` on `status-paid-bg` | Status chip: paid | 4.5:1 | 5.40:1 pass (#067647 / #ecfdf3) | 10.16:1 pass (#6ce9a6 / #0b2a1c) |
| `status-overdue-fg` on `status-overdue-bg` | Status chip: overdue | 4.5:1 | 6.05:1 pass (#b42318 / #fef3f2) | 8.72:1 pass (#fda29b / #33130f) |
| `status-void-fg` on `status-void-bg` | Status chip: void | 4.5:1 | 10.46:1 pass (#344054 / #ffffff) | 11.19:1 pass (#cecfd2 / #151a24) |
| `status-reversed-fg` on `status-reversed-bg` | Status chip: reversed | 4.5:1 | 7.15:1 pass (#6431b8 / #f4f3ff) | 8.37:1 pass (#c8b6fd / #2a1d4d) |
| `status-locked-fg` on `status-locked-bg` | Status chip: locked | 4.5:1 | 10.46:1 pass (#ffffff / #344054) | 12.11:1 pass (#0c111d / #cecfd2) |
| `border-strong` on `surface` | Input border (1.4.11) | 3:1 | 3.30:1 pass (#858e9e / #ffffff) | 4.02:1 pass (#6f7a8e / #151a24) |
| `border-strong` on `bg` | Input border on canvas (1.4.11) | 3:1 | 3.05:1 pass (#858e9e / #f5f6f8) | 4.36:1 pass (#6f7a8e / #0c111d) |
| `focus` on `surface` | Focus ring on card (2.4.11/1.4.11) | 3:1 | 6.29:1 pass (#4f46e5 / #ffffff) | 8.12:1 pass (#a4abfa / #151a24) |
| `focus` on `bg` | Focus ring on canvas | 3:1 | 5.81:1 pass (#4f46e5 / #f5f6f8) | 8.79:1 pass (#a4abfa / #0c111d) |
| `status-void-border` on `surface` | Void chip dashed border | 3:1 | 3.30:1 pass (#858e9e / #ffffff) | 4.02:1 pass (#6f7a8e / #151a24) |
| `warning-solid` on `surface` | Warning icon/dot | 3:1 | 3.49:1 pass (#dc6803 / #ffffff) | 7.43:1 pass (#f79009 / #151a24) |
| `danger-solid` on `surface` | Danger icon/dot | 3:1 | 5.75:1 pass (#c4271c / #ffffff) | 6.25:1 pass (#f97066 / #151a24) |
| `success-solid` on `surface` | Success icon/dot | 3:1 | 5.69:1 pass (#067647 / #ffffff) | 8.60:1 pass (#47cd89 / #151a24) |
| `info-solid` on `surface` | Info icon/dot | 3:1 | 4.57:1 pass (#1570ef / #ffffff) | 7.53:1 pass (#53b1fd / #151a24) |
| `accent` on `surface` | Accent icon / selected checkbox | 3:1 | 6.29:1 pass (#4f46e5 / #ffffff) | 6.33:1 pass (#8b93f8 / #151a24) |

### Rendered-page contrast

`tools/screenshot-mockups.mjs` also measures every visible text node against its actual rendered
background on all 17 screenshots (light and dark). Lowest rendered text contrast: 4.55:1 (the
`N` shortcut hint on the primary button, white at 0.16 alpha over indigo); every other node
≥ 4.63:1; body text 16.41:1 light, 17.12:1 dark. Details: `screenshots/check-report.json`.

## Changing a token

1. Edit `tokens.css` (both light and dark blocks).
2. Run `node Docs/ui/tools/contrast.mjs` — must exit 0. Add a pair to the script if the new token
   is a new text/background combination.
3. Run `node Docs/ui/tools/screenshot-mockups.mjs` and look at the screenshots.
4. Log the change in the decision log (category `ui`).
