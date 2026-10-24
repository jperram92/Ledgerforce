# RQ-0080 — UI patterns and accessibility baseline for LedgerForce

- Status: resolved
- Opened / resolved: 2026-10-24 · By: claude · Task: sprint-0 (UI principles)
- Feeds: `Docs/ui/principles.md`, `Docs/ui/design-tokens.md`, `Docs/ui/tokens.css`, `Docs/ui/mockups/`

## Questions

1. Which contrast thresholds must tokens meet, and does "status chip" colour alone satisfy WCAG?
2. How should money be set in tables (alignment, numerals)?
3. How do established ERPs expose "what will this post?" before posting, and how do they handle void vs delete?
4. How many density modes, and what row heights?
5. What must the Salesforce-embedded component (UC-12) look like to "feel at home" in Lightning?

## Findings

### 1. Contrast and colour (WCAG 2.2 AA)
- **1.4.3 Contrast (Minimum):** text ≥ 4.5:1; large text (≥ 18pt, or ≥ 14pt bold) ≥ 3:1 ([WebAIM](https://webaim.org/articles/contrast/), [Stark](https://www.getstark.co/wcag-explained/perceivable/distinguishable/contrast-minimum/)).
- **1.4.11 Non-text Contrast:** UI component boundaries and states (input borders, focus rings, meaningful icons) ≥ 3:1 against adjacent colours ([W3C Understanding 1.4.11](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast)).
- **1.4.1 Use of Color (Level A):** colour may not be the only means of conveying information ([Queensland Government design system](https://www.designsystem.qld.gov.au/styles/colour/accessibility)).
- Conclusion: every status is a **word + colour** (+ optional icon); chip text ≥ 4.5:1 on chip fill; input borders and focus ring ≥ 3:1 on surface. Numbers recorded in `Docs/ui/design-tokens.md` §Contrast.

### 2. Money in tables
- Right-align numeric columns so magnitudes can be compared ([Alberta design system](https://design.alberta.ca/examples/display-numbers-in-a-table-so-they-can-be-scanned-easily)).
- Use tabular (fixed-width) figures — `font-variant-numeric: tabular-nums` / OpenType `tnum` — so digits line up ([Dash brand: tabular numerics](https://brand.dash.fi/foundations/data-viz), [webreference](https://webreference.com/css/properties/font-variant-numeric/)). Inter (the chosen face) supports `tnum`.
- Conclusion: amounts right-aligned, tabular, same number of decimals per column; negatives shown as `(1,234.00)` **and** a leading minus for screen readers (`aria-label="minus 1,234 dollars"`), never red alone.

### 3. Preview posting and void
- Business Central puts a **Preview Posting** action on every document and journal that can be posted, showing the G/L (and VAT) entries that posting would create ([Microsoft Learn — Preview Posting Results](https://learn.microsoft.com/en-us/dynamics365/business-central/ui-how-preview-post-results)). LedgerForce's preview mode (§3.9) is the same idea and becomes a side panel, open by default before posting.
- Xero allows delete only for Draft/Awaiting Approval; approved invoices are voided, keeping the record for audit ([SaaSant guide](https://www.saasant.com/blog/xero-void-vs-delete/), [Unleashed help](https://help-unleashed.theaccessgroup.com/en/articles/11582218-delete-or-void-incorrect-transactions-in-xero)). LedgerForce is stricter (design D2): posted documents have **no delete**; Void is labelled "Void (creates reversal journal)" and its confirmation shows the reversal preview.

### 4. Density
- Common tiers are ~40 / 48 / 56 px rows; condensed fits more but is harder to read ([Uxcel](https://app.uxcel.com/courses/ui-components-best-practices/tables-152/row-height-9127), [MUI Data Grid row height](https://v6.mui.com/x/react-data-grid/row-height/), [Syncfusion display density](https://blazor.syncfusion.com/documentation/datagrid/display-density)). Change only vertical padding and type size between modes; keep column widths fixed.
- Conclusion: **two** modes — Comfortable (44 px rows, default for owners) and Compact (32 px rows, offered to Accountant/Bookkeeper roles), a per-user setting.

### 5. Salesforce Lightning look
- Lightning base components ship SLDS styling; card bodies use `slds-card__body_inner` for padding; cards have title, icon, actions, body and footer ([Salesforce: Lightning Design System considerations](https://developer.salesforce.com/docs/atlas.en-us.lightning.meta/lightning/lightning_base_slds.htm), [Apex Hours: lightning-card](https://www.apexhours.com/exploring-lightning-card-in-lightning-web-component-lwc/)). From LWC API 61.0 SLDS modifier classes use `_` instead of `--`.
- Conclusion: the UC-12 component is built from `lightning-card`, `lightning-datatable`/`lightning-badge` and SLDS utilities only — **no LedgerForce tokens inside Salesforce** — so it inherits the org's theme. The mockup imitates SLDS visuals (white cards, 0.25rem radius, #747474-ish borders) for review purposes only.

## Decision
Adopt the conclusions above as the UI baseline (see decision-log entries proposed in the UI report).
